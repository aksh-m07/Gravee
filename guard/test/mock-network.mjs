// Loaded only by test subprocesses, never imported by production hooks.
import fs from "node:fs";
import path from "node:path";
if (process.env.GRAVEYARD_TEST_NETWORK !== "yes") throw new Error("Test fixture requires explicit test environment");
const home = process.env.GRAVEYARD_HOME;
let replied = false;
let conversationStep = 0;
const result = (body) => new Response(JSON.stringify({ ok: true, result: body }), { status: 200 });
globalThis.fetch = async (url, options) => {
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(options.body);
    if (!body.systemInstruction.parts[0].text.includes("Interpret one owner's Telegram")) throw new Error("Only conversational Gemini is mocked here");
    const original = JSON.parse(body.contents[0].parts[0].text).original;
    const question = original.includes("?");
    return new Response(JSON.stringify({ modelVersion: "mock-gemini", candidates: [{ content: { parts: [{ text: JSON.stringify({ kind: question ? "question" : "guidance", confidence: "high", fact_ids: question ? ["coverage"] : [], clarification: "none" }) }] } }] }), { status: 200 });
  }
  if (!url.startsWith("https://api.telegram.org/botTEST/")) throw new Error("No real network access is permitted in this fixture");
  const method = url.split("/").at(-1), body = JSON.parse(options.body);
  if (method === "sendMessage") {
    if (process.env.GRAVEYARD_TEST_CASE === "delivery_failed") throw new Error("mock delivery failure");
    return result({ message_id: 10, chat: { id: 123, type: "private" } });
  }
  if (method === "answerCallbackQuery" || method === "editMessageText") {
    if (method === "editMessageText" && process.env.GRAVEYARD_TEST_CASE === "approve_at_deadline") await new Promise((r) => setTimeout(r, 150));
    return result(true);
  }
  if (method !== "getUpdates") throw new Error("Unexpected API method");
  const active = JSON.parse(fs.readFileSync(path.join(home, "active.json")));
  const d = JSON.parse(fs.readFileSync(path.join(home, "decisions", `${active.id}.json`)));
  if (process.env.GRAVEYARD_TEST_CASE === "conversation") {
    if (body.timeout === 0) return result([]);
    const step = conversationStep++;
    return result([{ update_id: step + 1, message: { from: { id: 123 }, chat: { id: 123, type: "private" }, reply_to_message: { message_id: 10 },
      text: step === 0 ? "What exactly failed, and did anything change?" : "Stop reinstalling it. Check the required Node version first. Keep dependency files unchanged." } }]);
  }
  if (replied || process.env.GRAVEYARD_TEST_CASE === "timeout") { await new Promise((r) => setTimeout(r, 10)); return result([]); }
  replied = true;
  if (process.env.GRAVEYARD_TEST_CASE === "guidance") return result([{ update_id: 1, message: { from: { id: 123 }, chat: { id: 123, type: "private" }, reply_to_message: { message_id: 10 }, text: "Yes if the tests pass." } }]);
  const action = { approve: "a", approve_at_deadline: "a", deny: "r", stop: "s" }[process.env.GRAVEYARD_TEST_CASE];
  return result([{ update_id: 1, callback_query: { id: "cb", from: { id: 123 }, message: { message_id: 10, chat: { id: 123, type: "private" } }, data: `gs:${action}:${d.id}` } }]);
};
