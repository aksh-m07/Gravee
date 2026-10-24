import { z } from "zod";
import { generateJson, generateText, type Part } from "./gemini";
import { MODELS } from "./config";

// ---------- taught rules ----------

export interface Rule {
  id: string;
  text: string;
  direction: "permit" | "forbid";
  /** The task this rule was taught for. null means it applies to every task (only allowed for "forbid"). */
  task: string | null;
  agent: string | null;
}

/**
 * Over-broad commands we refuse no matter what the model says. A guard that can be told "allow everything"
 * is just a switch. The model also flags too_broad; either one is enough to refuse.
 */
const BROAD = /\b(everything|anything|all (actions|purchases|deletes|requests)|any action|no matter what|stop (asking|checking|watching)|never (ask|check|stop)|turn off|disable|ignore all|always allow)\b/i;
export const isOverBroad = (text: string) => BROAD.test(text);

export interface TeachOutcome {
  accepted: boolean;
  rule?: Rule;
  /** What the guard says back. */
  spoken: string;
}

export function applyTeaching(i: { ruleText: string; direction: "permit" | "forbid"; scope: "this_task" | "always"; tooBroad: boolean; task: string | null; agent: string | null }): TeachOutcome {
  if (i.tooBroad || isOverBroad(i.ruleText))
    return { accepted: false, spoken: "I will not take that one. It is too broad, and I would stop being a guard. Tell me exactly which action, for which task, and I will remember it." };
  if (i.direction === "permit" && i.scope === "always")
    return { accepted: false, spoken: "I can only loosen a rule for the task in front of me, not forever. Say it again for this task and I will remember it." };
  if (i.direction === "permit" && !i.task)
    return { accepted: false, spoken: "I do not know which task you mean. Tell me which camera, and I will scope it to that." };
  const rule: Rule = {
    id: Math.random().toString(36).slice(2, 8),
    text: i.ruleText.trim(),
    direction: i.direction,
    task: i.direction === "permit" || i.scope === "this_task" ? i.task : null,
    agent: i.agent,
  };
  return { accepted: true, rule, spoken: rule.task ? `Understood. For this task only: ${rule.text}.` : `Understood. From now on: ${rule.text}.` };
}

/** Rules that apply to a given task, rendered for the judge prompt. */
export const rulesFor = (rules: Rule[], task: string): string[] =>
  rules.filter((r) => r.task === null || r.task === task).map((r) => `${r.direction === "permit" ? "[permission, this task only]" : "[restriction]"} ${r.text}`);

// ---------- voice intent ----------

export const IntentSchema = z.object({
  transcript: z.string(),
  intent: z.enum(["open_door", "keep_shut", "status", "ask", "teach_rule", "unknown"]),
  agent: z.string().nullable(),
  rule_text: z.string().nullable(),
  direction: z.enum(["permit", "forbid"]).nullable(),
  scope: z.enum(["this_task", "always"]).nullable(),
  too_broad: z.boolean(),
  question: z.string().nullable(),
});
export type Intent = z.infer<typeof IntentSchema>;

const INTENT_JSON = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    intent: { type: "string", enum: ["open_door", "keep_shut", "status", "ask", "teach_rule", "unknown"] },
    agent: { type: ["string", "null"] },
    rule_text: { type: ["string", "null"] },
    direction: { type: ["string", "null"], enum: ["permit", "forbid", null] },
    scope: { type: ["string", "null"], enum: ["this_task", "always", null] },
    too_broad: { type: "boolean" },
    question: { type: ["string", "null"] },
  },
  required: ["transcript", "intent", "agent", "rule_text", "direction", "scope", "too_broad", "question"],
};

const INTENT_SYSTEM = `You are the ears of a night guard that supervises AI agents. The human speaks to you. Transcribe what they said and classify it.
Intents:
- open_door: let the held action go ahead ("open the door", "let it through", "go ahead", "yes, buy it").
- keep_shut: deny the held action ("keep it shut", "no", "don't let it", "cancel that").
- status: asks what is going on overall ("what's happening", "any problems").
- ask: asks a specific question about what happened ("why did you stop camera 3", "what did it try to buy"). Put the question in "question".
- teach_rule: gives a standing instruction about what is or is not allowed ("buying the cable is fine for this one", "never delete email"). Put a short imperative restatement in rule_text, direction "permit" if it loosens what the guard blocks or "forbid" if it tightens, scope "this_task" if they mean the current task or "always" if they mean forever.
- unknown: anything else.
"agent" is the camera or agent they refer to, written like "cam3", or null. Use the held alert in the context if they say "it" or "that".
Set too_broad true if a rule would switch the guard off or allow whole categories without limits ("allow everything", "stop checking", "never ask me again").`;

export interface VoiceContext {
  held: { agent: string; task: string; action: string }[];
  agents: string[];
}

export async function understandSpeech(audioBase64: string, mime: string, ctx: VoiceContext): Promise<Intent> {
  const context = `Context. Agents: ${ctx.agents.join(", ")}. Held alerts waiting for an answer: ${ctx.held.length ? ctx.held.map((h) => `${h.agent} wants to "${h.action}" (task: ${h.task})`).join("; ") : "none"}.`;
  const parts: Part[] = [{ type: "text", text: context }, { type: "audio", data: audioBase64, mime_type: mime }];
  const r = await generateJson({ model: MODELS.voice, system: INTENT_SYSTEM, parts, schema: INTENT_JSON }, (x) => IntentSchema.parse(x));
  return r.value;
}

/** Same classification from text. Used for evaluation with typed transcripts and as a typed fallback in the UI. */
export async function understandText(text: string, ctx: VoiceContext): Promise<Intent> {
  const context = `Context. Agents: ${ctx.agents.join(", ")}. Held alerts waiting for an answer: ${ctx.held.length ? ctx.held.map((h) => `${h.agent} wants to "${h.action}" (task: ${h.task})`).join("; ") : "none"}.\nThe human said: "${text}"`;
  const r = await generateJson({ model: MODELS.voice, system: INTENT_SYSTEM, parts: [{ type: "text", text: context }], schema: INTENT_JSON }, (x) => IntentSchema.parse(x));
  return r.value;
}

// ---------- answering questions from the shift log ----------

export interface LogEntry { time: string; agent: string; decision: string; reason: string; spoken: string; action: string }

export async function answerFromLog(question: string, log: LogEntry[]): Promise<string> {
  const lines = log.slice(-40).map((e) => `${e.time} ${e.agent} ${e.decision.toUpperCase()} (${e.reason}) about "${e.action}": ${e.spoken}`).join("\n");
  const r = await generateText({
    model: MODELS.voice,
    system: "You are the night guard answering the human out loud. Use only the shift log. Two sentences at most, plain speech, no markdown. If the log does not say, say you did not see it.",
    parts: [{ type: "text", text: `SHIFT LOG:\n${lines || "(nothing has happened yet)"}\n\nQUESTION: ${question}` }],
  });
  return r.text.trim();
}
