import { describe, expect, it } from "vitest";
import { HttpError, LIMITS, allow, readJson } from "../lib/server-guard";

describe("rate guard", () => {
  it("allows up to the per-ip limit inside a minute, then refuses, then recovers", () => {
    const t0 = 10_000_000;
    for (let i = 0; i < LIMITS.perIpPerMinute; i++) expect(allow("1.1.1.1", t0 + i).ok).toBe(true);
    expect(allow("1.1.1.1", t0 + 100)).toMatchObject({ ok: false, retryAfter: 60 });
    expect(allow("2.2.2.2", t0 + 100).ok).toBe(true); // other clients unaffected
    expect(allow("1.1.1.1", t0 + 61_000).ok).toBe(true);
  });
});

describe("readJson", () => {
  const req = (body: string, headers: Record<string, string> = {}) => new Request("http://x/api", { method: "POST", body, headers });
  it("parses small bodies", async () => expect(await readJson(req('{"a":1}'), 100)).toEqual({ a: 1 }));
  it("rejects oversize bodies with 413", async () => {
    await expect(readJson(req("x".repeat(500)), 100)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects invalid JSON with 400", async () => {
    await expect(readJson(req("{nope"), 100)).rejects.toBeInstanceOf(HttpError);
  });
});
