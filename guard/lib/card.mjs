// The picture the guard sends to the boss's phone: what Claude wants to do (the code or command), the last error, and what the guard thinks is wrong.
// Rendered from text, not a screen capture, so it never leaks anything else that happens to be on the screen.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
function wrap(text, width) {
  const out = [];
  for (const raw of String(text).split("\n")) { let line = raw; while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); } out.push(line); }
  return out;
}

/** Returns the path of a PNG, or null if the image library is unavailable (the text still goes out). */
export async function renderCard({ title, code, error, verdict }) {
  let sharp;
  try { sharp = createRequire(path.join(import.meta.dirname, "..", "..", "web", "package.json"))("sharp"); } catch { return null; }
  const W = 900, PAD = 28;
  const codeLines = wrap(code || "", 78).slice(0, 14);
  const errLines = error ? wrap(`Last error: ${error}`, 80).slice(0, 3) : [];
  const verdictLines = wrap(verdict || "", 64).slice(0, 4);
  const H = 120 + codeLines.length * 24 + 40 + errLines.length * 22 + verdictLines.length * 30 + 60;
  let y = 0; const t = [];
  t.push(`<rect width="${W}" height="${H}" fill="#0b0d10"/>`);
  t.push(`<rect width="${W}" height="64" fill="#b3261e"/><text x="${PAD}" y="42" font-family="Helvetica" font-size="26" font-weight="700" fill="#fff">${esc(title)}</text>`);
  y = 100;
  t.push(`<rect x="${PAD - 10}" y="${y - 26}" width="${W - 2 * PAD + 20}" height="${codeLines.length * 24 + 24}" rx="8" fill="#151a21"/>`);
  for (const l of codeLines) { t.push(`<text x="${PAD}" y="${y}" font-family="Menlo, monospace" font-size="17" fill="#e8eef4" xml:space="preserve">${esc(l)}</text>`); y += 24; }
  y += 30;
  for (const l of errLines) { t.push(`<text x="${PAD}" y="${y}" font-family="Menlo, monospace" font-size="16" fill="#ff8a80">${esc(l)}</text>`); y += 22; }
  y += 14;
  for (const l of verdictLines) { t.push(`<text x="${PAD}" y="${y}" font-family="Helvetica" font-size="22" font-weight="600" fill="#ffb020">${esc(l)}</text>`); y += 30; }
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${t.join("")}</svg>`;
  // Messages can only attach files from folders it may read, so the card lives under the home folder.
  const dir = path.join(os.homedir(), "Pictures", "graveyard-shift"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `card-${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}
