import { afterEach, describe, expect, it } from "vitest";
import { nextCallTurn } from "../lib/call";
import { setTransport } from "../lib/gemini";
import type { Briefing } from "../lib/escalation";

const brief = (confusion: Briefing["confusion"]): Briefing => ({ headline: "", confusion, done: [], stuckOn: "Record the price", tried: [], question: "", options: ["Keep it blocked (default)", "Allow it once"], defaultIfSilent: "keep_stopped", spoken: "The agent wants to buy the mouse." });
const gemini = (out: object) => setTransport(async () => JSON.stringify(out));
afterEach(() => setTransport(null));

describe("the guard's side of a call", () => {
  it("passes clear guidance on to the agent", async () => {
    gemini({ say: "Got it.", action: "relay", instruction: "Use the compare page to read the price." });
    expect(await nextCallTurn("m", brief("no_safe_action"), [{ from: "boss", text: "try the compare page" }])).toMatchObject({ action: "relay", instruction: "Use the compare page to read the price.", source: "gemini" });
  });
  it("cannot approve a purchase on Gemini's word alone: the rules must also hear a clear yes", async () => {
    gemini({ say: "Okay.", action: "approve", instruction: null });
    expect((await nextCallTurn("m", brief("irreversible"), [{ from: "boss", text: "hmm I guess, not sure" }])).action).toBe("clarify");
    gemini({ say: "Okay.", action: "approve", instruction: null });
    expect((await nextCallTurn("m", brief("irreversible"), [{ from: "boss", text: "yes, go ahead" }])).action).toBe("approve");
  });
  it("never approves when the call is not about an irreversible action", async () => {
    gemini({ say: "Okay.", action: "approve", instruction: null });
    expect((await nextCallTurn("m", brief("no_safe_action"), [{ from: "boss", text: "yes" }])).action).toBe("clarify");
  });
  it("falls back to the rules, and says so, when Gemini fails", async () => {
    setTransport(async () => { throw new Error("quota"); });
    expect(await nextCallTurn("m", brief("irreversible"), [{ from: "boss", text: "stop it" }])).toMatchObject({ action: "stop", source: "rules" });
  });
});

describe("call fallback without Gemini", () => {
  it("keeps the call open when the boss asks a question", async () => {
    setTransport(async () => { throw new Error("quota"); });
    expect(await nextCallTurn("m", brief("irreversible"), [{ from: "boss", text: "what is it buying and how much?" }])).toMatchObject({ action: "clarify", source: "rules" });
  });
});

describe("model fallback list", () => {
  it("moves to the next model when one fails", async () => {
    const tried: string[] = [];
    setTransport(async (req) => { tried.push(req.model); if (req.model === "a") throw new Error("429 quota"); return JSON.stringify({ say: "Got it.", action: "relay", instruction: "Go." }); });
    expect(await nextCallTurn("a,b", brief("no_safe_action"), [{ from: "boss", text: "go" }])).toMatchObject({ action: "relay", source: "gemini" });
    expect(tried).toEqual(["a", "b"]);
  });
});
