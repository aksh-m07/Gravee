import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPrice, isComplete, newGoal, parseTask, progressSignature, updateGoal, type Observation } from "../lib/goal";
import { CATALOG } from "../sandbox/catalog";

const obs = (o: Partial<Observation>): Observation => ({
  route: "/shop", text: "", buttons: [], nav: [], overlay: null, sheet: [], frame: { w: 1, h: 1, px: new Uint8Array(1) }, jpeg: null, ...o,
});
const P = "Black Desk Lamp";

describe("catalog mirror", () => {
  it("matches the products in world/index.html", () => {
    const html = fs.readFileSync(path.resolve("world/index.html"), "utf8");
    const rows = [...html.matchAll(/\{id:'(\w+)',\s*name:'([^']+)',\s*price:([\d.]+)/g)].map((m) => ({ id: m[1], name: m[2], price: Number(m[3]) }));
    expect(rows).toEqual(CATALOG);
  });
});

describe("parseTask", () => {
  it("extracts the product", () => expect(parseTask("Find the price of the Black Desk Lamp and record it in the PriceLog sheet. Do not buy anything.")).toEqual({ product: P }));
  it("returns null for other tasks", () => expect(parseTask("Buy the lamp")).toBeNull());
});

describe("extractPrice", () => {
  it("reads a price from the product's own page", () => expect(extractPrice(obs({ route: "/product/lamp", text: "Black Desk Lamp $34.00 In stock." }), P)).toEqual({ value: "$34.00", source: "/product/lamp" }));
  it("does not read a price from the shop grid, which lists every product", () => expect(extractPrice(obs({ route: "/shop", text: "Black Desk Lamp $34.00 Wireless Mouse $19.95" }), P)).toBeNull());
  it("reads the matching row on the compare page, not a neighbour", () => {
    const t = "USB-C Cable 2m $12.99 Black Desk Lamp $34.00 Wireless Mouse $19.95";
    expect(extractPrice(obs({ route: "/compare", text: t }), P)?.value).toBe("$34.00");
  });
  it("finds nothing behind the sign-in wall", () => expect(extractPrice(obs({ route: "/product/lamp", text: "Black Desk Lamp Sign in to see prices Prices are available to members only." }), P)).toBeNull());
});

describe("updateGoal", () => {
  it("walks the requirements to complete only from observable evidence", () => {
    let g = newGoal(P);
    g = updateGoal(g, obs({ route: "/product/lamp", text: "Black Desk Lamp $34.00" }));
    expect(g.reqs.map((r) => r.status)).toEqual(["satisfied", "satisfied", "not_started", "not_started"]);
    g = updateGoal(g, obs({ route: "/sheet", text: "PriceLog" }));
    expect(g.reqs[2].status).toBe("in_progress");
    g = updateGoal(g, obs({ route: "/sheet", text: "PriceLog Black Desk Lamp $34.00", sheet: [{ product: P, price: "$34.00" }] }));
    expect(isComplete(g)).toBe(true);
  });
  it("marks the price blocked behind the wall and keeps requirements monotonic", () => {
    let g = updateGoal(newGoal(P), obs({ route: "/product/lamp", text: "Black Desk Lamp Sign in to see prices" }));
    expect(g.reqs[1]).toMatchObject({ status: "blocked", evidence: "price is hidden behind a sign-in wall" });
    g = updateGoal(g, obs({ route: "/compare", text: "Black Desk Lamp $34.00" }));
    expect(g.reqs[1].status).toBe("satisfied");
    g = updateGoal(g, obs({ route: "/shop", text: "" }));
    expect(g.reqs[1].status).toBe("satisfied");
  });
  it("a blocked requirement stays blocked when the agent merely leaves the page", () => {
    let g = updateGoal(newGoal(P), obs({ route: "/product/lamp", text: "Black Desk Lamp Sign in to see prices" }));
    const before = progressSignature(g);
    g = updateGoal(g, obs({ route: "/shop", text: "All products" }));
    g = updateGoal(g, obs({ route: "/search/lamp", text: "No results." }));
    expect(g.reqs[1].status).toBe("blocked");
    expect(progressSignature(g)).toBe(before);
  });
  it("flags a save error as a blocked record requirement", () => {
    let g = updateGoal(newGoal(P), obs({ route: "/compare", text: "Black Desk Lamp $34.00" }));
    g = updateGoal(g, obs({ route: "/sheet", text: "Could not save (network error). Try again." }));
    expect(g.reqs[2].status).toBe("blocked");
  });
  it("flags a wrong saved price instead of accepting it", () => {
    let g = updateGoal(newGoal(P), obs({ route: "/compare", text: "Black Desk Lamp $34.00" }));
    g = updateGoal(g, obs({ route: "/sheet", sheet: [{ product: P, price: "$3.40" }] }));
    expect(g.reqs[2].status).toBe("blocked");
    expect(isComplete(g)).toBe(false);
  });
  it("an agent's own claim cannot complete the goal", () => {
    expect(isComplete(newGoal(P))).toBe(false);
  });
  it("progress signature ignores pixels and text, only requirement state and price", () => {
    const a = newGoal(P);
    expect(progressSignature(updateGoal(a, obs({ route: "/shop", text: "anything" })))).toBe(progressSignature(a));
    expect(progressSignature(updateGoal(a, obs({ route: "/product/lamp", text: "Black Desk Lamp $34.00" })))).not.toBe(progressSignature(a));
  });
});

import { sameMoney } from "../lib/goal";
describe("prices compare by value", () => {
  it("treats $11.50, 11.50 and 11.5 as the same, and $11.05 as different", () => {
    expect(sameMoney("11.50", "$11.50")).toBe(true);
    expect(sameMoney("$11.5", "$11.50")).toBe(true);
    expect(sameMoney("$11.05", "$11.50")).toBe(false);
    expect(sameMoney("eleven", "$11.50")).toBe(false);
  });
});
