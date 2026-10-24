import { isRiskyAction } from "./gate";
import { toGateAction, type Action, type Observation } from "./goal";

/** What the guard is allowed to do on the agent's behalf. Anything else is refused no matter who proposes it. */
export type RecoveryAction =
  | { kind: "dismiss_overlay"; label: string }
  | { kind: "navigate"; route: string }
  | { kind: "retry_last" }
  | { kind: "reload" }
  /** Finish the remaining sheet step itself, using only the product and the price the guard already observed. */
  | { kind: "record_from_evidence" };

export interface RecoveryPolicy {
  allowedRoutes: string[];
  maxRecoveries: number;
  /** Labels the deterministic guard knows how to dismiss. Gemini may pick any visible, non-risky overlay button. */
  dismissLexicon: string[];
}

export const DEFAULT_RECOVERY: RecoveryPolicy = {
  allowedRoutes: ["/shop", "/compare", "/sheet"],
  maxRecoveries: 3,
  dismissLexicon: ["close", "accept", "no thanks", "dismiss", "×"],
};

export interface RecoveryState {
  done: RecoveryAction[];
  failed: string[]; // keys of recoveries that were executed and did not help
  lastClick: string | null;
}

export const recoveryKey = (r: RecoveryAction) => JSON.stringify(r);

/** What the guard has itself observed. Typed values are only ever drawn from here. */
export interface Evidence { product: string; price: string | null; recordOpen: boolean }

/** `then` holds the follow-up steps of a multi-step recovery; each is re-checked by the executor against a fresh observation. */
export type Check = { ok: true; action: Action; then?: Action[] } | { ok: false; why: string };

/**
 * Turn a proposed recovery into a concrete executor action, or refuse it.
 * Called by the guard when it chooses a recovery and again by the runner right before execution, against the fresh observation.
 */
export function validateRecovery(r: RecoveryAction, obs: Observation, st: RecoveryState, policy: RecoveryPolicy = DEFAULT_RECOVERY, ev?: Evidence): Check {
  if (st.done.length >= policy.maxRecoveries) return { ok: false, why: "recovery budget used up" };
  if (st.failed.includes(recoveryKey(r))) return { ok: false, why: "that recovery already failed" };
  switch (r.kind) {
    case "dismiss_overlay": {
      if (!obs.overlay) return { ok: false, why: "no overlay is showing" };
      if (!obs.overlay.buttons.includes(r.label)) return { ok: false, why: `"${r.label}" is not a button on the overlay` };
      if (isRiskyAction({ kind: "click", label: r.label })) return { ok: false, why: `"${r.label}" looks irreversible` };
      return { ok: true, action: { kind: "click", label: r.label } };
    }
    case "navigate": {
      if (!policy.allowedRoutes.includes(r.route)) return { ok: false, why: `route ${r.route} is not on the allowlist` };
      if (r.route === obs.route) return { ok: false, why: "already on that page" };
      return { ok: true, action: { kind: "goto", route: r.route } };
    }
    case "retry_last": {
      const label = st.lastClick;
      if (!label) return { ok: false, why: "nothing to retry" };
      if (isRiskyAction({ kind: "click", label })) return { ok: false, why: "will not retry an irreversible action" };
      if (!obs.buttons.includes(label)) return { ok: false, why: `"${label}" is not on this page` };
      return { ok: true, action: { kind: "click", label } };
    }
    case "reload": return st.done.some((d) => d.kind === "reload") ? { ok: false, why: "already reloaded once" } : { ok: true, action: { kind: "reload" } };
    case "record_from_evidence": {
      if (!ev?.price) return { ok: false, why: "no observed price to record" };
      if (!ev.recordOpen) return { ok: false, why: "the sheet step is already done" };
      if (!policy.allowedRoutes.includes("/sheet")) return { ok: false, why: "/sheet is not on the allowlist" };
      const steps: Action[] = [
        { kind: "type", field: "sheet_product", text: ev.product },
        { kind: "type", field: "sheet_price", text: ev.price },
        { kind: "click", label: "Save row" },
      ];
      return obs.route === "/sheet" ? { ok: true, action: steps[0], then: steps.slice(1) } : { ok: true, action: { kind: "goto", route: "/sheet" }, then: steps };
    }
  }
}

/** True when an action is something the policy would never allow a recovery to do. Used as a belt-and-braces check in the executor. */
export const isForbiddenForRecovery = (a: Action) => a.kind === "finish" || isRiskyAction(toGateAction(a));

/**
 * The executor's own gate, independent of whoever chose the action. Checked against the fresh observation
 * immediately before a guard-chosen action runs.
 */
export function executorAllows(a: Action, obs: Observation, policy: RecoveryPolicy = DEFAULT_RECOVERY, ev?: Evidence): Check {
  if (isForbiddenForRecovery(a)) return { ok: false, why: "never executed on the guard's behalf" };
  if (a.kind === "type") {
    // Text goes only into the sheet, and only values the guard itself observed.
    if (obs.route !== "/sheet") return { ok: false, why: "typing is allowed only on the sheet" };
    const want = a.field === "sheet_product" ? ev?.product : a.field === "sheet_price" ? ev?.price : null;
    return want && a.text === want ? { ok: true, action: a } : { ok: false, why: `"${a.text}" is not a value the guard observed` };
  }
  if (a.kind === "goto") return policy.allowedRoutes.includes(a.route) ? { ok: true, action: a } : { ok: false, why: `route ${a.route} is not allowlisted` };
  if (a.kind === "click") return obs.buttons.includes(a.label) || obs.overlay?.buttons.includes(a.label) ? { ok: true, action: a } : { ok: false, why: `"${a.label}" is not visible` };
  if (a.kind === "reload") return { ok: true, action: a };
  return { ok: false, why: `${a.kind} is not a recovery action` };
}
