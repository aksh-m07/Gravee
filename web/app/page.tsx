"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Decision = { type: string; reason: string; source: string; signals: string[]; recovery?: { kind: string; label?: string; route?: string };
  assessment?: { assessment: string; goal_progress: string; unsatisfied_requirements: string[]; evidence: string[]; proposed_decision: string; confidence: string; reason: string; recovery_action: unknown };
  gemini?: { ms: number; cached: boolean };
  briefing?: { headline: string; confusion: string; done: string[]; stuckOn: string; tried: string[]; question: string; options: string[]; defaultIfSilent: string; spoken: string } };
type Step = { t: number; route: string; proposed: string; decision: Decision; executed: { by: string; action: string; ok: boolean; error?: string } | null; goal: string[]; shot?: string; verification?: { helped: boolean } };
type Outcome = { completed: boolean; harmful: boolean; falseClaim: boolean; safeStop: boolean; success: boolean };
type Trace = { id: string; end: string; steps: Step[]; outcome: Outcome };
type RunRef = { mode: string; id: string; path: string; end: string; outcome: Outcome };
type Index = { split: string; generatedAt: string; guardMode: string; scenarios: { kind: string; title: string; blurb: string; task: string; runs: { unguarded: RunRef; guard: RunRef } }[] };

const REQ = ["Locate", "Price", "Record", "Verify"];

function outcomeText(o: Outcome, end: string): { text: string; ok: "true" | "false" | "safe" } {
  if (o.harmful) return { text: "Bought something it was told not to buy", ok: "false" };
  if (o.completed) return { text: "Price found, saved and verified", ok: "true" };
  if (o.falseClaim) return { text: "Claimed success. Nothing was recorded.", ok: "false" };
  if (o.safeStop) return { text: end === "ask_human" ? "Paused and handed to a human. Nothing harmful happened." : "Stopped safely.", ok: "safe" };
  return { text: "Ran out of steps", ok: "false" };
}

function Panel({ label, run, trace, t, guard }: { label: string; run: RunRef; trace: Trace | null; t: number; guard: boolean }) {
  if (!trace) return <section className={`cam ${guard ? "guard" : ""}`}><div className="camhead"><span>{label}</span></div><div className="screen" /></section>;
  const last = trace.steps.length - 1;
  const i = Math.min(t, last), ended = t > last;
  const s = trace.steps[i];
  const d = s.decision;
  const out = outcomeText(trace.outcome, trace.end);
  const none = !guard;
  const badge = none ? "NONE" : d.type;
  return (
    <section className={`cam ${guard ? "guard" : ""}`} aria-label={label}>
      <div className="camhead"><span>{guard ? "CAM 02 · GRAVEYARD SHIFT" : "CAM 01 · NO GUARD"}</span><span className="who">STEP {String(i + 1).padStart(2, "0")}/{String(trace.steps.length).padStart(2, "0")}</span></div>
      <div className="screen">
        {s.shot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/replay/${guard ? "guard" : "unguarded"}/${trace.id}/${s.shot}`} alt={`Browser screen at step ${i + 1}, ${s.route}`} />
        )}
        {ended && <div className="ended">RUN ENDED</div>}
      </div>
      <div className="reqs" aria-label="Task requirements">{REQ.map((r, k) => <span key={r} className="req" data-s={s.goal[k]}>{r}: {s.goal[k].replace("_", " ")}</span>)}</div>
      <div className="body" aria-live="polite">
        <div className="line"><span className="k">AGENT WANTS TO</span>{s.proposed}</div>
        <div className="line"><span className="badge" data-d={badge}>{none ? "EXECUTES EVERYTHING" : d.type.replace("_", " ")}</span> {!none && <span className="muted"> {d.reason}</span>}</div>
        {!none && d.signals.length > 0 && <div className="line"><span className="k">DETECTORS</span>{d.signals.join(", ")}</div>}
        {d.assessment && (
          <div className="gem">
            <h4>GEMINI ASSESSMENT {d.gemini?.cached ? "· replayed from cache" : ""}</h4>
            <div><b>{d.assessment.assessment}</b>. {d.assessment.goal_progress}</div>
            {d.assessment.evidence.length > 0 && <ul>{d.assessment.evidence.slice(0, 3).map((e, k) => <li key={k}>{e}</li>)}</ul>}
            <div className="row"><span>proposes: {d.assessment.proposed_decision}{d.recovery ? ` → ${d.recovery.kind}${d.recovery.route ? " " + d.recovery.route : d.recovery.label ? ` "${d.recovery.label}"` : ""}` : ""}</span><span>self-reported confidence: {d.assessment.confidence}{d.gemini ? ` · ${d.gemini.ms} ms` : ""}</span></div>
          </div>
        )}
        {d.briefing && (
          <div className="brief">
            <h4>CALLING THE BOSS · {d.briefing.confusion.replace("_", " ")}</h4>
            <div className="say">&ldquo;{d.briefing.spoken}&rdquo;</div>
            <div className="row"><span>stuck on: {d.briefing.stuckOn}</span></div>
            {d.briefing.tried.length > 0 && <div className="row"><span>tried: {d.briefing.tried.join("; ")}</span></div>}
            <div className="row"><span>{d.briefing.options.join("  ·  ")}</span><span>no answer = keep stopped</span></div>
          </div>
        )}
        {s.executed && <div className="line"><span className="k">{s.executed.by === "guard" ? "GUARD DID" : "EXECUTED"}</span>{s.executed.action}{s.executed.ok ? "" : ` (failed: ${s.executed.error})`}</div>}
        {s.verification && <div className="line"><span className="k">VERIFIED</span>{s.verification.helped ? "the page state improved" : "nothing improved, so this recovery is marked failed"}</div>}
      </div>
      <div className="ticks" aria-hidden>{trace.steps.map((x) => <span key={x.t} className={`tick ${x.t === i && !ended ? "cur" : ""}`} data-d={none ? (x.executed ? "ALLOW" : "NONE") : x.decision.type} />)}</div>
      {(ended || t === last) && <div className="outcome" data-ok={out.ok}>{out.text}</div>}
      <span hidden>{run.id}</span>
    </section>
  );
}

function Replay({ sc, guardLabel }: { sc: Index["scenarios"][number]; guardLabel: string }) {
  const [traces, setTraces] = useState<{ u: Trace; g: Trace } | null>(null);
  const [failed, setFailed] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetch(sc.runs.unguarded.path).then((r) => r.json()), fetch(sc.runs.guard.path).then((r) => r.json())])
      .then(([u, g]) => { if (live) setTraces({ u, g }); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [sc]);
  const max = useMemo(() => (traces ? Math.max(traces.u.steps.length, traces.g.steps.length) : 0), [traces]);

  const stop = useCallback(() => { if (timer.current) clearInterval(timer.current); timer.current = null; setPlaying(false); }, []);
  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => setT((x) => { if (x >= max) { stop(); return x; } return x + 1; }), 1300);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [playing, max, stop]);

  return (
    <>
      <div className="task"><div className="lbl">THE TASK · {sc.title.toUpperCase()}</div><p>{sc.task}</p><p className="muted" style={{ fontSize: 14 }}>{sc.blurb}</p></div>
      {failed && <p className="err">Could not load this run.</p>}
      <div className="controls">
        <button className="btn primary" onClick={() => { if (playing) stop(); else { if (t >= max) setT(0); setPlaying(true); } }}>{playing ? "PAUSE" : t >= max && max > 0 ? "REPLAY" : "PLAY"}</button>
        <button className="btn" onClick={() => { stop(); setT((x) => Math.max(0, x - 1)); }} aria-label="Previous step">◀</button>
        <button className="btn" onClick={() => { stop(); setT((x) => Math.min(max, x + 1)); }} aria-label="Next step">▶</button>
        <input type="range" min={0} max={Math.max(0, max)} value={t} onChange={(e) => { stop(); setT(Number(e.target.value)); }} aria-label="Step" />
      </div>
      <div className="split">
        <Panel label="Unguarded agent" run={sc.runs.unguarded} trace={traces?.u ?? null} t={t} guard={false} />
        <Panel label={guardLabel} run={sc.runs.guard} trace={traces?.g ?? null} t={t} guard />
      </div>
    </>
  );
}

export default function Home() {
  const [index, setIndex] = useState<Index | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  useEffect(() => { fetch("/replay/index.json").then((r) => r.json()).then(setIndex).catch(() => setErr("Could not load the recorded runs.")); }, []);
  const sc = index?.scenarios[sel];
  const guardLabel = index?.guardMode === "guard_gemini" ? "Guard with Gemini" : "Rule-based guard (no Gemini in this recording)";

  return (
    <main className="wrap">
      <div className="top">
        <div className="brand"><span className="rec" aria-hidden />GRAVEYARD SHIFT</div>
        <nav className="nav"><Link href="/">Console</Link><Link href="/chat">Live chat</Link><Link href="/proof">Proof</Link></nav>
      </div>
      <h1>The night guard that knows when your AI agent has stopped making progress.</h1>
      <p className="sub">Your agent is still working. Graveyard Shift knows it&apos;s getting nowhere. It tracks the task&apos;s requirements, stops the next unjustified action before it runs, picks a safe recovery, and checks that it actually worked.</p>
      <div className="chips">
        <span className="chip">recorded runs of a scripted agent in a sandbox</span>
        <span className="chip">{guardLabel}</span>
        {index && <span className="chip">split: {index.split}</span>}
      </div>

      {err && <p className="err">{err}</p>}
      {index && (
        <>
          <div className="tabs" role="tablist" aria-label="Scenarios">
            {index.scenarios.map((s, k) => (
              <button key={s.kind} role="tab" aria-selected={k === sel} className="tab" onClick={() => setSel(k)}>
                <b>{s.title}</b><span>{k === 0 ? "PRIMARY" : "FALLBACK"} · {s.kind}</span>
              </button>
            ))}
          </div>
          {sc && <Replay key={sc.kind} sc={sc} guardLabel={guardLabel} />}
        </>
      )}
    </main>
  );
}
