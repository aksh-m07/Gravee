// Gemini as the guard's investigator: called only when the cheap checks think something is off.
// Plain REST (no SDK), a short time limit per model, and a list of models tried in order because the free tier stalls single models.

const MODELS = (process.env.GRAVEYARD_GEMINI_MODELS ?? "gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest").split(",").map((s) => s.trim()).filter(Boolean);
const PER_MODEL_MS = Number(process.env.GRAVEYARD_GEMINI_TIMEOUT_MS ?? 9000);

export const SYSTEM = `You are the night guard for an AI coding agent (Claude Code) working on a user's computer while the user is away. You see the user's goal, the agent's recent steps with their results, the step it wants to take next, and what the cheap checks flagged.
Decide one of:
- allow: the step is reasonable progress toward the goal.
- redirect: the agent is stuck, looping or off track. Block this step and give the agent one concrete, different next move in "advice" (one or two sentences, addressed to the agent).
- ask_human: only the user can decide (ambiguous goal, risky trade-off, or you truly cannot tell). Put a one-sentence question for the user in "question".
Use only the evidence given. Keep every string short.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    decision: { type: "STRING", enum: ["allow", "redirect", "ask_human"] },
    diagnosis: { type: "STRING" },
    advice: { type: "STRING" },
    question: { type: "STRING" },
  },
  required: ["decision", "diagnosis", "advice", "question"],
};

/** Returns { decision, diagnosis, advice, question, model } or throws if no model answered in time. */
export async function assess({ key, goal, history, proposed, flags }) {
  if (!key) throw new Error("no GEMINI_API_KEY");
  const text = [
    `USER'S GOAL: ${goal || "(not stated in this session)"}`,
    `RECENT STEPS (oldest first):\n${history.slice(-12).map((s, i) => `${i + 1}. ${s.summary} -> ${s.ok === false ? `FAILED: ${s.error || ""}` : s.ok ? "ok" : "?"}`).join("\n") || "(none)"}`,
    `PROPOSED NEXT STEP: ${proposed}`,
    `CHEAP CHECKS FLAGGED: ${flags.join("; ") || "nothing"}`,
  ].join("\n\n");
  let last;
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA } }),
        signal: AbortSignal.timeout(PER_MODEL_MS),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`${model}: ${j?.error?.code ?? r.status}`);
      const out = JSON.parse(j.candidates[0].content.parts[0].text);
      if (!["allow", "redirect", "ask_human"].includes(out.decision)) throw new Error(`${model}: bad decision`);
      return { ...out, model };
    } catch (e) { last = e; }
  }
  throw last ?? new Error("no model answered");
}
