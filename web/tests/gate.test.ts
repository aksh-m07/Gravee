import { describe, expect, it } from "vitest";
import { changedFraction, extractFeatures, fitGate, GateTracker, isRiskyAction, scoreFeatures, type Frame } from "../lib/gate";

const W = 96, H = 60;
const frame = (fill: number, box?: { x: number; y: number; w: number; h: number; v: number }): Frame => {
  const px = new Uint8Array(W * H).fill(fill);
  if (box) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) px[y * W + x] = box.v;
  return { w: W, h: H, px };
};

describe("changedFraction", () => {
  it("is 0 for identical frames and 1 when everything changed", () => {
    expect(changedFraction(frame(100), frame(100))).toBe(0);
    expect(changedFraction(frame(100), frame(200))).toBe(1);
  });
  it("ignores sub-threshold noise", () => {
    expect(changedFraction(frame(100), frame(110))).toBe(0);
  });
});

describe("gate model", () => {
  const normal = (seed: number) => {
    const a = frame(200), b = frame(200, { x: 10 + seed, y: 10, w: 10, h: 10, v: 120 });
    return [extractFeatures(null, a), extractFeatures(a, b)];
  };
  const model = fitGate([0, 1, 2, 3, 4, 5].map(normal), { k: 1, percentile: 99 });
  it("scores a normal-looking vector low and a dark full-screen overlay high", () => {
    const base = frame(200);
    const ok = scoreFeatures(model, extractFeatures(base, frame(200, { x: 12, y: 10, w: 10, h: 10, v: 120 })));
    const odd = scoreFeatures(model, extractFeatures(base, frame(40)));
    expect(odd).toBeGreaterThan(ok);
    expect(odd).toBeGreaterThan(model.threshold);
  });
  it("raises loop after 3 still steps on the same click and stuck for waits", () => {
    const t = new GateTracker(model);
    const same = frame(200), click = { kind: "click" as const, label: "Add to cart" };
    const sig = [0, 1, 2, 3, 4].map(() => t.observe(same, click).signals);
    expect(sig[0]).not.toContain("loop");
    expect(sig[3]).toContain("loop");
    const t2 = new GateTracker(model);
    const w = [0, 1, 2, 3, 4].map(() => t2.observe(same, { kind: "wait", label: "Wait" }).signals);
    expect(w[3]).toContain("stuck");
  });
  it("a changing screen resets the no-progress count", () => {
    const t = new GateTracker(model);
    const c = { kind: "click" as const, label: "Next" };
    t.observe(frame(200), c); t.observe(frame(200), c); t.observe(frame(200), c);
    const r = t.observe(frame(90), c);
    expect(r.signals).not.toContain("loop");
    expect(r.stillRun).toBe(0);
  });
});

describe("risky action prefilter", () => {
  it.each(["Confirm purchase $79.00", "Delete all", "Send", "Place order", "Submit"])("flags %s", (l) => expect(isRiskyAction({ kind: "click", label: l })).toBe(true));
  it.each(["Add to cart", "View Black Desk Lamp", "Search mail", "Close", "Open"])("passes %s", (l) => expect(isRiskyAction({ kind: "click", label: l })).toBe(false));
});
