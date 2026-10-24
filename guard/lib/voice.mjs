#!/usr/bin/env node
// Speaks one sentence with Gemini text-to-speech, falling back to the Mac's own voice. Run detached by notify.mjs so the hook never waits on audio.
//   node voice.mjs "<text>"
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const text = (process.argv[2] ?? "").slice(0, 300);
const key = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GRAVEYARD_TTS_MODELS ?? "gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts").split(",");

/** Gemini returns raw 16-bit mono PCM at 24 kHz; wrap it in a WAV header so afplay can play it. */
function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function gemini() {
  if (!key) return false;
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: `Say calmly, like a night guard on a radio: ${text}` }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const part = (await r.json()).candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) continue;
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
      const file = path.join(os.tmpdir(), `graveyard-voice-${Date.now()}.wav`);
      fs.writeFileSync(file, wav(Buffer.from(part.inlineData.data, "base64"), rate));
      execFileSync("afplay", [file]); fs.rmSync(file, { force: true });
      return model;
    } catch { /* try the next model */ }
  }
  return false;
}

const used = await gemini();
if (!used) { try { execFileSync("say", [text]); } catch { /* no voice */ } }
if (process.env.GRAVEYARD_VOICE_REPORT) console.log(used ? `gemini:${used}` : "mac-voice");
