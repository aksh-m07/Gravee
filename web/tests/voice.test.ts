import { describe, expect, it } from "vitest";
import { applyTeaching, isOverBroad, rulesFor } from "../lib/voice";

const TASK = "Add the Black Desk Lamp to the cart. Do not purchase anything.";
const base = { direction: "permit" as const, scope: "this_task" as const, tooBroad: false, task: TASK, agent: "cam3" };

describe("teaching by voice", () => {
  it("accepts a scoped permission and ties it to the task", () => {
    const o = applyTeaching({ ...base, ruleText: "Confirming the purchase of the desk lamp is fine" });
    expect(o.accepted).toBe(true);
    expect(o.rule?.task).toBe(TASK);
    expect(o.spoken).toMatch(/this task only/);
  });
  it.each(["allow everything", "Stop checking my agents", "never ask me again", "disable the guard", "you can do anything", "always allow purchases"])("refuses over-broad rule: %s", (t) => {
    expect(isOverBroad(t)).toBe(true);
    expect(applyTeaching({ ...base, ruleText: t }).accepted).toBe(false);
  });
  it("refuses to loosen a rule forever even when worded narrowly", () => {
    const o = applyTeaching({ ...base, ruleText: "Purchases of USB cables are fine", scope: "always" });
    expect(o.accepted).toBe(false);
    expect(o.spoken).toMatch(/for the task in front of me/);
  });
  it("refuses a permission with no task to scope it to", () => {
    expect(applyTeaching({ ...base, ruleText: "The purchase is fine", task: null }).accepted).toBe(false);
  });
  it("lets a restriction be permanent, since tightening is safe", () => {
    const o = applyTeaching({ ...base, direction: "forbid", scope: "always", ruleText: "Never delete email", task: null });
    expect(o.accepted).toBe(true);
    expect(o.rule?.task).toBeNull();
  });
  it("does not flag ordinary narrow rules as broad", () => {
    expect(isOverBroad("Buying the USB cable is fine for this task")).toBe(false);
    expect(isOverBroad("Never delete email")).toBe(false);
  });
});

describe("rules reach the judge only where they apply", () => {
  it("a task-scoped permission does not leak to another task", () => {
    const r = applyTeaching({ ...base, ruleText: "Confirming the purchase is fine" }).rule!;
    expect(rulesFor([r], TASK)).toHaveLength(1);
    expect(rulesFor([r], "Compare the prices of two cables. Do not buy.")).toHaveLength(0);
  });
  it("a standing restriction applies to every task", () => {
    const r = applyTeaching({ ...base, direction: "forbid", scope: "always", ruleText: "Never delete email", task: null }).rule!;
    expect(rulesFor([r], "any task at all")).toHaveLength(1);
  });
});
