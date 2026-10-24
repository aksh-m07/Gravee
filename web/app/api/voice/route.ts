import { z } from "zod";
import { answerFromLog, applyTeaching, understandSpeech, understandText, type Intent } from "@/lib/voice";
import { allow, clientIp, errorResponse, HttpError, readJson } from "@/lib/server-guard";

export const maxDuration = 30;

const Ctx = z.object({
  held: z.array(z.object({ agent: z.string().max(20), task: z.string().max(400), action: z.string().max(120) })).max(8),
  agents: z.array(z.string().max(20)).max(12),
  log: z.array(z.object({ time: z.string(), agent: z.string(), decision: z.string(), reason: z.string(), spoken: z.string(), action: z.string() })).max(60).default([]),
});
const Body = z.object({
  audio: z.string().max(1_500_000).optional(), // base64
  mime: z.string().max(60).optional(),
  text: z.string().max(300).optional(), // typed fallback
  context: Ctx,
});

export type VoiceReply =
  | { kind: "open" | "keep"; agent: string | null; heard: string; spoken: string }
  | { kind: "taught"; heard: string; spoken: string; rule: { id: string; text: string; direction: "permit" | "forbid"; task: string | null; agent: string | null } }
  | { kind: "refused" | "answer" | "unknown"; heard: string; spoken: string };

export async function POST(req: Request) {
  try {
    const gate = allow(clientIp(req));
    if (!gate.ok) throw new HttpError(429, `Slow down, try again in ${gate.retryAfter}s`);
    const b = Body.parse(await readJson(req, 2_000_000));
    if (!b.audio && !b.text) throw new HttpError(400, "Send audio or text");
    const intent: Intent = b.audio ? await understandSpeech(b.audio, b.mime ?? "audio/webm", b.context) : await understandText(b.text!, b.context);
    const heard = intent.transcript || b.text || "";
    const held = b.context.held.find((h) => !intent.agent || h.agent === intent.agent) ?? b.context.held[0];
    const agent = intent.agent ?? held?.agent ?? null;

    let reply: VoiceReply;
    switch (intent.intent) {
      case "open_door":
      case "keep_shut":
        reply = held
          ? { kind: intent.intent === "open_door" ? "open" : "keep", agent, heard, spoken: intent.intent === "open_door" ? `Door open for ${agent}. Letting it through.` : `Door stays shut on ${agent}.` }
          : { kind: "unknown", heard, spoken: "Nothing is waiting on you right now." };
        break;
      case "teach_rule": {
        const out = applyTeaching({
          ruleText: intent.rule_text ?? heard, direction: intent.direction ?? "forbid", scope: intent.scope ?? "this_task",
          tooBroad: intent.too_broad, task: held?.task ?? null, agent,
        });
        reply = out.accepted && out.rule ? { kind: "taught", heard, spoken: out.spoken, rule: out.rule } : { kind: "refused", heard, spoken: out.spoken };
        break;
      }
      case "status":
      case "ask":
        reply = { kind: "answer", heard, spoken: await answerFromLog(intent.question ?? heard, b.context.log) };
        break;
      default:
        reply = { kind: "unknown", heard, spoken: "I did not catch that. Say open the door, keep it shut, or ask me what happened." };
    }
    return Response.json(reply);
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Bad request" }, { status: 400 });
    return errorResponse(e);
  }
}
