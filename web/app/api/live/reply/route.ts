import { z } from "zod";
import { allow, clientIp, errorResponse, HttpError, readJson } from "@/lib/server-guard";

const Body = z.object({ id: z.string().uuid(), text: z.string().min(1).max(300) });

/** The boss answers a call from the guard. Typed, or dictated into the box with any dictation tool: the server only sees text. */
export async function POST(req: Request) {
  try {
    if (process.env.VERCEL) throw new HttpError(501, "Live mode runs on your own computer only.");
    const gate = allow(clientIp(req));
    if (!gate.ok) throw new HttpError(429, `Slow down, try again in ${gate.retryAfter}s`);
    const b = Body.parse(await readJson(req, 2_000));
    const { answerBoss } = await import("@/sandbox/live");
    if (!answerBoss(b.id, b.text)) throw new HttpError(404, "Nothing is waiting for an answer.");
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Bad request" }, { status: 400 });
    return errorResponse(e);
  }
}
