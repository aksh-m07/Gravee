import { GateTracker } from "./gate";
import { Governor } from "./governor";
import {
  describeAction, isComplete, sameMoney, progressSignature, toGateAction, updateGoal,
  type Action, type Goal, type Observation, type ReqStatus,
} from "./goal";
import { isRiskyAction } from "./gate";
import {
  DEFAULT_RECOVERY, recoveryKey, validateRecovery,
  type Check, type Evidence, type RecoveryAction, type RecoveryPolicy, type RecoveryState,
} from "./recovery";
import { buildBriefing, type Briefing, type Confusion, type Mandate } from "./escalation";
import { actionKey, detectMistakes, MISTAKES, type MistakeId, type TrailItem } from "./mistakes";

export type DecisionType = "ALLOW" | "BLOCK" | "RECOVER" | "ASK_HUMAN" | "STOP";

/** What Gemini returns, after zod validation in lib/assess.ts. */
export interface Assessment {
  assessment: "progressing" | "stalled" | "blocked" | "unsafe" | "uncertain";
  goal_progress: string;
  unsatisfied_requirements: string[];
  evidence: string[];
  proposed_decision: "allow" | "block" | "recover" | "ask_human" | "stop";
  recovery_action: RecoveryAction | null;
  confidence: "low" | "medium" | "high";
  requires_human: boolean;
  reason: string;
}

export interface AssessContext {
  goal: Goal;
  task: string;
  proposed: Action;
  history: { action: string; ok: boolean; progressed: boolean }[];
  obs: Observation;
  signals: string[];
  stall: number;
  recoveriesUsed: RecoveryAction[];
  failedRecoveries: string[];
  policy: RecoveryPolicy;
  /** Named agent mistakes spotted by rules this step. Only set in live mode. */
  mistakes?: { id: string; name: string; plain: string }[];
}
export type Assessor = (ctx: AssessContext) => Promise<{ assessment: Assessment; ms: number; cached: boolean }>;

export interface GuardDecision {
  type: DecisionType;
  reason: string;
  source: "policy" | "detector" | "gemini" | "fallback";
  signals: string[];
  recovery?: RecoveryAction;
  action?: Action; // concrete executor action for RECOVER
  then?: Action[]; // follow-up steps of a multi-step recovery, each re-checked by the executor
  briefing?: Briefing; // set on every ASK_HUMAN: what the guard would say on the call
  mistakes?: MistakeId[]; // named agent mistakes spotted this step (live mode only)
  assessment?: Assessment;
  gemini?: { ms: number; cached: boolean };
}

export interface GuardOptions {
  mode: "deterministic" | "gemini";
  task: string;
  stallLimit: number;
  stepBudget: number;
  maxConsecutiveBlocks: number;
  recovery: RecoveryPolicy;
  mandate?: Mandate;
  /** Watch for named agent mistakes (live mode). Off in the recorded evaluation so its numbers stay comparable. */
  mistakes?: boolean;
  /** Live mode: end the run once every requirement is verified, instead of letting the agent keep acting. Not used for buy tasks. */
  stopWhenDone?: boolean;
  /** Ablation switch: false ignores the learned screen-anomaly model, leaving only the rules. Default true. */
  learnedDetector?: boolean;
  tracker: GateTracker;
  governor: Governor;
  assess?: Assessor;
}

export const DEFAULT_GUARD = { stallLimit: 4, stepBudget: 30, maxConsecutiveBlocks: 2, recovery: DEFAULT_RECOVERY };

const ERROR_TEXT = /(could not|failed|error|unavailable)/i;

/**
 * The goal-aware guard. It decides before an action reaches the executor.
 * Cheap detectors run every step. Gemini is consulted only when a detector says the run looks stuck, and it can
 * only propose: every proposal is checked against the recovery allowlist and the hard policies below.
 */
export class GoalGuard {
  goal: Goal;
  private lastSig = "";
  private stall = 0;
  private blocks = 0;
  private history: AssessContext["history"] = [];
  private st: RecoveryState = { done: [], failed: [], lastClick: null };
  private pending: { sig: string; satisfied: number; overlay: boolean; route: string; r: RecoveryAction } | null = null;
  private trail: TrailItem[] = [];
  private route = "/";
  private allowed: string | null = null;
  stats = { assessments: 0, geminiMs: 0, recoveriesTried: 0, recoveriesVerified: 0 };

  constructor(private o: GuardOptions, goal: Goal) { this.goal = goal; }

  private suspicion(obs: Observation, signals: string[]): string[] {
    const why: string[] = [];
    if (signals.includes("visual_anomaly")) why.push("visual_anomaly");
    if (signals.includes("loop") || signals.includes("stuck")) why.push(signals.includes("loop") ? "loop" : "stuck");
    if (this.stall >= this.o.stallLimit) why.push("stalled");
    const blocked = this.goal.reqs.some((r) => r.status === "blocked");
    if (blocked && (this.stall >= 1 || ERROR_TEXT.test(obs.text))) why.push("requirement_blocked");
    if (obs.overlay && this.stall >= 1) why.push("overlay_unresolved");
    return why;
  }

  async review(action: Action, obs: Observation, step: number): Promise<GuardDecision> {
    this.goal = updateGoal(this.goal, obs);
    this.route = obs.route;
    const sig = progressSignature(this.goal) + "#" + obs.sheet.length;
    this.stall = sig === this.lastSig ? this.stall + 1 : 0;
    this.lastSig = sig;
    const reading = this.o.tracker.observe(obs.frame, toGateAction(action));
    const detector = reading.signals.filter((s) => s !== "risky_action" && (this.o.learnedDetector !== false || s !== "visual_anomaly")) as string[];

    // A recovery that was just executed is judged by what the page shows now.
    if (this.pending) this.verifyPending(obs);

    const seen = this.o.mistakes ? detectMistakes(this.trail, action, this.goal) : [];
    const tag = (...ids: MistakeId[]) => { if (this.o.mistakes) for (const i of ids) if (!seen.includes(i)) seen.push(i); };
    const done = (d: GuardDecision): GuardDecision => {
      this.blocks = d.type === "BLOCK" ? this.blocks + 1 : 0;
      return seen.length ? { ...d, mistakes: seen } : d;
    };

    // ---- hard policies: no model can override these ----
    if (step >= this.o.stepBudget) return done({ type: "STOP", reason: `step budget of ${this.o.stepBudget} reached without completing the task`, source: "policy", signals: detector });

    if (this.o.stopWhenDone && action.kind !== "finish" && isComplete(this.goal)) {
      tag("no_stop");
      return done({ type: "STOP", reason: "every requirement is satisfied and verified, so the run ends here instead of letting the agent keep acting", source: "policy", signals: detector });
    }

    if (action.kind === "finish") {
      if (isComplete(this.goal)) {
        // A done claim must also match what the guard saw: a price in the claim that differs from the observed price is not accepted.
        const said = action.claim.match(/\$\d{1,4}\.\d{2}/g) ?? [];
        const seenPrice = this.goal.price?.value;
        if (this.o.mistakes && seenPrice && said.some((a) => !sameMoney(a, seenPrice))) {
          tag("unsupported_claim");
          return done({ type: "BLOCK", reason: `the claim mentions ${said.find((a) => !sameMoney(a, seenPrice))} but the price the guard observed is ${seenPrice}`, source: "policy", signals: detector });
        }
        return done({ type: "ALLOW", reason: "all requirements are satisfied and verified", source: "policy", signals: detector });
      }
      tag("premature_claim");
      const open = this.goal.reqs.filter((r) => r.status !== "satisfied").map((r) => r.id).join(", ");
      const d = { type: this.blocks + 1 >= this.o.maxConsecutiveBlocks ? "STOP" : "BLOCK", reason: `agent claims it is done but these requirements are not satisfied: ${open}`, source: "policy", signals: detector } as GuardDecision;
      return done(d);
    }

    if (isRiskyAction(toGateAction(action))) {
      // The boss said yes to exactly this action once. Nothing else is unlocked.
      if (this.allowed === actionKey(action)) { this.allowed = null; return done({ type: "ALLOW", reason: "approved by the boss for this one action", source: "policy", signals: detector }); }
      tag("constraint_breach");
      const reason = `"${describeAction(action)}" is irreversible and this task does not ask for it`;
      if (this.blocks + 1 >= this.o.maxConsecutiveBlocks) return done(this.escalate("irreversible", reason, "policy", detector, undefined, action));
      return done({ type: "BLOCK", reason, source: "policy", signals: detector });
    }

    if (action.kind === "click") this.st.lastClick = action.label;

    // ---- cheap detectors decide whether anything needs a closer look ----
    const why = this.suspicion(obs, detector);
    for (const m of seen) if (m === "oscillation" || m === "blind_retry" || m === "phantom_target" || (this.stall >= 1 && (m === "forgot_findings" || m === "off_task"))) why.push(m);
    if (!why.length) return done({ type: "ALLOW", reason: "progressing or too early to tell", source: "detector", signals: detector });

    // An unusual screen on its own is not evidence of failure. Watch it, and act once the task stalls or another signal agrees.
    if (why.length === 1 && why[0] === "visual_anomaly" && this.stall < this.o.stallLimit - 1) return done({ type: "ALLOW", reason: "unusual screen, but the task has not stalled yet; watching", source: "detector", signals: why });

    const fallback = (note: string, c: Confusion = "no_safe_action"): GuardDecision => this.deterministic(obs, why, note, c);

    if (this.o.mode === "deterministic" || !this.o.assess) return done(fallback("no vision model in this mode"));

    const can = this.o.governor.canSpend();
    if (!can.ok && can.why === "halted") return done({ type: "STOP", reason: this.o.governor.haltReason ?? "the guard halted itself", source: "policy", signals: why });
    if (!can.ok) return done(fallback(`vision budget unavailable (${can.why})`, "model_unavailable"));
    this.o.governor.spend();
    try {
      const r = await this.o.assess({
        goal: this.goal, task: this.o.task, proposed: action, history: this.history.slice(-8), obs, signals: why, stall: this.stall,
        recoveriesUsed: this.st.done, failedRecoveries: this.st.failed, policy: this.o.recovery,
        ...(seen.length ? { mistakes: seen.map((id) => ({ id, ...MISTAKES[id] })) } : {}),
      });
      this.o.governor.judgeSucceeded();
      this.stats.assessments++; this.stats.geminiMs += r.ms;
      return done(this.fromAssessment(r.assessment, obs, why, { ms: r.ms, cached: r.cached }, fallback));
    } catch (e) {
      const halted = this.o.governor.judgeFailed() === "halted";
      const d = fallback(`vision check failed: ${String((e as Error).message ?? e).slice(0, 80)}`, "model_unavailable");
      return done(halted ? { ...d, type: "STOP", reason: this.o.governor.haltReason ?? d.reason } : d);
    }
  }

  /** Turn a validated Gemini assessment into a decision. The guard keeps the final say. */
  private fromAssessment(a: Assessment, obs: Observation, why: string[], gemini: { ms: number; cached: boolean }, fallback: (n: string, c?: Confusion) => GuardDecision): GuardDecision {
    const base = { signals: why, assessment: a, gemini, source: "gemini" as const };
    switch (a.proposed_decision) {
      case "recover": {
        if (!a.recovery_action) return { ...fallback("Gemini chose recover but gave no action"), assessment: a, gemini };
        const v = validateRecovery(a.recovery_action, obs, this.st, this.o.recovery, this.evidence());
        if (!v.ok) return { ...fallback(`Gemini's recovery was refused: ${v.why}`), assessment: a, gemini };
        return { ...this.recover(a.recovery_action, v, obs, a.reason, "gemini", why), assessment: a, gemini };
      }
      case "allow":
        // A stall past twice the limit cannot be waved through by the model.
        if (this.stall >= this.o.stallLimit * 2 || a.assessment === "uncertain") return { ...this.escalate("low_confidence", "the detectors say the run is stuck and the model could not clear it", "gemini", why), assessment: a, gemini };
        return { type: "ALLOW", reason: a.reason, ...base };
      case "block": return { type: "BLOCK", reason: a.reason, ...base };
      case "stop": return { type: "STOP", reason: a.reason, ...base };
      case "ask_human": return { ...this.escalate(a.confidence === "low" ? "low_confidence" : "no_safe_action", a.reason, "gemini", why), assessment: a, gemini };
    }
  }

  /** Values the guard itself observed. The only text a recovery may type. */
  evidence(): Evidence {
    const rec = this.goal.reqs.find((x) => x.id === "record");
    return { product: this.goal.product, price: this.goal.price?.value ?? null, recordOpen: !!rec && (rec.status === "not_started" || rec.status === "in_progress") };
  }

  /** Every call to the boss goes through here, so every call carries a reason and a briefing. */
  private escalate(c: Confusion, reason: string, source: GuardDecision["source"], signals: string[], proposal?: RecoveryAction, action?: Action): GuardDecision {
    const briefing = buildBriefing({ goal: this.goal, confusion: c, reason, history: this.history.slice(-8), recoveriesUsed: this.st.done, proposal, action: action ? describeAction(action) : undefined });
    return { type: "ASK_HUMAN", reason, source, signals, briefing };
  }

  /** The one place a recovery is committed. Under an ask-first mandate it is put to the boss instead and nothing is recorded as tried. */
  private recover(r: RecoveryAction, v: Extract<Check, { ok: true }>, obs: Observation, reason: string, source: GuardDecision["source"], signals: string[]): GuardDecision {
    if (this.o.mandate?.autonomy === "ask_first") return this.escalate("ask_first", reason, source, signals, r);
    this.st.done.push(r);
    this.pending = { sig: progressSignature(this.goal) + "#" + obs.sheet.length, satisfied: this.goal.reqs.filter((x) => x.status === "satisfied").length, overlay: !!obs.overlay, route: obs.route, r };
    this.stats.recoveriesTried++;
    return { type: "RECOVER", reason, recovery: r, action: v.action, then: v.then, source, signals };
  }

  /**
   * Rule-based fallback. The boss's stand-in for the cases the rules cover: dismiss a known overlay, retry a failed save once,
   * finish the sheet step from a price it already found. Otherwise it calls the boss. It never guesses.
   */
  private deterministic(obs: Observation, why: string[], note: string, c: Confusion): GuardDecision {
    const try_ = (r: RecoveryAction, reason: string): GuardDecision | null => {
      const v = validateRecovery(r, obs, this.st, this.o.recovery, this.evidence());
      return v.ok ? this.recover(r, v, obs, reason, "fallback", why) : null;
    };
    if (obs.overlay) {
      const label = obs.overlay.buttons.find((b) => this.o.recovery.dismissLexicon.includes(b.toLowerCase()));
      const d = label && try_({ kind: "dismiss_overlay", label }, `dismissing the "${label}" overlay (${note})`);
      if (d) return d;
    }
    const rec = this.goal.reqs.find((x) => x.id === "record");
    if (rec?.status === "blocked" && /save failed/i.test(rec.evidence ?? "")) {
      const d = try_({ kind: "retry_last" }, `retrying the failed save once (${note})`);
      if (d) return d;
    }
    if (this.stall >= this.o.stallLimit - 1 || why.some((w) => w === "forgot_findings" || w === "off_task" || w === "oscillation")) {
      const d = try_({ kind: "record_from_evidence" }, `the agent has the price but is not recording it, so I am writing it into the sheet myself (${note})`);
      if (d) return d;
    }
    return this.escalate(c, `looks stuck (${why.join(", ")}) and no safe rule-based recovery applies (${note})`, "fallback", why);
  }

  /** Call after the runner executed a RECOVER action, with the observation taken afterwards. */
  private verifyPending(obs: Observation) {
    const p = this.pending!; this.pending = null;
    // Helped means a requirement became satisfied or the overlay went away. Moving into a "blocked" state is not help.
    const helped = this.goal.reqs.filter((x) => x.status === "satisfied").length > p.satisfied || (p.overlay && !obs.overlay);
    if (helped) { this.stats.recoveriesVerified++; this.stall = 0; }
    else this.st.failed.push(recoveryKey(p.r));
    this.lastVerification = { recovery: p.r, helped };
  }
  lastVerification: { recovery: RecoveryAction; helped: boolean } | null = null;

  /** The boss approved exactly this action, once. Everything else stays locked. */
  allowOnce(a: Action) { this.allowed = actionKey(a); this.blocks = 0; }
  /** The boss gave guidance. Reset the counters so the guard does not call again at once about the same stall. */
  bossSaid() { this.stall = 0; this.blocks = 0; }

  /** Record what the executor did, so the next assessment can see recent outcomes. */
  record(action: Action, ok: boolean, progressed: boolean) { this.trail.push({ key: actionKey(action), route: this.route, ok }); this.history.push({ action: describeAction(action), ok, progressed }); }

  statuses(): ReqStatus[] { return this.goal.reqs.map((r) => r.status); }
}

/** Baseline: stop when the same action repeats three times in a row or the step budget runs out. Knows nothing about the task. */
export class RepeatActionGuard {
  private last = ""; private run = 0;
  constructor(private stepBudget = 30) {}
  review(action: Action, step: number): GuardDecision {
    const key = JSON.stringify(action);
    this.run = key === this.last ? this.run + 1 : 1; this.last = key;
    if (this.run >= 3) return { type: "STOP", reason: "same action repeated 3 times", source: "policy", signals: [] };
    if (step >= this.stepBudget) return { type: "STOP", reason: "step budget reached", source: "policy", signals: [] };
    return { type: "ALLOW", reason: "no repetition", source: "detector", signals: [] };
  }
}
