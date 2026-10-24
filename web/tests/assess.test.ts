import { afterEach, describe, expect, it } from "vitest";
import { setTransport, stats } from "../lib/gemini";
import { buildParts, geminiAssessor, toAssessment } from "../lib/assess";
import { newGoal, updateGoal, type Observation } from "../lib/goal";
import { DEFAULT_RECOVERY } from "../lib/recovery";
import type { AssessContext } from "../lib/guard";
import sharp from "sharp";

const P = "Black Desk Lamp";
const obs: Observation = { route: "/product/lamp", text: `${P} Sign in to see prices`, buttons: ["Sign in"], nav: [], overlay: null, sheet: [], frame: { w: 1, h: 1, px: new Uint8Array(1) }, jpeg: null };
const ctx = (o: Partial<AssessContext> = {}): AssessContext => ({
  goal: updateGoal(newGoal(P), obs), task: `Find the price of the ${P} and record it in the PriceLog sheet.`, proposed: { kind: "reload" },
  history: [{ action: 'click "Sign in"', ok: true, progressed: false }], obs, signals: ["requirement_blocked"], stall: 2, recoveriesUsed: [], failedRecoveries: [], policy: DEFAULT_RECOVERY, ...o,
});
const good = { assessment: "blocked", goal_progress: "no price yet", unsatisfied_requirements: ["price"], evidence: ["Sign in wall"], proposed_decision: "recover", recovery_action: { kind: "navigate", label: null, route: "/compare" }, confidence: "high", requires_human: false, reason: "wall" };

afterEach(() => setTransport(null));

describe("assessment parsing", () => {
  it("maps a valid recovery", () => expect(toAssessment(good).recovery_action).toEqual({ kind: "navigate", route: "/compare" }));
  it("rejects recover with no usable action", () => expect(() => toAssessment({ ...good, recovery_action: { kind: "navigate", label: null, route: null } })).toThrow());
  it("rejects values outside the schema", () => {
    expect(() => toAssessment({ ...good, proposed_decision: "purchase" })).toThrow();
    expect(() => toAssessment({ ...good, recovery_action: { kind: "click", label: "Buy", route: null } })).toThrow();
    expect(() => toAssessment({ ...good, confidence: 0.9 })).toThrow();
  });
  it("drops a stray recovery when the decision is not recover", () => expect(toAssessment({ ...good, proposed_decision: "ask_human" }).recovery_action).toBeNull());
});

describe("what Gemini is shown", () => {
  it("includes the goal, history, allowed routes and the screenshot, and nothing from the evaluator", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const parts = await buildParts(ctx({ obs: { ...obs, jpeg } }));
    const text = (parts[0] as { text: string }).text;
    expect(text).toMatch(/price is hidden behind a sign-in wall/);
    expect(text).toMatch(/click "Sign in".*no progress/);
    expect(text).toMatch(/\/compare: PriceCompare/);
    expect(text).not.toMatch(/\$34\.00|truth|ground/i);
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });
});

describe("geminiAssessor with an injected transport", () => {
  it("returns a validated assessment", async () => {
    setTransport(async () => JSON.stringify(good));
    const r = await geminiAssessor(ctx());
    expect(r.assessment.proposed_decision).toBe("recover");
  });
  it("retries once on malformed JSON, then throws", async () => {
    let n = 0;
    setTransport(async () => { n++; return "not json"; });
    await expect(geminiAssessor(ctx())).rejects.toThrow();
    expect(n).toBe(2);
    expect(stats.calls).toBeGreaterThan(0);
  });
});
