// Live check of the Gemini integration. Prints model availability and one structured-JSON image call. Never prints the key.
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { MODELS } from "../lib/config";
import { generateJson, synthesizeSpeech, stats } from "../lib/gemini";
import { toJudgeJpeg } from "../lib/frames";
import path from "node:path";
import { z } from "zod";

try { process.loadEnvFile(".env.local"); } catch { /* env may come from the shell */ }
const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!key) { console.error("No GEMINI_API_KEY (put it in web/.env.local)"); process.exit(2); }

const ai = new GoogleGenAI({ apiKey: key });
const names: string[] = [];
for await (const m of await ai.models.list()) names.push((m.name ?? "").replace("models/", ""));
for (const want of Object.values(MODELS)) console.log(`model ${want}:`, names.includes(want) ? "listed" : "NOT LISTED");
console.log("available gemini models (first 40):", names.filter((n) => n.startsWith("gemini")).slice(0, 40).join(", "));

const img = await toJudgeJpeg(path.resolve("data/episodes/val/val-blocked-00/s01.jpg"));
const out = await generateJson(
  { model: MODELS.judge, system: "You describe screenshots.", parts: [{ type: "text", text: "What blocks the page? One sentence." }, { type: "image", data: img.toString("base64"), mime_type: "image/jpeg" }],
    schema: { type: "object", properties: { blocker: { type: "string" } }, required: ["blocker"] } },
  (x) => z.object({ blocker: z.string() }).parse(x),
);
console.log("vision+json:", out.value, `${out.ms}ms`);
const wav = await synthesizeSpeech("Camera three. Door closed.", { model: MODELS.tts });
fs.mkdirSync("data/tmp", { recursive: true });
fs.writeFileSync("data/tmp/check.wav", wav);
console.log("tts bytes:", wav.length, "header:", wav.subarray(0, 4).toString());
console.log("stats", stats);
