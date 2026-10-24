import { chromium } from "playwright";
const OUT = process.argv[2];
const b = await chromium.launch();
const errors: string[] = [];
for (const [name, vp] of [["desk", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await p.goto("http://localhost:3111/"); await p.waitForSelector(".cam img");
  await p.getByRole("button", { name: "Next step" }).click(); await p.getByRole("button", { name: "Next step" }).click();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/ui-${name}-1.png`, fullPage: true });
  await p.goto("http://localhost:3111/proof"); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/ui-${name}-proof.png`, fullPage: true });
  await ctx.close();
}
await b.close();
console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
