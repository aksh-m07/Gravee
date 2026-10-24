import { z } from "zod";
import { allow, clientIp, errorResponse, HttpError, readJson } from "@/lib/server-guard";
import type { LiveEvent } from "@/sandbox/live";

// The live runner drives a real browser (Playwright), which only exists on your own computer. Load it lazily so the hosted
// site can still answer GET with "not available" instead of failing to import it.
const live = () => import("@/sandbox/live");

export const maxDuration = 300;

/** Live runs drive a real browser, so they only work where Chromium is installed: on your own computer, not on a hosted site. */
const hosted = () => !!process.env.VERCEL;
const Body = z.object({
  task: z.string().min(3).max(300),
  fault: z.enum(["none", "pricewall", "promo", "savefail", "popup_ad", "slow", "surprise"]),
  guard: z.enum(["on", "off"]),
  agent: z.enum(["claude", "gemini", "scripted"]),
});

export async function GET() {
  if (hosted()) return Response.json({ available: false, busy: false, claude: false, gemini: false });
  const { liveBusy } = await live();
  return Response.json({ available: true, busy: liveBusy(), claude: !!process.env.ANTHROPIC_API_KEY, gemini: !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) });
}

export async function POST(req: Request) {
  try {
    if (hosted()) throw new HttpError(501, "Live mode needs a real browser, so it runs on your own computer only. The hosted site shows recorded runs.");
    const gate = allow(clientIp(req));
    if (!gate.ok) throw new HttpError(429, `Slow down, try again in ${gate.retryAfter}s`);
    const b = Body.parse(await readJson(req, 4_000));
    if (b.agent === "claude" && !process.env.ANTHROPIC_API_KEY) throw new HttpError(400, "No Anthropic key is set on this server.");
    const { liveBusy, runLive } = await live();
    if (liveBusy()) throw new HttpError(409, "Another run is in progress. Try again in a minute.");
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (e: LiveEvent) => { try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { /* client went away */ } };
        await runLive(b, emit);
        try { controller.close(); } catch { /* already closed */ }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Bad request", issues: e.issues.map((i) => i.path.join(".")) }, { status: 400 });
    return errorResponse(e);
  }
}
