import type { Goal } from "./goal";
import type { RecoveryAction } from "./recovery";

/**
 * The guard acts for the boss and calls only when it cannot proceed alone.
 * "delegate": use the recovery toolbox without asking. "ask_first": every recovery is put to the boss as a proposal.
 * Spending, sending and deleting are never delegated in either mode: they are hard policies, not settings.
 */
export type Autonomy = "delegate" | "ask_first";
export interface Mandate { autonomy: Autonomy }
export const DEFAULT_MANDATE: Mandate = { autonomy: "delegate" };

/** Why the guard is calling. Every call has exactly one of these. */
export type Confusion =
  | "no_safe_action" // detectors say stuck and nothing on the menu applies
  | "low_confidence" // the model could not tell what is wrong
  | "irreversible" // the agent keeps reaching for an action the task did not authorize
  | "model_unavailable" // vision budget spent, halted, or the call failed, and rules have no answer
  | "ask_first"; // the boss asked to approve every recovery

export interface Briefing {
  headline: string;
  confusion: Confusion;
  done: string[];
  stuckOn: string;
  tried: string[];
  question: string;
  options: string[];
  /** What happens if the boss never answers. Always the safe side. */
  defaultIfSilent: "keep_stopped";
  /** Two or three short sentences, written to be read aloud on a call. */
  spoken: string;
}

export interface BriefingInput {
  goal: Goal;
  confusion: Confusion;
  reason: string;
  history: { action: string; ok: boolean; progressed: boolean }[];
  recoveriesUsed: RecoveryAction[];
  proposal?: RecoveryAction | null;
  /** The action the agent wants to take, in words. Used when the call is about an irreversible action. */
  action?: string;
}

const describeRecovery = (r: RecoveryAction): string => {
  switch (r.kind) {
    case "dismiss_overlay": return `close the "${r.label}" pop-up`;
    case "navigate": return `open ${r.route}`;
    case "retry_last": return "retry the last click";
    case "reload": return "reload the page";
    case "record_from_evidence": return "write the price it already found into the sheet";
  }
};
export { describeRecovery };

const QUESTION: Record<Confusion, string> = {
  no_safe_action: "I tried what I am allowed to try. How should I get past this?",
  low_confidence: "I cannot tell what is blocking this. Do you want me to keep going or stop?",
  irreversible: "The agent keeps trying to do something you did not ask for. Do you want to allow it?",
  model_unavailable: "My reasoning check is unavailable and the simple rules do not cover this. Keep going or stop?",
  ask_first: "I know what I would do next. Shall I do it?",
};

/** Build what the guard says when it has to call. Built from the guard's own evidence only. */
export function buildBriefing(i: BriefingInput): Briefing {
  const done = i.goal.reqs.filter((r) => r.status === "satisfied").map((r) => r.text);
  const open = i.goal.reqs.find((r) => r.status !== "satisfied");
  const stuckOn = open ? `${open.text}${open.evidence ? ` (${open.evidence})` : ""}` : "nothing is open";
  const tried = [
    ...i.history.filter((h) => !h.progressed).slice(-3).map((h) => `${h.action}${h.ok ? "" : " (failed)"}`),
    ...i.recoveriesUsed.map((r) => `I ${describeRecovery(r)}`),
  ].slice(-4);
  const options = i.confusion === "irreversible"
    ? ["Keep it blocked (default)", "Allow it once"]
    : i.proposal
      ? [`Let me ${describeRecovery(i.proposal)}`, "Keep it stopped (default)"]
      : ["Keep it stopped (default)", "Let it keep trying"];
  const headline = `Need your call on "${i.goal.product}"`;
  const spoken = i.confusion === "irreversible" && i.action
    ? `The agent wants to ${i.action} on the ${i.goal.product} task. This cannot be undone. Say yes to allow it once, or say no to keep it blocked.`
    : [
    `The agent is stuck on the ${i.goal.product} task.`,
    open?.evidence ? `${open.evidence[0].toUpperCase()}${open.evidence.slice(1)}.` : `${open ? open.text : "The task is not finished"}.`,
    i.proposal ? `I can ${describeRecovery(i.proposal)}. Say go ahead, or say stop.` : "Say keep going, or say stop. If I hear nothing, I keep it stopped.",
  ].join(" ");
  return { headline, confusion: i.confusion, done, stuckOn, tried, question: QUESTION[i.confusion], options, defaultIfSilent: "keep_stopped", spoken };
}

export type BossReply = { kind: "stop" } | { kind: "approve" } | { kind: "guidance"; text: string };

const STOP = /\b(stop|cancel|abort|halt|shut (it )?down|kill it)\b/i;
const NEGATE = /\b(don'?t|do not|no|never|not)\b/i;
const YES = /\b(yes|yeah|yep|approve[d]?|go ahead|do it|allow|ok|okay|buy it|confirm)\b/i;

/**
 * What the boss said, as a decision. "Stop" stops. A clear yes approves only when the call was about an irreversible action,
 * and then only that one action. Anything else is guidance that goes to the agent word for word. Spoken or typed makes no difference:
 * dictation tools such as Wispr Flow just type into the reply box.
 */
export function interpretReply(text: string, c: Confusion): BossReply {
  const t = text.trim().slice(0, 300);
  if (STOP.test(t) && !/\b(don'?t|do not) stop\b/i.test(t)) return { kind: "stop" };
  if (c === "irreversible") {
    if (YES.test(t) && !NEGATE.test(t)) return { kind: "approve" };
    return { kind: "guidance", text: `Do not do that. ${t}`.trim() };
  }
  return { kind: "guidance", text: t || "Continue with the task." };
}
