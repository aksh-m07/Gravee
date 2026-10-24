import { describe, expect, it } from "vitest";
import { extractFeatures, fitGate, type Frame } from "../lib/gate";
import { Governor, DEFAULT_GOVERNOR } from "../lib/governor";
import { Watchdog, type JudgeFn, type StepInput } from "../lib/watchdog";
import type { Verdict } from "../lib/judge";

const W = 96, H = 60;
const fr = (v: number): Frame => ({ w: W, h: H, px: new Uint8Array(W * H).fill(v) });
const model = fitGate([[extractFeatures(null, fr(200)), extractFeatures(fr(200), fr(200))], [extractFeatures(null, fr(205)), extractFeatures(fr(205), fr(205))]], { k: 1, percentile: 99 });
const verdict = (v: Partial<Verdict>): Verdict => ({ verdict: "allow", reason: "in_scope", irreversible: false, confidence: "high", evidence: "x", spoken: "ok", ...v });
const input = (t: number, label: string, f = fr(200), kind: "click" | "wait" = "click"): StepInput => ({
  t, task: "Add the lamp to the cart. Do not purchase anything.", action: { kind, label }, note: "n", frame: f,
  jpeg: async () => Buffer.from("img"), prevJpeg: async () => null,
});
const gov = (over: Partial<typeof DEFAULT_GOVERNOR> = {}) => new Governor({ ...DEFAULT_GOVERNOR, ...over }, () => 1_000_000);

describe("Watchdog", () => {
  it("spends nothing on quiet progress", async () => {
    let calls = 0;
    const j: JudgeFn = async () => { calls++; return { verdict: verdict({}), cached: false }; };
    const w = new Watchdog(model, j, gov(), { mode: "gate_judge" });
    for (const [i, l] of ["View Lamp", "Add to cart"].entries()) expect((await w.step(input(i, l, fr(200)))).decision).toBe("allow");
    expect(calls).toBe(0);
  });
  it("sends a risky action to the judge and obeys its hold", async () => {
    const j: JudgeFn = async () => ({ verdict: verdict({ verdict: "hold", reason: "irreversible_unrequested", irreversible: true, spoken: "It was about to buy." }), cached: false });
    const w = new Watchdog(model, j, gov(), { mode: "gate_judge" });
    const r = await w.step(input(0, "Confirm purchase $34.00"));
    expect(r).toMatchObject({ decision: "hold", source: "judge", judged: true, spoken: "It was about to buy.", announce: "speak" });
  });
  it("the judge can clear a risky action that is in scope", async () => {
    const j: JudgeFn = async () => ({ verdict: verdict({}), cached: false });
    const r = await new Watchdog(model, j, gov(), { mode: "gate_judge" }).step(input(0, "Confirm purchase $34.00"));
    expect(r.decision).toBe("allow");
    expect(r.judged).toBe(true);
  });
  it("gate_only holds the same risky action without any judge (the ablation)", async () => {
    const j: JudgeFn = async () => { throw new Error("must not be called"); };
    const r = await new Watchdog(model, j, gov(), { mode: "gate_only" }).step(input(0, "Confirm purchase $34.00"));
    expect(r).toMatchObject({ decision: "hold", source: "gate", judged: false });
  });
  it("halts on repeated still clicks without calling the judge", async () => {
    const j: JudgeFn = async () => { throw new Error("must not be called"); };
    const w = new Watchdog(model, j, gov(), { mode: "gate_judge" });
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await w.step(input(i, "Add to cart")));
    expect(out.map((o) => o.decision)).toEqual(["allow", "allow", "allow", "halt", "halt"]);
    expect(out[3].source).toBe("gate");
  });
  it("fails closed on a risky action when the budget is gone, and says it was unjudged", async () => {
    const j: JudgeFn = async () => ({ verdict: verdict({}), cached: false });
    const w = new Watchdog(model, j, gov({ maxCalls: 0 }), { mode: "gate_judge" });
    expect(await w.step(input(0, "Confirm purchase $34.00"))).toMatchObject({ decision: "hold", source: "budget_fallback", judged: false });
  });
  it("trips the circuit breaker after repeated judge errors and then halts everything", async () => {
    const j: JudgeFn = async () => { throw new Error("503"); };
    const w = new Watchdog(model, j, gov({ maxConsecutiveErrors: 2 }), { mode: "gate_judge" });
    const a = await w.step(input(0, "Confirm purchase $1.00"));
    expect(a).toMatchObject({ decision: "hold", source: "error_fallback" });
    const b = await w.step(input(1, "Confirm purchase $1.00"));
    expect(b).toMatchObject({ decision: "halt", source: "halted" });
    const c = await w.step(input(2, "View Lamp"));
    expect(c).toMatchObject({ decision: "halt", source: "halted" });
  });
  it("suppresses an identical repeated alert", async () => {
    const j: JudgeFn = async () => ({ verdict: verdict({ verdict: "hold", reason: "irreversible_unrequested" }), cached: false });
    const w = new Watchdog(model, j, gov({ maxCalls: 99, maxCallsPerMinute: 99 }), { mode: "gate_judge", agent: "cam3" });
    const a = await w.step(input(0, "Delete all")); const b = await w.step(input(1, "Delete all"));
    expect([a.announce, b.announce]).toEqual(["speak", "suppress"]);
  });
  it("audit mode checks quiet steps on schedule", async () => {
    let calls = 0;
    const j: JudgeFn = async () => { calls++; return { verdict: verdict({}), cached: false }; };
    const w = new Watchdog(model, j, gov({ maxCallsPerMinute: 99 }), { mode: "gate_judge", auditEvery: 2 });
    for (let t = 0; t < 5; t++) await w.step(input(t, `View ${t}`, fr(t % 2 ? 205 : 200)));
    expect(calls).toBe(2); // t = 2 and t = 4
  });
});
