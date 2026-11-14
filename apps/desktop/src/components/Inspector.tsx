import { nodeInfo, STEP_TITLES } from "../state/explain";
import type { NodeId, PipelineView } from "../state/pipeline";
import type { TurnState } from "../state/turn";

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** What each stage did, in words, with the real data that passed through it. */
export default function Inspector({ node, view, turn }: { node: NodeId; view: PipelineView; turn: TurnState | null }) {
  const info = nodeInfo(node, view.mode);
  const n = view.nodes[node];
  return (
    <div className="inspector">
      <div className="inspector__head">
        <h3>{info.label}</h3>
        <span className={`pill pill--${info.where === "cloud" ? "cloud" : "laptop"}`}>{info.where === "cloud" ? "runs in the cloud" : "runs on this laptop"}</span>
        <span className={`pill pill--status pill--${n.status}`}>{n.status === "waiting" ? "waiting for you" : n.status === "skipped" ? "not needed for this question" : n.status}</span>
      </div>
      <p>{info.what}</p>
      <p className="muted">
        <strong>Why: </strong>
        {info.why}
      </p>
      <p className="muted">
        <strong>What it can see: </strong>
        {info.data}
      </p>
      {n.detail && (
        <p className="inspector__now">
          <strong>This question: </strong>
          {n.detail}
          {n.ms !== undefined ? ` (${fmtMs(n.ms)})` : ""}
        </p>
      )}
      {turn && <NodeData node={node} turn={turn} />}
    </div>
  );
}

function NodeData({ node, turn }: { node: NodeId; turn: TurnState }) {
  const step = (name: string) => turn.steps.filter((s) => s.step === name);
  if (node === "prep") {
    const s = step("schema").at(-1);
    const tables = (s?.data?.tables as { table: string; score: number; columns: string[] }[] | undefined) ?? [];
    const needed = new Set((s?.data?.tablesNeeded as string[] | undefined) ?? []);
    const passages = step("documents").at(-1)?.data?.passages as { ref: string; score: number; snippet: string }[] | undefined;
    if (passages)
      return (
        <div className="kv">
          <h4>Best passages (BM25 score)</h4>
          {passages.map((p, i) => (
            <div key={i} className="kv__row">
              <span className="chip chip--src">{p.ref}</span>
              <span className="muted">score {p.score}</span>
              <span className="kv__text">“{p.snippet}”</span>
            </div>
          ))}
        </div>
      );
    return tables.length ? (
      <div className="kv">
        <h4>Tables scored for this question</h4>
        {tables.map((t) => (
          <div key={t.table} className="kv__row">
            <span className={`chip ${needed.has(t.table) ? "chip--on" : ""}`}>{t.table}</span>
            <span className="muted">relevance {t.score}</span>
            <span className="kv__text">{t.columns.join(", ")}</span>
          </div>
        ))}
      </div>
    ) : null;
  }
  if (node === "router") {
    const eff = step("effort").at(-1)?.data as { level: string; score: number; mediumAt: number; highAt: number; signals: { name: string; points: number; note: string }[] } | undefined;
    const laya = step("decision-model").at(-1);
    return (
      <div className="kv">
        {eff && (
          <>
            <h4>Effort estimate</h4>
            <div className="kv__row">
              <span className={`chip ${eff.level === "high" ? "chip--remote" : "chip--local"}`}>{eff.level} effort</span>
              <span className="muted">
                score {eff.score} (medium from {eff.mediumAt}, high from {eff.highAt})
              </span>
              <span className="kv__text">
                {eff.level === "high" ? "High effort goes straight to the remote model." : eff.level === "medium" ? "Medium effort is tried locally and must be reproduced by a second generation." : "Low effort is tried locally with one generation and cheap checks."}
              </span>
            </div>
            {eff.signals.length === 0 && <div className="muted">No signals: a plain single-table lookup.</div>}
            {eff.signals.map((x) => (
              <div key={x.name} className="kv__row">
                <span className="chip">+{x.points}</span>
                <span className="kv__text" style={{ flexBasis: "auto" }}>{x.note}</span>
              </div>
            ))}
          </>
        )}
        {laya && (
          <>
            <h4>Decision model (Laya)</h4>
            {laya.status === "error" ? (
              <div className="muted">{laya.detail}</div>
            ) : laya.data ? (
              <div className="stats">
                {typeof laya.data.needsReasoning === "number" && <Stat k="needs reasoning" v={`${Math.round(laya.data.needsReasoning * 100)}%`} />}
                {typeof laya.data.multiStep === "number" && <Stat k="several steps" v={`${Math.round(laya.data.multiStep * 100)}%`} />}
                {typeof laya.data.ambiguous === "number" && <Stat k="vague" v={`${Math.round(laya.data.ambiguous * 100)}%`} />}
              </div>
            ) : (
              <div className="muted">{laya.detail}</div>
            )}
            <div className="muted">Only confidence above 50% adds to the effort score; an unsure model changes nothing.</div>
          </>
        )}
        <h4>Decision</h4>
        {turn.routes.length === 0 && <div className="muted">Not decided yet.</div>}
        {turn.routes.map((r, i) => (
          <div key={i} className="kv__row">
            <span className={`chip ${r.route === "remote" ? "chip--remote" : "chip--local"}`}>{r.route}</span>
            <span className="muted">layer {r.layer}</span>
            <span className="kv__text">{r.reasons.join("; ") || "—"}</span>
          </div>
        ))}
        {step("classify").at(-1)?.data && (
          <div className="muted">Question type: {String(step("classify").at(-1)!.data!.type)} (confidence {Number(step("classify").at(-1)!.data!.confidence).toFixed(2)})</div>
        )}
      </div>
    );
  }
  if (node === "local") {
    const tries = step("local-sql").filter((s) => s.data?.sql !== undefined);
    return tries.length ? (
      <div className="kv">
        <h4>SQL written by the local model</h4>
        {tries.map((s, i) => (
          <div key={i}>
            <pre className="code">{String(s.data!.sql) || "(asked to escalate)"}</pre>
            <div className="muted">
              confidence {Number(s.data!.confidence).toFixed(2)}
              {s.data!.reason ? ` · ${String(s.data!.reason)}` : ""}
            </div>
          </div>
        ))}
      </div>
    ) : null;
  }
  if (node === "verify") {
    const v = step("verify");
    return v.length ? (
      <div className="kv">
        <h4>Checks</h4>
        {v.map((s, i) => (
          <div key={i}>
            <div className={s.status === "error" ? "bad" : "good"}>{s.status === "error" ? "✗ " : "✓ "}{s.detail}</div>
            {Array.isArray(s.data?.checks) && <ul>{(s.data!.checks as string[]).map((c) => <li key={c}>{c}</li>)}</ul>}
          </div>
        ))}
      </div>
    ) : null;
  }
  if (node === "exec" && turn.final?.table) {
    const t = turn.final.table;
    return (
      <div className="kv">
        <h4>Result</h4>
        <div className="muted">{t.rowCount.toLocaleString()} row(s) in {t.elapsedMs} ms{t.truncated ? " (row cap reached)" : ""}. These rows are shown on screen and never re-sent.</div>
      </div>
    );
  }
  if (node === "gate" || node === "egress" || node === "remote") {
    if (turn.egress.length === 0) return <div className="muted">Nothing was sent to the remote model for this question.</div>;
    return (
      <div className="kv">
        <h4>{node === "egress" ? "Log entries" : "What was sent"}</h4>
        {turn.egress.map((e, i) => (
          <div key={e.egressId} className="send">
            <div className="kv__row">
              <span className="chip chip--remote">{e.detail?.purpose ?? "send"}</span>
              <span className={`chip ${e.outcome === "cancelled" ? "chip--bad" : "chip--on"}`}>{e.outcome === "pending" ? "pending" : e.outcome === "cancelled" ? "cancelled by you" : "sent"}</span>
              <span className="muted">#{i + 1}</span>
            </div>
            {e.detail ? (
              <>
                <div className="stats">
                  <Stat k="payload" v={kb(e.detail.bytes)} />
                  <Stat k="rows" v={String(e.detail.rows)} />
                  <Stat k="tables" v={String(e.detail.tables.length)} />
                  <Stat k="privacy level" v={e.detail.privacyLevel} />
                </div>
                {e.detail.summarized && <div className="muted">The result was too large to send as rows, so a locally computed summary was sent instead.</div>}
                <details>
                  <summary>Exact payload</summary>
                  <pre className="code">{e.detail.preview}</pre>
                </details>
              </>
            ) : (
              <div className="muted">{e.summary}</div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

const Stat = ({ k, v }: { k: string; v: string }) => (
  <div className="stat">
    <div className="stat__v">{v}</div>
    <div className="stat__k">{k}</div>
  </div>
);

/** A list of the steps with a duration bar for each, so the slow parts are obvious. */
export function Timeline({ turn }: { turn: TurnState }) {
  const total = Math.max(1, (turn.events.at(-1)?.t ?? 1));
  return (
    <div className="timeline">
      <h4>Timeline</h4>
      {turn.steps.map((s, i) => {
        const end = s.endedAt ?? turn.events.at(-1)?.t ?? s.startedAt;
        return (
          <div key={i} className="tl__row">
            <div className="tl__name">{STEP_TITLES[s.step] ?? s.step}</div>
            <div className="tl__bar">
              <div className={`tl__fill tl__fill--${s.status}`} style={{ left: `${(s.startedAt / total) * 100}%`, width: `${Math.max(1.5, ((end - s.startedAt) / total) * 100)}%` }} />
            </div>
            <div className="tl__ms">{fmtMs(end - s.startedAt)}</div>
          </div>
        );
      })}
    </div>
  );
}
