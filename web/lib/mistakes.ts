import type { Action, Goal } from "./goal";

/**
 * Common ways LLM agents go wrong, as named rules over the agent's own trail. These are rules, not a trained model.
 * Each one is cheap to check every step; the guard shows them by name and gives them to Gemini as context.
 * `mast` is the closest failure mode in the public MAST taxonomy (Cemri et al. 2025, arXiv 2503.13657, 14 modes from 1,642 traces).
 * The mapping is mine and approximate: MAST describes multi-agent software traces, these rules watch a browser agent.
 */
export type MistakeId = "oscillation" | "blind_retry" | "phantom_target" | "forgot_findings" | "off_task" | "no_stop" | "unsupported_claim" | "premature_claim" | "constraint_breach";

export const MISTAKES: Record<MistakeId, { name: string; plain: string; mast: string }> = {
  oscillation: { name: "Ping-pong", plain: "The agent keeps switching between the same two pages or actions and gets nowhere.", mast: "1.3 Step repetition" },
  blind_retry: { name: "Blind retry", plain: "The agent repeats the same action again and again expecting a different result.", mast: "1.3 Step repetition" },
  phantom_target: { name: "Phantom target", plain: "The agent keeps clicking or typing into things that are not on the page.", mast: "2.6 Reasoning-action mismatch" },
  forgot_findings: { name: "Forgot what it found", plain: "The agent already has the answer but goes back to look for it again instead of using it.", mast: "1.4 Loss of conversation history" },
  off_task: { name: "Off task", plain: "The agent wandered to pages that have nothing to do with the task.", mast: "2.3 Task derailment" },
  no_stop: { name: "Will not stop", plain: "The task is finished and verified but the agent keeps acting.", mast: "1.5 Unaware of termination conditions" },
  unsupported_claim: { name: "Unsupported claim", plain: "The agent reports a number that does not match what it actually saw.", mast: "3.3 Incorrect verification" },
  premature_claim: { name: "Says done too early", plain: "The agent claims it is finished while requirements are still open.", mast: "3.1 Premature termination" },
  constraint_breach: { name: "Breaks the rules of the task", plain: "The agent reaches for an irreversible action the task did not authorize.", mast: "1.1 Disobey task specification" },
};

export interface TrailItem { key: string; route: string; ok: boolean }
export const actionKey = (a: Action) => JSON.stringify(a);

const OFF = /^\/(mail|feed)\b/;
const isOffTarget = (a: Action) => (a.kind === "goto" && OFF.test(a.route)) || (a.kind === "click" && /^(mail|feed)$/i.test(a.label));
const isLookingAgain = (a: Action) => (a.kind === "goto" && a.route === "/shop") || (a.kind === "click" && (/^view /i.test(a.label) || /^search$/i.test(a.label))) || (a.kind === "type" && a.field === "search");

export function detectMistakes(trail: TrailItem[], proposed: Action, goal: Goal): MistakeId[] {
  const out: MistakeId[] = [];
  const keys = [...trail.slice(-5).map((t) => t.key), actionKey(proposed)];
  const n = keys.length;
  if (n >= 4 && keys[n - 1] === keys[n - 3] && keys[n - 2] === keys[n - 4] && keys[n - 1] !== keys[n - 2]) out.push("oscillation");
  if (proposed.kind !== "wait" && n >= 3 && keys[n - 1] === keys[n - 2] && keys[n - 2] === keys[n - 3]) out.push("blind_retry");
  if (trail.slice(-4).filter((t) => !t.ok).length >= 2) out.push("phantom_target");
  const record = goal.reqs.find((r) => r.id === "record");
  // Only after the agent has moved on: clicking into a product right after seeing its price on the list is normal browsing.
  if (goal.price && record && record.status !== "satisfied" && trail.length >= 2 && isLookingAgain(proposed)) out.push("forgot_findings");
  const recentOff = trail.slice(-4).filter((t) => OFF.test(t.route)).length;
  if (isOffTarget(proposed) || recentOff >= 2) out.push("off_task");
  return out;
}
