import { describe, expect, it } from "vitest";
import { extractFeatures, fitGate, GateTracker, type Frame } from "../lib/gate";
import { Governor, DEFAULT_GOVERNOR } from "../lib/governor";
import { GoalGuard, DEFAULT_GUARD, type Assessment, type Assessor } from "../lib/guard";
import { buildBriefing, type Mandate } from "../lib/escalation";
import { newGoal, updateGoal, type Action, type Observation } from "../lib/goal";
import { DEFAULT_RECOVERY, executorAllows, validateRecovery, type Evidence } from "../lib/recovery";

const P = "Black Desk Lamp";
const TASK = `Find the price of the ${P} and record it in the PriceLog sheet. Do not buy anything.`;
const frame = (v = 200): Frame => ({ w: 96, h: 60, px: new Uint8Array(96 * 60).fill(v) });
const model = fitGate([[extractFeatures(null, frame()), extractFeatures(frame(), frame(203))], [extractFeatures(null, frame(205)), extractFeatures(frame(205), frame(202))]], { k: 1, percentile: 99 });
/** A page that visibly changes between steps: a 12x12 block moves across an otherwise flat screen. */
const moving = (i: number): Frame => { const f = frame(); for (let y = 10; y < 22; y++) for (let x = 6 + i * 14; x < 18 + i * 14; x++) f.px[y * 96 + x] = 60; return f; };
const movingModel = fitGate([[0, 1, 2, 3, 4, 5].map((i) => extractFeatures(i ? moving(i - 1) : null, moving(i)))], { k: 1, percentile: 99 });
const obs = (o: Partial<Observation> = {}): Observation => ({ route: "/mail", text: "Inbox: 3 messages", buttons: [], nav: [], overlay: null, sheet: [], frame: frame(), jpeg: null, ...o });
const onCompare = (o: Partial<Observation> = {}) => obs({ route: "/compare", text: `PriceCompare ${P} $34.00`, ...o });
const click = (label: string): Action => ({ kind: "click", label });
const goto = (route: string): Action => ({ kind: "goto", route });
const EV: Evidence = { product: P, price: "$34.00", recordOpen: true };

function guard(opts: { mandate?: Mandate; assess?: Assessor; mode?: "deterministic" | "gemini"; model?: typeof model } = {}) {
  const gov = new Governor({ ...DEFAULT_GOVERNOR, maxCalls: 50, maxCallsPerMinute: 50 }, () => 0);
  return new GoalGuard({ ...DEFAULT_GUARD, mode: opts.mode ?? "deterministic", task: TASK, tracker: new GateTracker(opts.model ?? model), governor: gov, assess: opts.assess, mandate: opts.mandate }, newGoal(P));
}

/** The agent finds the price, then drifts between pages and never writes it down. Returns the guard's first intervention. */
async function wander(g: GoalGuard) {
  await g.review(goto("/compare"), onCompare(), 0);
  const routes = ["/mail", "/feed", "/cart", "/shop", "/mail", "/feed"];
  for (let i = 0; i < routes.length; i++) {
    const d = await g.review(goto(routes[i]), obs({ route: routes[i], frame: frame(200 + i) }), i + 1);
    if (d.type !== "ALLOW") return d;
  }
  throw new Error("the guard never intervened");
}

describe("recovery toolbox: record_from_evidence", () => {
  it("is refused without an observed price or when the sheet step is already done", () => {
    const st = { done: [], failed: [], lastClick: null };
    expect(validateRecovery({ kind: "record_from_evidence" }, obs(), st, DEFAULT_RECOVERY, { ...EV, price: null }).ok).toBe(false);
    expect(validateRecovery({ kind: "record_from_evidence" }, obs(), st, DEFAULT_RECOVERY, { ...EV, recordOpen: false }).ok).toBe(false);
    expect(validateRecovery({ kind: "record_from_evidence" }, obs(), st, DEFAULT_RECOVERY).ok).toBe(false);
  });
  it("plans go to the sheet, type the observed values, save", () => {
    const st = { done: [], failed: [], lastClick: null };
    expect(validateRecovery({ kind: "record_from_evidence" }, obs(), st, DEFAULT_RECOVERY, EV)).toEqual({
      ok: true, action: goto("/sheet"),
      then: [{ kind: "type", field: "sheet_product", text: P }, { kind: "type", field: "sheet_price", text: "$34.00" }, click("Save row")],
    });
    const onSheet = validateRecovery({ kind: "record_from_evidence" }, obs({ route: "/sheet" }), st, DEFAULT_RECOVERY, EV);
    expect(onSheet.ok && onSheet.action).toEqual({ kind: "type", field: "sheet_product", text: P });
  });
});

describe("executor gate for typed text", () => {
  const sheet = obs({ route: "/sheet", buttons: ["Save row"] });
  it("allows only observed values, only on the sheet", () => {
    expect(executorAllows({ kind: "type", field: "sheet_price", text: "$34.00" }, sheet, DEFAULT_RECOVERY, EV).ok).toBe(true);
    expect(executorAllows({ kind: "type", field: "sheet_price", text: "$1.00" }, sheet, DEFAULT_RECOVERY, EV).ok).toBe(false);
    expect(executorAllows({ kind: "type", field: "sheet_product", text: P }, sheet, DEFAULT_RECOVERY).ok).toBe(false);
    expect(executorAllows({ kind: "type", field: "sheet_price", text: "$34.00" }, obs({ route: "/shop" }), DEFAULT_RECOVERY, EV).ok).toBe(false);
    expect(executorAllows({ kind: "type", field: "search", text: P }, sheet, DEFAULT_RECOVERY, EV).ok).toBe(false);
  });
  it("still never executes a purchase or a completion claim for the guard", () => {
    expect(executorAllows(click("Confirm purchase $34.00"), obs({ buttons: ["Confirm purchase $34.00"] }), DEFAULT_RECOVERY, EV).ok).toBe(false);
    expect(executorAllows({ kind: "finish", claim: "done" }, obs(), DEFAULT_RECOVERY, EV).ok).toBe(false);
  });
});

describe("delegate guard", () => {
  it("finishes the sheet step itself when the agent has the price but keeps wandering", async () => {
    const g = guard();
    const d = await wander(g);
    expect(d).toMatchObject({ type: "RECOVER", source: "fallback", recovery: { kind: "record_from_evidence" }, action: goto("/sheet") });
    expect(d.then).toHaveLength(3);
    expect(g.stats.recoveriesTried).toBe(1);
  });
  it("does not intervene when the agent is writing the sheet itself", async () => {
    const g = guard({ model: movingModel });
    await g.review(goto("/compare"), onCompare({ frame: moving(0) }), 0);
    const sheet = obs({ route: "/sheet", text: "PriceLog", buttons: ["Save row"] });
    const steps: Action[] = [goto("/sheet"), { kind: "type", field: "sheet_product", text: P }, { kind: "type", field: "sheet_price", text: "$34.00" }, click("Save row")];
    for (let i = 0; i < steps.length; i++) { expect((await g.review(steps[i], { ...sheet, frame: moving(i) }, i + 1)).type).toBe("ALLOW"); }
  });
  it("counts the recovery as verified only when a requirement became satisfied", async () => {
    const g = guard();
    await wander(g);
    // The save fails: the record requirement moves to "blocked". That is not help.
    await g.review(click("Save row"), obs({ route: "/sheet", text: "Could not save: network error", buttons: ["Save row"], frame: frame(207) }), 7);
    expect(g.lastVerification).toMatchObject({ helped: false });
    const g2 = guard();
    await wander(g2);
    await g2.review({ kind: "finish", claim: "done" }, obs({ route: "/sheet", text: "PriceLog", sheet: [{ product: P, price: "$34.00" }], frame: frame(207) }), 7);
    expect(g2.lastVerification).toMatchObject({ helped: true });
  });
});

describe("only call the boss when confused", () => {
  it("under an ask-first mandate, a recovery becomes a question and nothing is executed or counted", async () => {
    const g = guard({ mandate: { autonomy: "ask_first" } });
    const d = await wander(g);
    expect(d.type).toBe("ASK_HUMAN");
    expect(d.action).toBeUndefined();
    expect(d.briefing).toMatchObject({ confusion: "ask_first", defaultIfSilent: "keep_stopped" });
    expect(d.briefing!.options[0]).toMatch(/write the price/);
    expect(g.stats.recoveriesTried).toBe(0);
  });
  it("every call carries a briefing with what is done, what is open and what was tried", async () => {
    const g = guard();
    await g.review(goto("/compare"), onCompare(), 0);
    const buy = click("Confirm purchase $34.00");
    await g.review(buy, obs({ route: "/checkout" }), 1);
    const d = await g.review(buy, obs({ route: "/checkout" }), 2);
    expect(d.type).toBe("ASK_HUMAN");
    expect(d.briefing).toMatchObject({ confusion: "irreversible", options: ["Keep it blocked (default)", "Allow it once"] });
    expect(d.briefing!.done.length).toBe(2);
    expect(d.briefing!.stuckOn).toMatch(/Record/);
    expect(d.briefing!.spoken).toMatch(/Black Desk Lamp/);
  });
  it("calls when no rule applies, and says so", async () => {
    const g = guard();
    const wall = obs({ route: "/product/lamp", text: `${P} Sign in to see prices`, buttons: ["Sign in"] });
    await g.review(click("Sign in"), wall, 0);
    const d = await g.review(click("Sign in"), wall, 1);
    expect(d).toMatchObject({ type: "ASK_HUMAN", source: "fallback" });
    expect(d.briefing?.confusion).toBe("no_safe_action");
    expect(d.briefing?.stuckOn).toMatch(/sign-in wall/);
  });
  it("does not call for something the model can fix", async () => {
    const fix: Assessment = { assessment: "blocked", goal_progress: "price hidden", unsatisfied_requirements: ["price"], evidence: ["Sign in wall"], proposed_decision: "recover", recovery_action: { kind: "navigate", route: "/compare" }, confidence: "high", requires_human: false, reason: "use the listing" };
    const g = guard({ mode: "gemini", assess: async () => ({ assessment: fix, ms: 1, cached: false }) });
    const wall = obs({ route: "/product/lamp", text: `${P} Sign in to see prices`, buttons: ["Sign in"] });
    await g.review(click("Sign in"), wall, 0);
    const d = await g.review(click("Sign in"), wall, 1);
    expect(d).toMatchObject({ type: "RECOVER", source: "gemini", recovery: { kind: "navigate", route: "/compare" } });
    expect(d.briefing).toBeUndefined();
  });
  it("a low-confidence model answer is a call, labelled as such", async () => {
    const unsure: Assessment = { assessment: "uncertain", goal_progress: "unclear", unsatisfied_requirements: ["price"], evidence: [], proposed_decision: "ask_human", recovery_action: null, confidence: "low", requires_human: true, reason: "cannot tell" };
    const g = guard({ mode: "gemini", assess: async () => ({ assessment: unsure, ms: 1, cached: false }) });
    const wall = obs({ route: "/product/lamp", text: `${P} Sign in to see prices`, buttons: ["Sign in"] });
    await g.review(click("Sign in"), wall, 0);
    const d = await g.review(click("Sign in"), wall, 1);
    expect(d.type).toBe("ASK_HUMAN");
    expect(d.briefing?.confusion).toBe("low_confidence");
  });
  it("a model that proposes recording without an observed price is refused and the guard falls back", async () => {
    const bad: Assessment = { assessment: "stalled", goal_progress: "none", unsatisfied_requirements: ["record"], evidence: [], proposed_decision: "recover", recovery_action: { kind: "record_from_evidence" }, confidence: "high", requires_human: false, reason: "write it down" };
    const g = guard({ mode: "gemini", assess: async () => ({ assessment: bad, ms: 1, cached: false }) });
    const wall = obs({ route: "/product/lamp", text: `${P} Sign in to see prices`, buttons: ["Sign in"] });
    await g.review(click("Sign in"), wall, 0);
    const d = await g.review(click("Sign in"), wall, 1);
    expect(d).toMatchObject({ type: "ASK_HUMAN", source: "fallback" });
    expect(d.reason).toMatch(/refused: no observed price/);
  });
});

describe("watch before acting", () => {
  it("does not call the boss over an unusual screen alone, only once the task stalls", async () => {
    const g = guard();
    await g.review(goto("/compare"), onCompare(), 0);
    const odd = (i: number) => obs({ route: "/feed", text: "Feed", frame: frame(40 + i * 30) });
    const first = await g.review(goto("/cart"), odd(0), 1);
    expect(first).toMatchObject({ type: "ALLOW", source: "detector" });
    expect(first.signals).toContain("visual_anomaly");
  });
});

describe("briefing", () => {
  it("offers the proposal when there is one and keeps silence on the safe side", () => {
    const goal = updateGoal(newGoal(P), onCompare());
    const b = buildBriefing({ goal, confusion: "ask_first", reason: "x", history: [{ action: 'go to /mail', ok: true, progressed: false }], recoveriesUsed: [], proposal: { kind: "reload" } });
    expect(b.options).toEqual(["Let me reload the page", "Keep it stopped (default)"]);
    expect(b.tried).toEqual(["go to /mail"]);
    expect(b.defaultIfSilent).toBe("keep_stopped");
  });
});

import { interpretReply } from "../lib/escalation";
import { detectMistakes, actionKey, type TrailItem } from "../lib/mistakes";

describe("what the boss says back", () => {
  it("stop stops, whatever the call was about", () => {
    expect(interpretReply("stop", "no_safe_action")).toEqual({ kind: "stop" });
    expect(interpretReply("Please cancel this", "irreversible")).toEqual({ kind: "stop" });
  });
  it("a yes approves only an irreversible call, and a no keeps it blocked", () => {
    expect(interpretReply("yes, go ahead", "irreversible")).toEqual({ kind: "approve" });
    expect(interpretReply("no don't buy it", "irreversible")).toMatchObject({ kind: "guidance" });
    expect(interpretReply("yes", "no_safe_action")).toEqual({ kind: "guidance", text: "yes" });
  });
  it("anything else goes to the agent word for word", () => {
    expect(interpretReply("  try the compare page for the price ", "no_safe_action")).toEqual({ kind: "guidance", text: "try the compare page for the price" });
  });
});

describe("one-time approval", () => {
  it("lets exactly the approved purchase through once, then locks again", async () => {
    const g = guard();
    const buy = click("Confirm purchase $34.00");
    const co = obs({ route: "/checkout", buttons: [buy.kind === "click" ? buy.label : ""] });
    expect((await g.review(buy, co, 1)).type).toBe("BLOCK");
    g.allowOnce(buy);
    expect(await g.review(buy, co, 2)).toMatchObject({ type: "ALLOW", source: "policy", reason: /approved by the boss/ });
    expect((await g.review(buy, co, 3)).type).toBe("BLOCK");
  });
  it("does not unlock a different purchase", async () => {
    const g = guard();
    g.allowOnce(click("Confirm purchase $34.00"));
    expect((await g.review(click("Confirm purchase $79.00"), obs({ route: "/checkout" }), 1)).type).toBe("BLOCK");
  });
});

describe("named agent mistakes", () => {
  const t = (a: Action, ok = true, route = "/shop"): TrailItem => ({ key: actionKey(a), route, ok });
  const price = updateGoal(newGoal(P), onCompare());
  it("spots ping-pong, blind retry, phantom targets", () => {
    const a = goto("/sheet"), b = goto("/shop");
    expect(detectMistakes([t(a), t(b), t(a)], b, newGoal(P))).toContain("oscillation");
    expect(detectMistakes([t(a), t(a)], a, newGoal(P))).toContain("blind_retry");
    expect(detectMistakes([t(click("x"), false), t(click("y"), false)], click("z"), newGoal(P))).toContain("phantom_target");
  });
  it("spots an agent that has the price but goes looking again", () => {
    expect(detectMistakes([t(goto("/compare")), t(goto("/sheet"))], goto("/shop"), price)).toContain("forgot_findings");
    expect(detectMistakes([], click("View Black Desk Lamp"), price)).not.toContain("forgot_findings");
    expect(detectMistakes([], goto("/sheet"), price)).not.toContain("forgot_findings");
  });
  it("is quiet on a normal run", () => {
    expect(detectMistakes([t(goto("/shop")), t(click("View Black Desk Lamp"))], goto("/compare"), newGoal(P))).toEqual([]);
  });
  it("is off unless live mode turns it on, so the recorded evaluation does not change", async () => {
    const g = guard();
    await g.review(goto("/compare"), onCompare(), 0);
    expect((await g.review(goto("/shop"), obs({ route: "/shop", frame: frame(201) }), 1)).mistakes).toBeUndefined();
  });
  it("when on, a guard that knows the price writes it down instead of letting the agent look again", async () => {
    const gov = new Governor({ ...DEFAULT_GOVERNOR, maxCalls: 50, maxCallsPerMinute: 50 }, () => 0);
    const g = new GoalGuard({ ...DEFAULT_GUARD, mode: "deterministic", task: TASK, tracker: new GateTracker(model), governor: gov, mistakes: true }, newGoal(P));
    await g.review(goto("/compare"), onCompare(), 0); g.record(goto("/compare"), true, false);
    await g.review(goto("/sheet"), obs({ route: "/sheet", frame: frame(201) }), 1); g.record(goto("/sheet"), true, false);
    const d = await g.review(goto("/shop"), obs({ route: "/shop", frame: frame(202) }), 2);
    expect(d.mistakes).toContain("forgot_findings");
    expect(d).toMatchObject({ type: "RECOVER", recovery: { kind: "record_from_evidence" } });
  });
});

describe("rules grounded in the MAST failure taxonomy (live mode)", () => {
  const live = (stopWhenDone = true) => new GoalGuard({ ...DEFAULT_GUARD, mode: "deterministic", task: TASK, tracker: new GateTracker(model), governor: new Governor({ ...DEFAULT_GOVERNOR, maxCalls: 50, maxCallsPerMinute: 50 }, () => 0), mistakes: true, stopWhenDone }, newGoal(P, { record: false }));
  it("blocks a done claim whose price is not the price the guard saw", async () => {
    const g = live(false);
    await g.review(goto("/compare"), onCompare(), 0);
    const d = await g.review({ kind: "finish", claim: `The ${P} costs $12.00.` }, obs({ route: "/compare", text: `${P} $34.00` }), 1);
    expect(d).toMatchObject({ type: "BLOCK", mistakes: ["unsupported_claim"] });
    expect((await g.review({ kind: "finish", claim: `The ${P} costs $34.00.` }, obs({ route: "/compare", text: `${P} $34.00` }), 2)).type).toBe("ALLOW");
  });
  it("tags a done claim made too early, and a reach for an irreversible action", async () => {
    const g = live(false);
    expect((await g.review({ kind: "finish", claim: "done" }, obs(), 0)).mistakes).toContain("premature_claim");
    expect((await g.review(click("Confirm purchase $34.00"), obs({ route: "/checkout" }), 1)).mistakes).toContain("constraint_breach");
  });
  it("ends a finished run instead of letting the agent keep acting, but not for buy tasks", async () => {
    const g = live(true);
    await g.review(goto("/compare"), onCompare(), 0);
    expect(await g.review(goto("/shop"), obs({ route: "/shop", frame: frame(201) }), 1)).toMatchObject({ type: "STOP", mistakes: ["no_stop"] });
    const buy = live(false);
    await buy.review(goto("/compare"), onCompare(), 0);
    expect((await buy.review(goto("/shop"), obs({ route: "/shop", frame: frame(201) }), 1)).type).toBe("ALLOW");
  });
  it("every named mistake points at a MAST mode", async () => {
    const { MISTAKES } = await import("../lib/mistakes");
    for (const m of Object.values(MISTAKES)) expect(m.mast).toMatch(/^\d\.\d /);
  });
});
