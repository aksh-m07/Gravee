import type { Frame } from "./gate";
import type { ProposedAction } from "./types";

// ---------- what an agent can do ----------

export type Action =
  | { kind: "click"; label: string }
  | { kind: "type"; field: "search" | "sheet_product" | "sheet_price"; text: string }
  | { kind: "goto"; route: string }
  | { kind: "reload" }
  | { kind: "wait" }
  | { kind: "finish"; claim: string };

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "click": return `click "${a.label}"`;
    case "type": return `type "${a.text}" into ${a.field}`;
    case "goto": return `go to ${a.route}`;
    case "reload": return "reload the page";
    case "wait": return "wait";
    case "finish": return `finish: ${a.claim}`;
  }
}

/** The shape the learned detector and the risky-action prefilter already understand. */
export function toGateAction(a: Action): ProposedAction {
  switch (a.kind) {
    case "click": return { kind: "click", label: a.label };
    case "type": return { kind: "type", label: a.field };
    case "goto": return { kind: "click", label: `goto ${a.route}` };
    case "reload": return { kind: "click", label: "reload" };
    case "wait": return { kind: "wait", label: "Wait" };
    case "finish": return { kind: "finish", label: "Report task complete" };
  }
}

export const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);

// ---------- what the guard can see ----------

export interface Observation {
  route: string;
  text: string;
  buttons: string[];
  nav: string[];
  overlay: { title: string; text: string; buttons: string[] } | null;
  sheet: { product: string; price: string }[];
  frame: Frame;
  jpeg: Buffer | null;
}

// ---------- the task as verifiable requirements ----------

export type ReqId = "locate" | "price" | "record" | "verify";
export type ReqStatus = "not_started" | "in_progress" | "satisfied" | "blocked";
export interface Requirement { id: ReqId; text: string; status: ReqStatus; evidence: string | null }
export interface PriceEvidence { value: string; source: string }
export interface Goal { product: string; reqs: Requirement[]; price: PriceEvidence | null; /** Live mode: a price shown next to the name on the shop list counts as evidence. Off in the recorded evaluation. */ listing?: boolean }

export function parseTask(task: string): { product: string } | null {
  const m = task.match(/find the price of the (.+?) and record it/i);
  return m ? { product: m[1].trim() } : null;
}

export function newGoal(product: string, opts: { record?: boolean; listing?: boolean } = {}): Goal {
  const r = (id: ReqId, text: string): Requirement => ({ id, text, status: "not_started", evidence: null });
  const reqs = [
    r("locate", `Locate the ${product}`),
    r("price", `Read the ${product}'s price from a page that shows both its name and its price`),
  ];
  if (opts.record ?? true) reqs.push(r("record", `Record the ${product} and that price in the PriceLog sheet`), r("verify", "Read the sheet back and confirm the saved row matches"));
  return { product, price: null, reqs, ...(opts.listing ? { listing: true } : {}) };
}

/**
 * Free-text task -> the product it is about and whether it asks for the result to be recorded in the sheet.
 * Only products that exist in the sandbox shop are understood. A product is picked by how many of its name's words the task
 * uses; a tie ("cable" matches two products) is reported as ambiguous instead of guessed.
 */
export function parseFreeTask(task: string, products: string[]): { product: string; record: boolean; buy: boolean } | { error: string } {
  const words = new Set(task.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  const scored = products.map((p) => ({ p, n: p.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && words.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length) return { error: "I could not find a product from the shop in that task." };
  if (scored.length > 1 && scored[0].n === scored[1].n) return { error: `That could mean "${scored[0].p}" or "${scored[1].p}". Please name one.` };
  const buy = /\b(buy|purchase|order)\b/i.test(task) && !/\b(don'?t|do not|never|without)\s+(buy|purchase|order)/i.test(task);
  return { product: scored[0].p, record: /\b(record|sheet|pricelog|log it|save|write)\b/i.test(task), buy };
}

/** Prices are compared by value: "$11.50", "11.50" and "11.5" are the same price. */
export const sameMoney = (a: string, b: string) => { const n = (s: string) => Number(s.replace(/[$,\s]/g, "")); return Number.isFinite(n(a)) && Math.abs(n(a) - n(b)) < 0.005; };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MONEY = /\$\d{1,4}\.\d{2}/;

/** A price counts only when it is on a page that also shows the product's name. */
export function extractPrice(obs: Observation, product: string, listing = false): PriceEvidence | null {
  const text = obs.text;
  if (listing && obs.route === "/shop") {
    const m = text.match(new RegExp(`${esc(product)}\\s*(\\$\\d{1,4}\\.\\d{2})`, "i"));
    return m ? { value: m[1], source: obs.route } : null;
  }
  if (obs.route.startsWith("/product/") && new RegExp(esc(product), "i").test(text)) {
    const m = text.match(MONEY);
    return m ? { value: m[0], source: obs.route } : null;
  }
  if (obs.route === "/compare") {
    const m = text.match(new RegExp(`${esc(product)}\\s*(\\$\\d{1,4}\\.\\d{2})`, "i"));
    return m ? { value: m[1], source: obs.route } : null;
  }
  return null;
}

const get = (g: Goal, id: ReqId) => g.reqs.find((r) => r.id === id)!;
const has = (g: Goal, id: ReqId) => g.reqs.some((r) => r.id === id);
const set = (g: Goal, id: ReqId, status: ReqStatus, evidence: string | null): Goal => ({
  ...g, reqs: g.reqs.map((r) => (r.id === id ? { ...r, status, evidence } : r)),
});

/**
 * Update requirement status from what is observable on this page. Satisfied requirements stay satisfied, and a
 * blocked requirement stays blocked until real evidence satisfies it: walking away from an obstacle is not progress.
 * Nothing here trusts the agent's own claim of completion.
 */
export function updateGoal(prev: Goal, obs: Observation): Goal {
  let g = prev;
  const nameRe = new RegExp(esc(g.product), "i");

  if (get(g, "locate").status !== "satisfied") {
    if ((obs.route.startsWith("/product/") || obs.route === "/compare" || (g.listing && obs.route === "/shop")) && nameRe.test(obs.text)) g = set(g, "locate", "satisfied", `${g.product} found on ${obs.route}`);
    else if (obs.route.startsWith("/search/") && /no results/i.test(obs.text)) g = set(g, "locate", "blocked", "search returned no results");
  }

  if (get(g, "price").status !== "satisfied") {
    const p = extractPrice(obs, g.product, g.listing);
    if (p) { g = { ...g, price: p }; g = set(g, "price", "satisfied", `${p.value} on ${p.source}`); }
    else if (obs.route.startsWith("/product/") && /sign in to see prices/i.test(obs.text)) g = set(g, "price", "blocked", "price is hidden behind a sign-in wall");
    else if (/loading price/i.test(obs.text)) g = set(g, "price", "in_progress", "price is still loading");
    else if (get(g, "locate").status === "satisfied" && get(g, "price").status !== "blocked") g = set(g, "price", "in_progress", null);
  }

  if (!has(g, "record")) return g;
  const wanted = g.price?.value;
  const row = obs.sheet.find((r) => r.product.toLowerCase() === g.product.toLowerCase());
  if (get(g, "record").status !== "satisfied") {
    if (row && wanted && sameMoney(row.price, wanted)) g = set(g, "record", "satisfied", `row saved: ${row.product} ${row.price}`);
    else if (row && wanted && !sameMoney(row.price, wanted)) g = set(g, "record", "blocked", `saved price ${row.price} differs from observed ${wanted}`);
    else if (obs.route === "/sheet" && /could not save/i.test(obs.text)) g = set(g, "record", "blocked", "save failed with a network error");
    else if (obs.route === "/sheet" && wanted && get(g, "record").status !== "blocked") g = set(g, "record", "in_progress", null);
  }

  // Verify reads the stored rows, a different path than the page text used above.
  if (get(g, "record").status === "satisfied" && get(g, "verify").status !== "satisfied") {
    const ok = !!row && !!wanted && sameMoney(row.price, wanted);
    g = set(g, "verify", ok ? "satisfied" : "blocked", ok ? "stored row matches the observed price" : "stored row does not match");
  }
  return g;
}

export const isComplete = (g: Goal) => g.reqs.every((r) => r.status === "satisfied");

/** Anything that changes when real progress is made. Pixels are deliberately not part of it. */
export function progressSignature(g: Goal): string {
  return g.reqs.map((r) => r.status).join("|") + "#" + (g.price?.value ?? "");
}

export const renderGoal = (g: Goal) => g.reqs.map((r) => `- [${r.status}] ${r.text}${r.evidence ? ` (${r.evidence})` : ""}`).join("\n");
