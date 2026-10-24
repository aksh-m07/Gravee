/**
 * Protects the free-tier Gemini key once the URL is public. Per-instance and in-memory, so it is a speed bump,
 * not a hard limit: serverless instances each keep their own counters.
 */
const perIp = new Map<string, number[]>();
let globalWindow: number[] = [];

export const LIMITS = { perIpPerMinute: 12, globalPerHour: 400 };

export function allow(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const mine = (perIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  globalWindow = globalWindow.filter((t) => now - t < 3_600_000);
  if (mine.length >= LIMITS.perIpPerMinute) return { ok: false, retryAfter: 60 };
  if (globalWindow.length >= LIMITS.globalPerHour) return { ok: false, retryAfter: 600 };
  mine.push(now); globalWindow.push(now); perIp.set(ip, mine);
  return { ok: true };
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";

/** Read a JSON body but refuse anything larger than maxBytes. */
export async function readJson<T>(req: Request, maxBytes: number): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, "Payload too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Payload too large");
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, "Invalid JSON"); }
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  const msg = String((e as Error)?.message ?? e);
  // Never leak keys or upstream bodies.
  const safe = /GEMINI_API_KEY/.test(msg) ? "Server is missing its Gemini key" : "Upstream model call failed";
  return Response.json({ error: safe }, { status: 502 });
}
