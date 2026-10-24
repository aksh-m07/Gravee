import { z } from "zod";
import { generateJson } from "./gemini";
import { interpretReply, type Briefing } from "./escalation";

/**
 * The guard's side of a call with the boss. Gemini keeps the conversation going until the boss's intent is clear,
 * then turns it into one of: relay an instruction to the agent, approve the one blocked action, or stop.
 * The boss speaks through any voice typing tool (Voiskey types into the call box); the server only ever sees text.
 */
export interface CallTurn { from: "guard" | "boss"; text: string }
export interface CallDecision { say: string; action: "relay" | "approve" | "stop" | "clarify"; instruction: string | null; source: "gemini" | "rules" }

const Out = z.object({
  say: z.string(),
  action: z.enum(["relay", "approve", "stop", "clarify"]),
  instruction: z.string().nullable(),
});
const SCHEMA = {
  type: "object",
  properties: { say: { type: "string" }, action: { type: "string", enum: ["relay", "approve", "stop", "clarify"] }, instruction: { type: ["string", "null"] } },
  required: ["say", "action", "instruction"],
};

export const CALL_SYSTEM = `You are a night guard on a voice call with your boss. You supervise an AI agent that is doing a task in a web shop, and you called because you are stuck or because the agent wants to do something irreversible. The boss is talking to you by voice, so keep every reply to one or two short spoken sentences.

Decide what the boss wants:
- relay: the boss gave guidance for the agent. Put it in instruction as one clear imperative sentence the agent can follow.
- approve: ONLY when the call is about an irreversible action and the boss clearly said yes to it.
- stop: the boss wants the run stopped.
- clarify: you cannot tell what the boss wants, or the answer is ambiguous or contradicts itself. Ask one short question.
If the boss asks what is wrong or asks to see it, answer from the briefing and choose clarify so the call continues.
Never invent facts about the page. Never approve anything except the single action the call is about.`;

export async function nextCallTurn(model: string, b: Briefing, turns: CallTurn[]): Promise<CallDecision> {
  const lastBoss = [...turns].reverse().find((t) => t.from === "boss")?.text ?? "";
  const rules = interpretReply(lastBoss, b.confusion);
  try {
    const text = [
      `WHY YOU CALLED: ${b.confusion.replace("_", " ")}`,
      `WHAT YOU TOLD THE BOSS FIRST: ${b.spoken}`,
      `STUCK ON: ${b.stuckOn}`,
      `TRIED: ${b.tried.join("; ") || "nothing yet"}`,
      `OPTIONS YOU OFFERED: ${b.options.join(" | ")}`,
      `CALL SO FAR:\n${turns.map((t) => `${t.from === "guard" ? "GUARD" : "BOSS"}: ${t.text}`).join("\n")}`,
    ].join("\n\n");
    const { value } = await generateJson({ model, system: CALL_SYSTEM, parts: [{ type: "text", text }], schema: SCHEMA }, (x) => Out.parse(x), { timeoutMs: 20000, retries: 1 });
    // Money and other irreversible actions get a second, independent check: the rules must also hear a clear yes.
    if (value.action === "approve" && (b.confusion !== "irreversible" || rules.kind !== "approve")) {
      return { say: "Just to be sure: should I let it do that, once? Say yes or no.", action: "clarify", instruction: null, source: "gemini" };
    }
    if (value.action === "relay" && !value.instruction?.trim()) return { ...value, instruction: lastBoss, source: "gemini" };
    return { ...value, source: "gemini" };
  } catch {
    // Without Gemini the rules decide, and say so. A question keeps the call open: repeat what the guard knows.
    if (/\?\s*$/.test(lastBoss) || /^(what|why|how|which|where|who)\b/i.test(lastBoss.trim())) {
      return { say: `${b.spoken}${b.tried.length ? ` So far: ${b.tried.slice(-2).join("; ")}.` : ""}`, action: "clarify", instruction: null, source: "rules" };
    }
    if (rules.kind === "stop") return { say: "Okay, stopping it.", action: "stop", instruction: null, source: "rules" };
    if (rules.kind === "approve") return { say: "Okay, letting it do that once.", action: "approve", instruction: null, source: "rules" };
    return { say: "Okay, I will pass that on.", action: "relay", instruction: rules.text, source: "rules" };
  }
}
