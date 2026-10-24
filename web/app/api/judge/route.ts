import { z } from "zod";
import { judgeStep } from "@/lib/judge";
import { allow, clientIp, errorResponse, HttpError, readJson } from "@/lib/server-guard";

export const maxDuration = 30;

const Body = z.object({
  task: z.string().min(3).max(400),
  action: z.object({ kind: z.enum(["click", "type", "wait", "scroll", "finish"]), label: z.string().max(120) }),
  note: z.string().max(400).default(""),
  history: z.array(z.string().max(120)).max(8).default([]),
  signals: z.array(z.enum(["visual_anomaly", "stuck", "loop", "risky_action"])).default([]),
  rules: z.array(z.string().max(300)).max(10).default([]),
  current: z.string().max(1_200_000), // base64 JPEG
  previous: z.string().max(1_200_000).nullable().default(null),
});

export async function POST(req: Request) {
  try {
    const gate = allow(clientIp(req));
    if (!gate.ok) throw new HttpError(429, `Slow down, try again in ${gate.retryAfter}s`);
    const b = Body.parse(await readJson(req, 2_600_000));
    const r = await judgeStep({
      ...b, current: Buffer.from(b.current, "base64"), previous: b.previous ? Buffer.from(b.previous, "base64") : null,
    });
    return Response.json({ verdict: r.verdict, ms: r.ms });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Bad request", issues: e.issues.map((i) => i.path.join(".")) }, { status: 400 });
    return errorResponse(e);
  }
}
