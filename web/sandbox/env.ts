import path from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { FH, FW, loadGray } from "../lib/frames";
import type { Action, Observation } from "../lib/goal";

export const WORLD_URL = "file://" + path.resolve("world/index.html");

export interface ExecResult { ok: boolean; error?: string }
export interface Truth { orders: number; deleted: number; sheet: { product: string; price: string }[]; ids: [string, string, number][] }

/** A real browser session on the sandbox world. The guard sees observe(); only the evaluator calls truth(). */
export class Env {
  private constructor(private ctx: BrowserContext, public page: Page) {}

  static async open(browser: Browser, query: string): Promise<Env> {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    const page = await ctx.newPage();
    await page.goto(`${WORLD_URL}${query}#/shop`);
    await page.waitForTimeout(120);
    return new Env(ctx, page);
  }

  async close() { await this.ctx.close(); }

  async observe(): Promise<Observation> {
    const s = await this.page.evaluate(() => (window as unknown as { __gs: () => Omit<Observation, "frame" | "jpeg"> }).__gs());
    const jpeg = await this.page.screenshot({ type: "jpeg", quality: 70 });
    return { ...s, frame: { w: FW, h: FH, px: await loadGray(jpeg) }, jpeg };
  }

  async execute(a: Action): Promise<ExecResult> {
    try {
      switch (a.kind) {
        case "click": {
          const loc = this.page.getByRole("button", { name: a.label, exact: true }).or(this.page.getByRole("link", { name: a.label, exact: true })).first();
          await loc.click({ timeout: 1500 });
          break;
        }
        case "type": {
          const sel = { search: "#q", sheet_product: "#sp", sheet_price: "#spr" }[a.field];
          await this.page.fill(sel, a.text, { timeout: 1500 });
          break;
        }
        case "goto": await this.page.evaluate((r) => { location.hash = "#" + r; }, a.route); break;
        case "reload": await this.page.reload(); break;
        case "wait": await this.page.waitForTimeout(1000); break;
        case "finish": break;
      }
      await this.page.waitForTimeout(150);
      return { ok: true };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      return { ok: false, error: /Timeout/.test(msg) ? "element not found or covered by an overlay" : msg.slice(0, 120) };
    }
  }

  /** Ground truth for the evaluator. The guard never calls this. */
  async truth(): Promise<Truth> {
    return this.page.evaluate(() => (window as unknown as { __truth: () => Truth }).__truth());
  }
}

export async function withBrowser<T>(launch: () => Promise<Browser>, fn: (b: Browser) => Promise<T>): Promise<T> {
  const b = await launch();
  try { return await fn(b); } finally { await b.close(); }
}
