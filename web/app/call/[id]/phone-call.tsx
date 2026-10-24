"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Call = { turns: { from: "guard" | "boss"; text: string }[]; shot: string | null; open: boolean };

/** The boss's phone: the screen the guard is worried about, the conversation, and a box for the Voiskey keyboard. */
export function PhoneCall() {
  const { id } = useParams<{ id: string }>();
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/live/call?id=${id}`, { cache: "no-store" });
        const j = await r.json();
        if (!live) return;
        if (r.ok) { setCall(j); setError(""); } else setError(j.error ?? "This call is no longer available.");
      } catch { if (live) setError("Cannot reach the guard. Is your phone on the same Wi-Fi as the laptop?"); }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    const r = await fetch("/api/live/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text }) });
    setSending(false);
    if (r.ok) setText(""); else setError("The guard is not waiting for an answer right now. Wait for its reply, then answer.");
  }

  return (
    <main className="wrap phone">
      <div className="brand"><span className="rec" aria-hidden />GRAVEYARD SHIFT · THE GUARD IS CALLING</div>
      {error && <div className="outcome" data-ok="false">{error}</div>}
      {call?.shot && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="thumb" style={{ maxWidth: "100%" }} src={`data:image/jpeg;base64,${call.shot}`} alt="The screen the guard is calling about, with its diagnosis on it" />
      )}
      <div className="thread">
        {call?.turns.map((t, i) => <div key={i} className={`bubble ${t.from === "boss" ? "user" : "guardline"}`}>{t.from === "guard" ? <><div className="k">GUARD</div><div className="say-line">{t.text}</div></> : t.text}</div>)}
      </div>
      {call && !call.open && <div className="sys">The call is over. The guard passed your answer to the agent.</div>}
      {call?.open && (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={300} aria-label="Your answer to the guard" placeholder="Tap here and talk with the Voiskey keyboard. Say 'stop' to stop." />
          <button className="btn primary" type="submit" disabled={!text.trim() || sending}>{sending ? "SENDING" : "SEND"}</button>
        </form>
      )}
    </main>
  );
}
