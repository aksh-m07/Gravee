import { describe, expect, it } from "vitest";
import { Governor, schedule, priority, type GovernorConfig } from "../lib/governor";
import type { Signal } from "../lib/types";

const cfg: GovernorConfig = { maxCalls: 5, maxCallsPerMinute: 3, maxConsecutiveErrors: 2, alertCooldownMs: 60_000, repeatEscalation: 3 };
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

describe("Governor budget", () => {
  it("allows spending until the per-run cap, then refuses", () => {
    const c = clock(); const g = new Governor({ ...cfg, maxCallsPerMinute: 99 }, c.now);
    for (let i = 0; i < 5; i++) { expect(g.canSpend().ok).toBe(true); g.spend(); c.advance(70_000); }
    expect(g.canSpend()).toEqual({ ok: false, why: "budget" });
    expect(g.remaining).toBe(0);
  });
  it("rate limits within a minute and recovers after it", () => {
    const c = clock(); const g = new Governor(cfg, c.now);
    for (let i = 0; i < 3; i++) { g.spend(); c.advance(1000); }
    expect(g.canSpend()).toEqual({ ok: false, why: "rate" });
    expect(g.state).toBe("throttled");
    c.advance(61_000);
    expect(g.canSpend().ok).toBe(true);
    expect(g.state).toBe("watching");
  });
});

describe("Governor circuit breaker", () => {
  it("halts after consecutive judge failures and refuses all further spending", () => {
    const g = new Governor(cfg, clock().now);
    expect(g.judgeFailed()).toBe("ok");
    expect(g.judgeFailed()).toBe("halted");
    expect(g.state).toBe("halted");
    expect(g.haltReason).toMatch(/failed 2 times/);
    expect(g.canSpend()).toEqual({ ok: false, why: "halted" });
  });
  it("a success resets the failure count", () => {
    const g = new Governor(cfg, clock().now);
    g.judgeFailed(); g.judgeSucceeded();
    expect(g.judgeFailed()).toBe("ok");
    expect(g.state).toBe("watching");
  });
});

describe("Governor alert suppression", () => {
  it("speaks once, suppresses repeats, escalates once, then stays quiet", () => {
    const c = clock(); const g = new Governor(cfg, c.now);
    expect(g.shouldAnnounce("cam3:loop")).toBe("speak");
    const seen = [1, 2, 3, 4, 5].map(() => { c.advance(5000); return g.shouldAnnounce("cam3:loop"); });
    expect(seen).toEqual(["suppress", "suppress", "escalate", "suppress", "suppress"]);
  });
  it("speaks again after the cooldown and keys are independent", () => {
    const c = clock(); const g = new Governor(cfg, c.now);
    g.shouldAnnounce("a"); expect(g.shouldAnnounce("b")).toBe("speak");
    c.advance(61_000); expect(g.shouldAnnounce("a")).toBe("speak");
  });
});

describe("attention scheduler", () => {
  const req = (agent: string, signals: Signal[], score = 0) => ({ agent, signals, score, threshold: 10 });
  it("ranks risky actions above visual anomalies above no-progress above audits", () => {
    const order = schedule([req("audit", []), req("stuck", ["stuck"]), req("anom", ["visual_anomaly"], 15), req("risky", ["risky_action"])], 4).map((r) => r.agent);
    expect(order).toEqual(["risky", "anom", "stuck", "audit"]);
  });
  it("only grants as many slots as the budget allows and is stable on ties", () => {
    const out = schedule([req("a", ["risky_action"]), req("b", ["risky_action"]), req("c", ["risky_action"])], 2).map((r) => r.agent);
    expect(out).toEqual(["a", "b"]);
    expect(schedule([req("a", ["risky_action"])], 0)).toEqual([]);
  });
  it("a bigger visual overshoot raises priority", () => {
    expect(priority(req("x", ["visual_anomaly"], 30))).toBeGreaterThan(priority(req("x", ["visual_anomaly"], 11)));
  });
});
