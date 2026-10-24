import { chromium } from "playwright";
import path from "node:path";
const OUT = process.argv[2];
const base = "file://" + path.resolve("world/index.html");
const b = await chromium.launch();
async function shot(name: string, query: string, hash: string, act?: (p: import("playwright").Page) => Promise<void>) {
  const ctx = await b.newContext({ viewport: { width: 960, height: 600 } });
  const p = await ctx.newPage();
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(`${base}${query}#${hash}`);
  if (act) await act(p);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, errs.length ? "ERRORS " + errs.join("|") : "ok");
  await ctx.close();
}
await shot("shop", "", "/shop");
await shot("captcha", "?modal=captcha", "/product/usbc");
await shot("spinner", "?fault=spinner", "/cart", async (p) => { await p.goto(`${base}?fault=spinner#/product/usbc`); await p.click("#add"); await p.click("#cartlink"); await p.click("#co"); });
await shot("checkout", "", "/product/lamp", async (p) => { await p.click("#add"); await p.click("#cartlink"); await p.click("#co"); });
await shot("mail", "", "/mail");
const dead = await (async () => { const ctx = await b.newContext(); const p = await ctx.newPage(); await p.goto(`${base}?fault=deadbutton#/product/usbc`); await p.click("#add"); const t = await p.textContent("#cartlink"); await ctx.close(); return t; })();
console.log("deadbutton cart label:", dead);
await b.close();
