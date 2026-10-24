import { GoogleGenAI } from "@google/genai";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }
  | { type: "audio"; data: string; mime_type: string };

export interface GenRequest {
  model: string;
  system?: string;
  parts: Part[];
  /** JSON schema; when present the model is asked for application/json. */
  schema?: Record<string, unknown>;
}

export type Transport = (req: GenRequest, signal: AbortSignal) => Promise<string>;

export const stats = { calls: 0, cacheHits: 0, retries: 0, errors: 0 };

let transport: Transport | null = null;
export function setTransport(t: Transport | null) { transport = t; }

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (see web/.env.example)");
  return (_client ??= new GoogleGenAI({ apiKey }));
}

const realTransport: Transport = async (req, signal) => {
  const interaction = await client().interactions.create(
    {
      model: req.model,
      input: req.parts as never,
      system_instruction: req.system,
      store: false,
      ...(req.schema ? { response_format: { type: "text", mime_type: "application/json", schema: req.schema } } : {}),
    } as never,
    { signal } as never,
  );
  const text = (interaction as { output_text?: string }).output_text;
  if (!text) throw new Error("Gemini returned no text");
  return text;
};

const cacheDir = () => process.env.GEMINI_CACHE_DIR ?? "";
const keyOf = (req: GenRequest) => {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ m: req.model, s: req.system, sc: req.schema }));
  for (const p of req.parts) h.update(p.type === "text" ? "t:" + p.text : `${p.type}:${p.mime_type}:` + crypto.createHash("sha1").update(p.data).digest("hex"));
  return h.digest("hex");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function throttle() {
  const gap = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 0);
  const wait = lastCall + gap - Date.now();
  lastCall = Math.max(Date.now(), lastCall + gap);
  if (wait > 0) await sleep(wait);
}

/** Text out of Gemini with timeout, retries with backoff, and an optional on-disk cache (GEMINI_CACHE_DIR). */
export async function generateText(req: GenRequest, opts: { timeoutMs?: number; retries?: number; noCache?: boolean } = {}): Promise<{ text: string; cached: boolean; ms: number }> {
  // "a,b,c" means: try model a, and if it fails (quota, timeout) move on to b, then c. Each gets one quick try.
  const models = req.model.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length > 1) {
    let last: unknown;
    for (const model of models) {
      try { return await generateText({ ...req, model }, { ...opts, retries: 0, timeoutMs: Math.min(opts.timeoutMs ?? 20000, 20000) }); }
      catch (e) { last = e; }
    }
    throw last;
  }
  const dir = cacheDir();
  const file = dir && !opts.noCache ? path.join(dir, keyOf(req) + ".json") : "";
  if (file && fs.existsSync(file)) {
    stats.cacheHits++;
    return { text: JSON.parse(fs.readFileSync(file, "utf8")).text, cached: true, ms: 0 };
  }
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45000);
    const t0 = Date.now();
    try {
      await throttle();
      stats.calls++;
      const text = await (transport ?? realTransport)(req, ctl.signal);
      if (file) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ model: req.model, text })); }
      return { text, cached: false, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      stats.errors++;
      const msg = String((e as Error)?.message ?? e);
      const retryable = ctl.signal.aborted || /429|5\d\d|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE|fetch failed|ECONN/i.test(msg);
      if (!retryable || attempt === retries) break;
      stats.retries++;
      await sleep(Math.min(60000, 3000 * 3 ** attempt));
    } finally { clearTimeout(timer); }
  }
  throw new Error(`Gemini call failed: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

/** JSON out of Gemini, validated by `parse`. A malformed answer is retried once with noCache, then thrown. */
export async function generateJson<T>(req: GenRequest, parse: (x: unknown) => T, opts: { timeoutMs?: number; retries?: number } = {}): Promise<{ value: T; cached: boolean; ms: number }> {
  let r = await generateText(req, opts);
  try { return { value: parse(JSON.parse(r.text)), cached: r.cached, ms: r.ms }; }
  catch {
    r = await generateText(req, { ...opts, noCache: true });
    return { value: parse(JSON.parse(r.text)), cached: false, ms: r.ms };
  }
}

/** Speech from Gemini TTS (docs: ai.google.dev/gemini-api/docs/speech-generation). Returns WAV bytes, 24 kHz mono 16-bit. */
export async function synthesizeSpeech(text: string, opts: { model: string; voice?: string; style?: string }): Promise<Buffer> {
  const interaction = await client().interactions.create({
    model: opts.model,
    input: [{ type: "user_input", content: [{ type: "text", text, ...(opts.style ? { annotations: [{ type: "speech_metadata", style: opts.style }] } : {}) }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: opts.voice ?? "Kore" }] },
    store: false,
  } as never);
  const data = (interaction as { output_audio?: { data?: string } }).output_audio?.data;
  if (!data) throw new Error("Gemini TTS returned no audio");
  return Buffer.from(data, "base64");
}
