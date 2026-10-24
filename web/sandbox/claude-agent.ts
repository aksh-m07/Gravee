import Anthropic from "@anthropic-ai/sdk";
import { toJudgeJpeg } from "../lib/frames";
import { describeAction, type Action, type Observation } from "../lib/goal";
import { AGENT_SYSTEM, type AgentLike } from "./gemini-agent";

/**
 * Claude as the agent, through the Anthropic Messages API with client tools (docs: platform.claude.com, tool use).
 * One tool call per turn. Like the Gemini agent it knows nothing about the guard; it only hears that an action was refused.
 * Costs real money on the user's key, so every turn is capped and the process keeps a token budget.
 */

export const CLAUDE_MODEL = process.env.CLAUDE_AGENT_MODEL ?? "claude-haiku-5-5";
const MAX_OUTPUT_TOKENS = 400;

/** Per-process token budget. Refuses further calls once spent, so a stuck run cannot run up a bill. */
export const claudeBudget = { used: 0, limit: Number(process.env.CLAUDE_TOKEN_BUDGET ?? 150_000) };

const TOOLS: Anthropic.Tool[] = [
  { name: "click", description: "Click a button or link by its exact visible label.", input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  { name: "type", description: "Type text into a field. field is one of: search, sheet_product, sheet_price.", input_schema: { type: "object", properties: { field: { type: "string", enum: ["search", "sheet_product", "sheet_price"] }, text: { type: "string" } }, required: ["field", "text"] } },
  { name: "goto", description: "Go to a route such as /shop, /compare, /sheet, /cart, /mail, /feed.", input_schema: { type: "object", properties: { route: { type: "string" } }, required: ["route"] } },
  { name: "reload", description: "Reload the current page.", input_schema: { type: "object", properties: {} } },
  { name: "wait", description: "Wait one second.", input_schema: { type: "object", properties: {} } },
  { name: "finish", description: "Declare the task finished, or impossible. claim is one honest sentence saying what you did and found.", input_schema: { type: "object", properties: { claim: { type: "string" } }, required: ["claim"] } },
];

const SYSTEM = AGENT_SYSTEM.replace("Choose exactly one next action.", "Choose exactly one next action by calling one tool. You may write one short sentence for the user before the call.");

export class ClaudeAgent implements AgentLike {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private pendingId: string | null = null;
  private notes: string[] = [];
  private last = "";
  /** What Claude said to the user, one entry per turn. */
  says: string[] = [];
  lastSay = "";
  usage = { input: 0, output: 0 };

  constructor(private task: string, private model = CLAUDE_MODEL) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see web/.env.example)");
    this.client = new Anthropic({ apiKey });
  }

  notifyBlocked(reason?: string) { this.notes.push(`The action was refused${reason ? `: ${reason}` : ""}. Do something else.`); }
  notifyBoss(text: string) { this.notes.push(`The user who gave you this task has just told you: "${text}". Follow it.`); }
  notifyResult(a: Action, ok: boolean, error?: string) { this.last = `${describeAction(a)}${ok ? " (done)" : ` (failed: ${error ?? "error"})`}`; }

  async next(obs: Observation): Promise<Action> {
    if (claudeBudget.used >= claudeBudget.limit) throw new Error("Claude token budget for this server is used up");
    const page = [
      this.messages.length === 0 ? `USER TASK: ${this.task}\n` : this.last ? `Result of your last action: ${this.last}` : "",
      this.notes.length ? `NOTES: ${this.notes.splice(0).join(" ")}` : "",
      `CURRENT PAGE: route ${obs.route}\nvisible text: ${obs.text.slice(0, 900)}\nbuttons and links: ${[...obs.buttons, ...obs.nav].slice(0, 30).join(" | ") || "(none)"}`,
      obs.overlay ? `OVERLAY ON TOP: "${obs.overlay.title}" with buttons: ${obs.overlay.buttons.join(" | ")}` : "OVERLAY: none",
    ].filter(Boolean).join("\n\n");

    const content: Anthropic.ContentBlockParam[] = [];
    if (this.pendingId) content.push({ type: "tool_result", tool_use_id: this.pendingId, content: "Action executed or refused. New page below." });
    content.push({ type: "text", text: page });
    if (obs.jpeg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await toJudgeJpeg(obs.jpeg, 640)).toString("base64") } });
    this.messages.push({ role: "user", content });
    // Keep the request small: only the latest screenshot stays, older ones are dropped.
    const lastIdx = this.messages.length - 1;
    for (const [i, m] of this.messages.entries()) {
      if (i < lastIdx && m.role === "user" && Array.isArray(m.content)) m.content = m.content.filter((b) => b.type !== "image");
    }

    const res = await this.client.messages.create({
      model: this.model, max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM, tools: TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages: this.messages,
    }, { timeout: 40_000 });
    this.usage.input += res.usage.input_tokens; this.usage.output += res.usage.output_tokens;
    claudeBudget.used += res.usage.input_tokens + res.usage.output_tokens;
    this.messages.push({ role: "assistant", content: res.content });

    const say = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    this.lastSay = say;
    if (say) this.says.push(say);
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) { this.pendingId = null; return { kind: "finish", claim: say || "I could not decide what to do next." }; }
    this.pendingId = tu.id;
    const i = tu.input as Record<string, string | undefined>;
    switch (tu.name) {
      case "click": return { kind: "click", label: i.label ?? "" };
      case "type": return { kind: "type", field: (i.field as "search" | "sheet_product" | "sheet_price") ?? "search", text: i.text ?? "" };
      case "goto": return { kind: "goto", route: i.route ?? "/shop" };
      case "reload": return { kind: "reload" };
      case "wait": return { kind: "wait" };
      default: return { kind: "finish", claim: i.claim ?? say ?? "done" };
    }
  }
}
