// Gemini investigates a detected terminal-agent failure. Every outbound attempt is reserved before dispatch.
import { redact } from "./config.mjs";

export const SYSTEM = `You are the night guard for an AI coding agent (Claude Code) working on a user's computer while the user is away. You see the user's goal, the agent's recent steps with their results, the step it wants to take next, and what the cheap checks flagged.
Decide one of:
- allow: the step is reasonable progress toward the goal.
- redirect: the agent is stuck, looping or off track. Block this step and give the agent one concrete, different next move in "advice" (one or two sentences, addressed to the agent).
- ask_human: only the user can decide (ambiguous goal, risky trade-off, or you truly cannot tell). Put a one-sentence question for the user in "question".
Use only the evidence given. Never authorize irreversible actions. Keep every string short.`;
const SCHEMA = { type: "OBJECT", properties: {
  decision: { type: "STRING", enum: ["allow", "redirect", "ask_human"] }, diagnosis: { type: "STRING" }, advice: { type: "STRING" }, question: { type: "STRING" },
}, required: ["decision", "diagnosis", "advice", "question"] };

export async function assess({ key, goal, history, proposed, flags, reserve = () => true, fetcher = fetch }) {
  if (!key) throw new Error("no GEMINI_API_KEY");
  const models = (process.env.GRAVEYARD_GEMINI_MODEL || process.env.GRAVEYARD_GEMINI_MODELS || "gemini-3.6-flash").split(",").map((m) => m.trim()).filter((m) => /^[a-zA-Z0-9._-]+$/.test(m));
  const cap = Math.min(2, Math.max(1, Number(process.env.GRAVEYARD_GEMINI_MAX_ATTEMPTS || 1) || 1));
  const deadline = Date.now() + Math.min(20_000, Math.max(100, Number(process.env.GRAVEYARD_GEMINI_TIMEOUT_MS || 12000) || 12000));
  const text = redact([
    `USER'S GOAL: ${goal || "(not stated in this session)"}`,
    `RECENT STEPS (oldest first):\n${history.slice(-12).map((s, i) => `${i + 1}. ${s.summary} -> ${s.ok === false ? `FAILED: ${s.error || ""}` : s.ok ? "ok" : "?"}`).join("\n") || "(none)"}`,
    `PROPOSED NEXT STEP: ${proposed}`, `CHEAP CHECKS FLAGGED: ${flags.join("; ") || "nothing"}`,
  ].join("\n\n")).slice(0, 7000);
  let last = "no configured model";
  let attempts = 0;
  for (const model of models.slice(0, cap)) {
    if (Date.now() >= deadline || !reserve(model)) break;
    attempts++;
    try {
      const r = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: 1536,
            thinkingConfig: { thinkingLevel: model === "gemini-3.6-flash" ? "MINIMAL" : "LOW" } } }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!r.ok) { last = `${model}: HTTP ${r.status}`; continue; }
      const j = await r.json();
      const raw = j.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      const out = JSON.parse(raw);
      if (!["allow", "redirect", "ask_human"].includes(out.decision) || ![out.diagnosis, out.advice, out.question].every((v) => typeof v === "string" && v.length <= 2000)) throw new Error("invalid assessment schema");
      return { ...out, model: j.modelVersion || model, requestedModel: model, attempts };
    } catch (e) { last = `${model}: ${e.name === "TimeoutError" ? "timeout" : "invalid or unavailable response"}`; }
  }
  throw new Error(`Supervisor Gemini unavailable after ${attempts} actual attempt(s): ${last}`);
}
