/** Gate settings. Chosen on the val split only (see HACKATHON_STATE.md); the eval split was generated after freezing these. */
export const GATE = { k: 1, percentile: 99 } as const;

/**
 * Models, from https://ai.google.dev/gemini-api/docs/models. Verified live by scripts/check-gemini.mts on 2026-10-24.
 * gemini-3.8-flash is listed but took ~110-140 s per call on the free key (even for a one-word reply); gemini-3.5-flash answered the same
 * vision+JSON request in ~4 s, so it is the default for the guard. Override with GEMINI_JUDGE_MODEL.
 */
export const MODELS = {
  judge: process.env.GEMINI_JUDGE_MODEL ?? "gemini-3.5-flash",
  tts: process.env.GEMINI_TTS_MODEL ?? "gemini-3.8-flash-tts",
  voice: process.env.GEMINI_VOICE_MODEL ?? "gemini-3.5-flash",
} as const;
