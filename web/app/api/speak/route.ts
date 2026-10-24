import { z } from "zod";
import { synthesizeSpeech } from "@/lib/gemini";
import { MODELS } from "@/lib/config";
import { allow, clientIp, errorResponse, HttpError, readJson } from "@/lib/server-guard";

export const maxDuration = 30;

const Body = z.object({ text: z.string().min(1).max(400) });
const cache = new Map<string, Buffer>();

/** Speech for the guard's voice. Clients fall back to the browser voice on any non-200, and say so. */
export async function POST(req: Request) {
  try {
    const { text } = Body.parse(await readJson(req, 4_000));
    let wav = cache.get(text);
    if (!wav) {
      const gate = allow(clientIp(req));
      if (!gate.ok) throw new HttpError(429, `Slow down, try again in ${gate.retryAfter}s`);
      wav = await synthesizeSpeech(text, { model: MODELS.tts, voice: "Kore" });
      if (cache.size > 100) cache.delete(cache.keys().next().value as string);
      cache.set(text, wav);
    }
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "private, max-age=3600" } });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Bad request" }, { status: 400 });
    return errorResponse(e);
  }
}
