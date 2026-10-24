import { describe, expect, it } from "vitest";
import { extractFeatures, fitGate, GateTracker, type Frame } from "../lib/gate";
import { Governor, DEFAULT_GOVERNOR } from "../lib/governor";
import { GoalGuard, DEFAULT_GUARD, RepeatActionGuard, type Assessment, type Assessor } from "../lib/guard";
import { newGoal, type Action, type Observation } from "../lib/goal";
import { validateRecovery, DEFAULT_RECOVERY } from "../lib/recovery";

const P = "Black Desk Lamp";
const TASK = `Find the price of the ${P} and record it in the PriceLog sheet. Do not buy anything.`;
const frame = (v = 200): Frame => ({ w: 96, h: 60, px: new Uint8Array(96 * 60).fill(v) });
const model = fitGate([[extractFeatures(null, frame()), extractFeatures(frame(), frame())], [extractFeatures(null, frame(205)), extractFeatures(frame(205), frame(205))]], { k: 1, percentile: 99 });
const obs = (o: Partial<Observation> = {}): Observation => ({ route: "/product/lamp", text: `${P} Sign in to see prices Prices are available to members only.`, buttons: ["Sign in", "Add to cart"], nav: [], overlay: null, sheet: [], frame: frame(), jpeg: null, ...o });
const assessment = (o: Partial<Assessment>): Assessment => ({ assessment: "blocked", goal_progress: "price hidden", unsatisfied_requirements: ["price"], evidence: ["Sign in wall"], proposed_decision: "recover", recovery_action: { kind: "navigate", route: "/compare" }, confidence: "high", requires_human: false, reason: "wall cannot be passed; use the listing", ...o });
const click = (label: string): Action => ({ kind: "click", label });

function guard(mode: "deterministic" | "gemini", assess?: Assessor, gov = new Governor({ ...DEFAULT_GOVERNOR, maxCalls: 50, maxCallsPerMinute: 50 }, () => 0)) {
  return { gov, g: new GoalGuard({ ...DEFAULT_GUARD, mode, task: TASK, tracker: new GateTracker(model), governor: gov, assess }, newGoal(P)) };
}
const ok = (a: Assessment): Assessor => async () => ({ assessment: a, ms: 5, cached: false });

describe("hard policies", () => {
  it("allows quiet progress without any model call", async () => {
    let called = 0;
    const { g } = guard("gemini", async () => { called++; throw new Error("no"); });
    const d = await g.review(click("View Black Desk Lamp"), obs({ route: "/shop", text: "All products", buttons: [] }), 0);
    expect(d.type).toBe("ALLOW");
    expect(called).toBe(0);
  });
  it("blocks a premature completion claim, then stops when the agent insists", async () => {
    const { g } = guard("deterministic");
    const claim: Action = { kind: "finish", claim: "done" };
    expect((await g.review(claim, obs(), 1)).type).toBe("BLOCK");
    expect((await g.review(claim, obs(), 2)).type).toBe("STOP");
  });
  it("blocks an irreversible action the task did not ask for, then escalates to a human", async () => {
    const { g } = guard("gemini", async () => { throw new Error("must not be consulted for a hard policy"); });
    const buy = click("Confirm purchase $34.00");
    expect(await g.review(buy, obs({ route: "/checkout", text: "Checkout" }), 3)).toMatchObject({ type: "BLOCK", source: "policy" });
    expect((await g.review(buy, obs({ route: "/checkout", text: "Checkout" }), 4)).type).toBe("ASK_HUMAN");
  });
  it("stops at the step budget", async () => {
    const { g } = guard("deterministic");
    expect((await g.review(click("Add to cart"), obs(), DEFAULT_GUARD.stepBudget)).type).toBe("STOP");
  });
});

describe("deterministic guard (no vision model)", () => {
  const overlay = (label: string) => obs({ route: "/shop", text: "Free shipping", buttons: [label], overlay: { title: "Promo", text: "Promo", buttons: [label] } });
  it("dismisses an overlay it knows once the agent has failed to", async () => {
    const { g } = guard("deterministic");
    await g.review(click("Close"), overlay("Close"), 0);
    const d = await g.review(click("Close"), overlay("Close"), 1);
    expect(d).toMatchObject({ type: "RECOVER", recovery: { kind: "dismiss_overlay", label: "Close" } });
  });
  it("asks a human about an overlay button it does not recognise", async () => {
    const { g } = guard("deterministic");
    await g.review(click("Close"), overlay("Got it"), 0);
    expect((await g.review(click("Close"), overlay("Got it"), 1)).type).toBe("ASK_HUMAN");
  });
  it("retries a failed save once", async () => {
    const { g } = guard("deterministic");
    const compare = obs({ route: "/compare", text: `${P} $34.00`, buttons: [] });
    await g.review(click("Save row"), compare, 0); // learns the price
    const failed = obs({ route: "/sheet", text: "PriceLog Could not save (network error). Try again.", buttons: ["Save row"] });
    const d = await g.review({ kind: "goto", route: "/shop" }, failed, 1);
    expect(d).toMatchObject({ type: "RECOVER", recovery: { kind: "retry_last" } });
  });
});

describe("Gemini assisted guard", () => {
  // One review shows the wall (requirement becomes blocked); the next one is the first stalled review, which is where the guard looks closer.
  const stuck = async (g: GoalGuard) => { await g.review(click("Sign in"), obs(), 0); };
  it("accepts a valid recovery proposal and reports it as RECOVER with the concrete action", async () => {
    const { g } = guard("gemini", ok(assessment({})));
    await stuck(g);
    const d = await g.review({ kind: "reload" }, obs(), 1);
    expect(d).toMatchObject({ type: "RECOVER", source: "gemini", action: { kind: "goto", route: "/compare" } });
    expect(d.assessment?.assessment).toBe("blocked");
  });
  it("refuses a recovery to a route that is not on the allowlist and falls back safely", async () => {
    const { g } = guard("gemini", ok(assessment({ recovery_action: { kind: "navigate", route: "/checkout" } })));
    await stuck(g);
    const d = await g.review({ kind: "reload" }, obs(), 1);
    expect(d.type).toBe("ASK_HUMAN");
    expect(d.reason).toMatch(/refused/);
  });
  it("refuses to dismiss a button that is not on the overlay", async () => {
    const o = obs({ overlay: { title: "Promo", text: "Promo", buttons: ["Got it"] }, buttons: ["Got it"] });
    const { g } = guard("gemini", ok(assessment({ recovery_action: { kind: "dismiss_overlay", label: "Delete all" } })));
    await g.review(click("Close"), o, 0);
    expect((await g.review(click("Close"), o, 1)).type).toBe("ASK_HUMAN");
  });
  it("does not let 'allow' wave through a run that has stalled past twice the limit", async () => {
    const { g } = guard("gemini", ok(assessment({ assessment: "progressing", proposed_decision: "allow", recovery_action: null })));
    let last = "";
    for (let i = 0; i < DEFAULT_GUARD.stallLimit * 2 + 2; i++) last = (await g.review(click("Sign in"), obs(), i)).type;
    expect(last).toBe("ASK_HUMAN");
  });
  it("treats an uncertain assessment as a request for a human, not approval", async () => {
    const { g } = guard("gemini", ok(assessment({ assessment: "uncertain", proposed_decision: "allow", recovery_action: null })));
    await stuck(g);
    expect((await g.review({ kind: "reload" }, obs(), 1)).type).toBe("ASK_HUMAN");
  });
  it("falls back to rules when Gemini fails, and halts after repeated failures", async () => {
    const { g, gov } = guard("gemini", async () => { throw new Error("503"); });
    await stuck(g);
    expect(await g.review({ kind: "reload" }, obs(), 1)).toMatchObject({ type: "ASK_HUMAN", source: "fallback" });
    expect((await g.review({ kind: "reload" }, obs(), 2)).type).toBe("ASK_HUMAN");
    expect((await g.review({ kind: "reload" }, obs(), 3)).type).toBe("STOP"); // third consecutive failure trips the breaker
    expect(gov.state).toBe("halted");
    expect((await g.review({ kind: "reload" }, obs(), 4)).type).toBe("STOP"); // and it stays stopped
  });
  it("uses rules and no model call when the vision budget is spent", async () => {
    let called = 0;
    const gov = new Governor({ ...DEFAULT_GOVERNOR, maxCalls: 0 }, () => 0);
    const { g } = guard("gemini", async () => { called++; return { assessment: assessment({}), ms: 1, cached: false }; }, gov);
    await stuck(g);
    const d = await g.review({ kind: "reload" }, obs(), 1);
    expect(called).toBe(0);
    expect(d.source).toBe("fallback");
  });
});

describe("recovery verification", () => {
  it("counts a recovery as verified only when the goal state improved", async () => {
    const { g } = guard("gemini", ok(assessment({})));
    await g.review(click("Sign in"), obs(), 0);
    await g.review({ kind: "reload" }, obs(), 1); // RECOVER navigate /compare
    await g.review(click("Add"), obs({ route: "/compare", text: `${P} $34.00`, buttons: [] }), 2);
    expect(g.stats).toMatchObject({ recoveriesTried: 1, recoveriesVerified: 1 });
    expect(g.lastVerification?.helped).toBe(true);
  });
  it("marks a recovery that changed nothing as failed and will not repeat it", async () => {
    const { g } = guard("gemini", ok(assessment({})));
    await g.review(click("Sign in"), obs(), 0);
    await g.review({ kind: "reload" }, obs(), 1);
    await g.review(click("Sign in"), obs({ route: "/compare", text: "PriceCompare" }), 2); // still no price
    expect(g.stats.recoveriesVerified).toBe(0);
    expect(g.lastVerification?.helped).toBe(false);
  });
});

describe("validateRecovery is independent of the guard", () => {
  const st = { done: [], failed: [], lastClick: "Save row" };
  it("rejects navigation off the allowlist, risky retries and spent budgets", () => {
    expect(validateRecovery({ kind: "navigate", route: "/mail" }, obs(), st).ok).toBe(false);
    expect(validateRecovery({ kind: "retry_last" }, obs({ buttons: ["Confirm purchase $1.00"] }), { ...st, lastClick: "Confirm purchase $1.00" }).ok).toBe(false);
    expect(validateRecovery({ kind: "navigate", route: "/compare" }, obs(), { ...st, done: Array(DEFAULT_RECOVERY.maxRecoveries).fill({ kind: "reload" }) }).ok).toBe(false);
  });
  it("accepts a plain allowlisted navigation", () => {
    expect(validateRecovery({ kind: "navigate", route: "/compare" }, obs(), st)).toEqual({ ok: true, action: { kind: "goto", route: "/compare" } });
  });
});

describe("repeat-action baseline", () => {
  it("stops on three identical actions and nothing else", () => {
    const r = new RepeatActionGuard();
    const a = click("Add");
    expect([0, 1, 2].map((i) => r.review(a, i).type)).toEqual(["ALLOW", "ALLOW", "STOP"]);
    expect(new RepeatActionGuard().review(click("Confirm purchase $5.00"), 0).type).toBe("ALLOW"); // knows nothing about scope
  });
});
