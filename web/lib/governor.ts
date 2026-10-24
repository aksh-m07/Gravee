import type { Signal } from "./types";

export interface GovernorConfig {
  /** Hard cap on vision-judge calls for one run ("power"). */
  maxCalls: number;
  /** Rolling one minute cap, so a burst cannot burn the whole budget at once. */
  maxCallsPerMinute: number;
  /** Consecutive judge failures before the guard stops trusting itself and halts. */
  maxConsecutiveErrors: number;
  /** An identical alert inside this window is suppressed. */
  alertCooldownMs: number;
  /** After this many suppressed repeats the guard escalates once ("it keeps happening"). */
  repeatEscalation: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  maxCalls: 60, maxCallsPerMinute: 12, maxConsecutiveErrors: 3, alertCooldownMs: 60_000, repeatEscalation: 3,
};

export type GuardState = "watching" | "throttled" | "halted";
export type SpendResult = { ok: true } | { ok: false; why: "budget" | "rate" | "halted" };

export class Governor {
  state: GuardState = "watching";
  haltReason: string | null = null;
  calls = 0;
  private stamps: number[] = [];
  private errors = 0;
  private alerts = new Map<string, { last: number; suppressed: number }>();

  constructor(public cfg: GovernorConfig = DEFAULT_GOVERNOR, private now: () => number = Date.now) {}

  get remaining() { return Math.max(0, this.cfg.maxCalls - this.calls); }

  /** Ask to spend one judge call. Does not spend; call spend() when the request is actually sent. */
  canSpend(): SpendResult {
    if (this.state === "halted") return { ok: false, why: "halted" };
    if (this.calls >= this.cfg.maxCalls) return { ok: false, why: "budget" };
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.cfg.maxCallsPerMinute) { this.state = "throttled"; return { ok: false, why: "rate" }; }
    if (this.state === "throttled") this.state = "watching";
    return { ok: true };
  }

  spend() { this.calls++; this.stamps.push(this.now()); }

  judgeSucceeded() { this.errors = 0; }

  judgeFailed(): "ok" | "halted" {
    this.errors++;
    if (this.errors >= this.cfg.maxConsecutiveErrors) { this.halt(`The vision check failed ${this.errors} times in a row.`); return "halted"; }
    return "ok";
  }

  halt(reason: string) { this.state = "halted"; this.haltReason = reason; }

  /**
   * Should this alert be spoken? The first one always is. Identical alerts inside the cooldown are suppressed,
   * except one escalation after `repeatEscalation` repeats.
   */
  shouldAnnounce(key: string): "speak" | "suppress" | "escalate" {
    const t = this.now();
    const a = this.alerts.get(key);
    if (!a || t - a.last >= this.cfg.alertCooldownMs) { this.alerts.set(key, { last: t, suppressed: 0 }); return "speak"; }
    a.suppressed++;
    if (a.suppressed === this.cfg.repeatEscalation) return "escalate";
    return "suppress";
  }
}

// ---- attention scheduler: who gets the next vision check when several agents ask at once ----

export interface JudgeRequest { agent: string; signals: Signal[]; score: number; threshold: number }

const SIGNAL_WEIGHT: Record<Signal, number> = { risky_action: 3, visual_anomaly: 2, loop: 1, stuck: 1 };

/** Priority = strongest signal weight plus how far the visual score is past the alarm threshold. */
export function priority(r: JudgeRequest): number {
  const w = r.signals.length ? Math.max(...r.signals.map((s) => SIGNAL_WEIGHT[s])) : 0.5; // 0.5 = scheduled audit
  const over = r.threshold > 0 ? Math.max(0, Math.min(2, (r.score - r.threshold) / r.threshold)) : 0;
  return w + over * 0.5;
}

/** Pick which requests get a vision check this tick. Stable for ties (earlier request first). */
export function schedule(requests: JudgeRequest[], slots: number): JudgeRequest[] {
  return requests
    .map((r, i) => ({ r, i, p: priority(r) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .slice(0, Math.max(0, slots))
    .map((x) => x.r);
}
