import { useEffect, useRef, useState } from "react";
import type { TurnState } from "../state/turn";
import { STEP_TITLES } from "../state/explain";
import { ChartCard, Citations, DataTable, SafeText, SqlBlock } from "./ResultCards";

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function Badge({ turn }: { turn: TurnState }) {
  if (!turn.final) return null;
  const sent = turn.egress.filter((e) => e.outcome !== "cancelled");
  return sent.length > 0 ? (
    <span className="badge badge--remote">Sent to remote model · {kb(sent.reduce((n, e) => n + (e.detail?.bytes ?? 0), 0))}</span>
  ) : (
    <span className="badge badge--local">Answered on this laptop</span>
  );
}

function Steps({ turn }: { turn: TurnState }) {
  const [open, setOpen] = useState(false);
  const running = turn.status === "running" || turn.status === "confirm";
  const last = turn.steps.at(-1);
  return (
    <div className="steps">
      <button className="steps__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`spinner${running ? " is-on" : ""}`} aria-hidden />
        <span>{running ? (turn.status === "confirm" ? "Waiting for your approval…" : last ? last.detail || STEP_TITLES[last.step] || last.step : "Starting…") : `Worked for ${((turn.endedAt ?? turn.startedAt) - turn.startedAt) / 1000 < 10 ? (((turn.endedAt ?? turn.startedAt) - turn.startedAt) / 1000).toFixed(1) : Math.round(((turn.endedAt ?? turn.startedAt) - turn.startedAt) / 1000)} s`}</span>
        <span className="muted">{open ? "hide steps" : "show steps"}</span>
      </button>
      {open && (
        <ul>
          {turn.steps.map((s, i) => (
            <li key={i} className={`step step--${s.status}`}>
              <span className="step__mark">{s.status === "done" ? "✓" : s.status === "error" ? "✗" : s.status === "skip" ? "–" : "…"}</span>
              <strong>{STEP_TITLES[s.step] ?? s.step}</strong>
              <span className="muted"> {s.detail}</span>
            </li>
          ))}
          {turn.routes.map((r, i) => (
            <li key={`r${i}`} className="step step--route">
              <span className="step__mark">→</span>
              <strong>Route: {r.route}</strong>
              <span className="muted"> layer {r.layer}. {r.reasons.join("; ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AssistantMessage({
  turn,
  selected,
  onSelect,
  onPick,
}: {
  turn: TurnState;
  selected: boolean;
  onSelect: () => void;
  onPick: (q: string) => void;
}) {
  const f = turn.final;
  return (
    <div className={`msg msg--assistant${selected ? " is-selected" : ""}`} onClick={onSelect}>
      <div className="msg__avatar" aria-hidden>
        ◆
      </div>
      <div className="msg__body">
        <Steps turn={turn} />
        {turn.text && <SafeText text={turn.text} />}
        {turn.error && (
          <div className="notice notice--error" role="alert">
            <strong>{turn.error.code === "CANCELLED" ? "Stopped." : "That did not work."}</strong> {turn.error.message}
          </div>
        )}
        {f && (
          <>
            <div className="badges">
              <Badge turn={turn} />
              {f.route.layer >= 0 && <span className="badge">route: {f.route.route}, layer {f.route.layer}</span>}
            </div>
            {turn.egress.length > 0 && (
              <details className="sent">
                <summary>What was sent ({turn.egress.length})</summary>
                {turn.egress.map((e) => (
                  <div key={e.egressId} className="sent__row">
                    <strong>{e.detail?.purpose ?? "send"}</strong> · {e.outcome === "cancelled" ? "cancelled by you" : "sent"} · {e.summary}
                    {e.detail && (
                      <div className="muted">
                        tables: {e.detail.tables.join(", ") || "—"} · columns: {e.detail.columns.length} · rows: {e.detail.rows} · level: {e.detail.privacyLevel}
                        {e.detail.summarized ? " · summarised locally (result too large)" : ""}
                      </div>
                    )}
                  </div>
                ))}
                <div className="muted">Full record: Egress log (top right).</div>
              </details>
            )}
            {f.table && f.chart && f.chart.type !== "table" && <ChartCard spec={f.chart} result={f.table} />}
            {f.table && <DataTable result={f.table} />}
            {f.citations && f.citations.length > 0 && <Citations items={f.citations} />}
            {f.sql && <SqlBlock sql={f.sql} />}
          </>
        )}
        {turn.suggestions.length > 0 && (
          <div className="chips">
            {turn.suggestions.map((s) => (
              <button key={s} className="chip chip--btn" onClick={(e) => { e.stopPropagation(); onPick(s); }}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg msg--user">
      <div className="msg__body msg__body--user">{text}</div>
    </div>
  );
}

export function Composer({ onSend, onStop, running, disabled, hint }: { onSend: (q: string) => void; onStop: () => void; running: boolean; disabled: boolean; hint: string }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(140, ref.current.scrollHeight)}px`;
    }
  }, [v]);
  const send = () => {
    const q = v.trim();
    if (!q || running || disabled) return;
    onSend(q);
    setV("");
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={v}
        aria-label="Ask a question about your files"
        placeholder={disabled ? hint : "Ask a question about your files…"}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {running ? (
        <button className="btn btn--danger" onClick={onStop} aria-label="Stop">
          Stop
        </button>
      ) : (
        <button className="btn btn--primary" onClick={send} disabled={disabled || !v.trim()}>
          Ask
        </button>
      )}
    </div>
  );
}
