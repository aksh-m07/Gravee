// The boss answers from the phone. While the hook waits, it serves one small page on the laptop's Wi-Fi address:
// the picture, the question, and a box the boss fills with the Voiskey keyboard. The answer goes back to Claude.
// One page, one secret link, one answer; the server closes as soon as it has an answer or the wait runs out.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

export function lanAddress() {
  const nets = os.networkInterfaces();
  const v4 = (l) => l?.find((a) => a.family === "IPv4" && !a.internal)?.address;
  return v4(nets.en0) ?? v4(Object.values(nets).flat().filter(Boolean)) ?? "127.0.0.1";
}

/** Starts the reply page. Returns { url, answer } where answer resolves to the boss's text, or null if the wait ran out. */
export async function replyPage({ question, cardFile, waitMs }) {
  const token = crypto.randomBytes(12).toString("hex");
  const img = cardFile && fs.existsSync(cardFile) ? `data:image/png;base64,${fs.readFileSync(cardFile).toString("base64")}` : null;
  let resolveAnswer;
  const answer = new Promise((r) => { resolveAnswer = r; });
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude needs you</title>
<style>body{margin:0;background:#0b0d10;color:#e8eef4;font:17px/1.45 -apple-system,Helvetica,sans-serif;padding:16px}h1{font-size:18px;color:#ffb020;letter-spacing:.06em}img{width:100%;border-radius:8px;margin:8px 0}
textarea{width:100%;box-sizing:border-box;min-height:110px;font:17px -apple-system,sans-serif;background:#151a21;color:#e8eef4;border:1px solid #ffb020;border-radius:8px;padding:12px}
button{margin-top:10px;width:100%;min-height:52px;font-size:18px;font-weight:700;background:#0f2a1b;color:#3dff8b;border:1px solid #1d5b3a;border-radius:8px}.hint{color:#8e9aa8;font-size:14px}</style></head>
<body><h1>GRAVEYARD SHIFT · CLAUDE NEEDS YOU</h1>${img ? `<img src="${img}" alt="What Claude wants to do and what is wrong">` : ""}<p>${esc(question)}</p>
<form method="post"><textarea name="text" autofocus placeholder="Tap here and talk with the Voiskey keyboard. Say yes, no, stop, or tell Claude what to do instead."></textarea><button>SEND TO CLAUDE</button></form>
<p class="hint">Your words become guidance. Text alone cannot approve an action. "Stop" blocks it.</p></body></html>`;
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith(`/${token}`)) { res.writeHead(404).end(); return; }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4000) req.destroy(); });
      req.on("end", () => {
        const text = new URLSearchParams(body).get("text")?.trim().slice(0, 600) ?? "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0b0d10;color:#3dff8b;font:20px -apple-system;padding:24px">Sent to Claude: “${esc(text)}”</body>`);
        if (text) resolveAnswer(text);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page);
  });
  await new Promise((r) => server.listen(Number(process.env.GRAVEYARD_REPLY_PORT ?? 0), "0.0.0.0", r));
  const url = `http://${lanAddress()}:${server.address().port}/${token}`;
  const timer = setTimeout(() => resolveAnswer(null), waitMs);
  answer.finally(() => { clearTimeout(timer); server.close(); server.closeAllConnections?.(); });
  return { url, answer };
}

/** What the boss's words mean for the action Claude is waiting on. */
export function readReply(text) {
  const t = text.trim();
  if (/^(?:\/stop|stop(?: everything| now| this task| the task| work)?|cancel|abort|halt|kill it)[.!\s]*$/i.test(t)) return { kind: "stop" };
  if (/^(no|nope|reject|deny)\b/i.test(t) || /^(don'?t|do not)( execute| do (it|this))?[.!\s]*$/i.test(t)) return { kind: "deny" };
  // Preserve conditions verbatim. Free-form text can never create an approval.
  if (!t || /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|approve[d]?|allow it|confirm(ed)?|maybe|not sure)\b/i.test(t) && !/\b(if|after|before|unless|provided|but|instead|not|don'?t|except|first|preserve|keep)\b/i.test(t)) return { kind: "ambiguous" };
  return { kind: "instruct", text: t };
}
