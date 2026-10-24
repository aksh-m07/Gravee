import { GateTracker, type Frame, type GateModel } from "./gate";
import { Governor } from "./governor";
import type { Verdict } from "./judge";
import type { Decision, ProposedAction, Signal } from "./types";

export type Mode = "gate_only" | "gate_judge" | "judge_always";

export interface StepInput {
  t: number;
  task: string;
  action: ProposedAction;
  note: string;
  frame: Frame;
  /** Images for the judge, only needed when the judge may be called. */
  jpeg: () => Promise<Buffer>;
  prevJpeg: () => Promise<Buffer | null>;
}

export interface JudgeCall {
  task: string; action: ProposedAction; note: string; history: string[]; signals: Signal[]; rules: string[];
  previous: Buffer | null; current: Buffer;
}
export type JudgeFn = (c: JudgeCall) => Promise<{ verdict: Verdict; cached: boolean }>;

export interface StepResult {
  t: number;
  decision: Decision;
  source: "none" | "gate" | "judge" | "budget_fallback" | "error_fallback" | "halted";
  signals: Signal[];
  score: number;
  judged: boolean;
  cached: boolean;
  verdict: Verdict | null;
  spoken: string | null;
  announce: "speak" | "suppress" | "escalate" | null;
}

export interface WatchdogOptions {
  mode: Mode;
  /** Run the judge on every Nth step even when no detector fired (0 = off). Catches drift onto familiar looking pages. */
  auditEvery?: number;
  rules?: () => string[];
  agent?: string;
}

export class Watchdog {
  private tracker: GateTracker;
  private history: string[] = [];
  constructor(model: GateModel, private judge: JudgeFn, public governor: Governor, private opts: WatchdogOptions) {
    this.tracker = new GateTracker(model);
  }

  async step(i: StepInput): Promise<StepResult> {
    const reading = this.tracker.observe(i.frame, i.action);
    const signals = reading.signals;
    const base = { t: i.t, signals, score: reading.score, judged: false, cached: false, verdict: null as Verdict | null };
    const finish = (r: Pick<StepResult, "decision" | "source" | "spoken"> & Partial<StepResult>): StepResult => {
      const out: StepResult = { ...base, announce: null, ...r } as StepResult;
      if (out.decision !== "allow") {
        const key = `${this.opts.agent ?? "agent"}:${out.decision}:${out.verdict?.reason ?? signals.join("+")}`;
        out.announce = this.governor.shouldAnnounce(key);
      }
      this.history.push(`${i.action.label}`);
      if (this.history.length > 5) this.history.shift();
      return out;
    };

    if (this.governor.state === "halted")
      return finish({ decision: "halt", source: "halted", spoken: this.governor.haltReason });

    // Mode: gate only. Any detector signal stops the step. This is the baseline without a vision model.
    if (this.opts.mode === "gate_only") {
      if (signals.includes("stuck") || signals.includes("loop"))
        return finish({ decision: "halt", source: "gate", spoken: "The agent is making no visible progress." });
      if (signals.length) return finish({ decision: "hold", source: "gate", spoken: "Something unusual or risky is about to happen." });
      return finish({ decision: "allow", source: "none", spoken: null });
    }

    const noProgress = signals.includes("stuck") || signals.includes("loop");
    if (this.opts.mode === "gate_judge" && noProgress)
      return finish({ decision: "halt", source: "gate", spoken: signals.includes("stuck") ? "The agent has been waiting with nothing changing on screen." : "The agent keeps repeating the same action and nothing is changing." });

    const audit = !!this.opts.auditEvery && i.t > 0 && i.t % this.opts.auditEvery === 0;
    const needsJudge = this.opts.mode === "judge_always" || signals.includes("visual_anomaly") || signals.includes("risky_action") || audit;
    if (!needsJudge) return finish({ decision: "allow", source: "none", spoken: null });

    const risky = signals.includes("risky_action");
    const can = this.governor.canSpend();
    if (!can.ok) {
      if (can.why === "halted") return finish({ decision: "halt", source: "halted", spoken: this.governor.haltReason });
      // Out of power: fail closed on risky actions, otherwise let it through. Always flagged as unjudged.
      return finish(risky
        ? { decision: "hold", source: "budget_fallback", spoken: "I am out of vision checks and this action looks risky, so I am holding it." }
        : { decision: "allow", source: "budget_fallback", spoken: null });
    }
    this.governor.spend();
    try {
      const r = await this.judge({
        task: i.task, action: i.action, note: i.note, history: [...this.history], signals, rules: this.opts.rules?.() ?? [],
        previous: await i.prevJpeg(), current: await i.jpeg(),
      });
      this.governor.judgeSucceeded();
      return finish({ decision: r.verdict.verdict, source: "judge", judged: true, cached: r.cached, verdict: r.verdict, spoken: r.verdict.verdict === "allow" ? null : r.verdict.spoken });
    } catch {
      if (this.governor.judgeFailed() === "halted")
        return finish({ decision: "halt", source: "halted", spoken: this.governor.haltReason });
      return finish(risky
        ? { decision: "hold", source: "error_fallback", spoken: "My vision check failed and this action looks risky, so I am holding it." }
        : { decision: "allow", source: "error_fallback", spoken: null });
    }
  }
}
