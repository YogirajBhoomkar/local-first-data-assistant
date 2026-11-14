import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChartSpec, Citation, QueryResult } from "@lf/core";

// ---------------------------------------------------------------- safe text (no HTML, no links)
/** Minimal markdown: paragraphs, bullets, **bold** and `code`. Everything is rendered as React text, never as HTML. */
export function SafeText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>,
    );
  return (
    <div className="answer">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------- data table
export function DataTable({ result }: { result: QueryResult }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    const base = result.rows.slice(0, 2000);
    if (!sort) return base.slice(0, 200);
    const cmp = (a: unknown, b: unknown) => {
      const na = Number(a);
      const nb = Number(b);
      if (a !== null && b !== null && a !== "" && b !== "" && !isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a ?? "").localeCompare(String(b ?? ""));
    };
    return [...base].sort((a, b) => sort.dir * cmp(a[sort.col], b[sort.col])).slice(0, 200);
  }, [result, sort]);
  return (
    <div className="card">
      <div className="card__head">
        <strong>Data</strong>
        <span className="muted">
          {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"}
          {result.truncated ? " (capped: more rows exist)" : ""} · {result.elapsedMs} ms · showing {Math.min(rows.length, 200)}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i}>
                  <button className="th" onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))} aria-label={`Sort by ${c.name}`}>
                    {c.name}
                    {sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j}>{v === null ? <span className="muted">NULL</span> : String(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chart (Plotly, loaded on demand)
type ChartKind = ChartSpec["type"];
const KINDS: ChartKind[] = ["bar", "line", "pie", "scatter", "table"];
const PALETTE = ["#0b2a8a", "#0067b1", "#7b3fe4", "#1a9d4b", "#f59e0b", "#e11d48", "#38bdf8", "#6b7280"];

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function buildFigure(spec: ChartSpec, r: QueryResult, kind: ChartKind) {
  const xi = Math.max(0, r.columns.findIndex((c) => c.name === spec.x));
  const yi = Math.max(0, r.columns.findIndex((c) => c.name === spec.y));
  const x = r.rows.map((row) => row[xi]);
  const y = r.rows.map((row) => Number(row[yi]));
  const text = cssVar("--text", "#1f2937");
  const grid = cssVar("--line", "#e1e5ec");
  const layout = {
    margin: { t: 24, r: 16, b: 48, l: 56 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Roboto, Segoe UI, Arial, sans-serif", size: 12, color: text },
    xaxis: { title: { text: spec.x ?? "" }, gridcolor: grid },
    yaxis: { title: { text: spec.y ?? "" }, gridcolor: grid },
    showlegend: kind === "pie",
    colorway: PALETTE,
  };
  const trace =
    kind === "pie"
      ? { type: "pie", labels: x, values: y, hole: 0.35 }
      : kind === "scatter"
        ? { type: "scatter", mode: "markers", x, y, marker: { size: 9 } }
        : kind === "line"
          ? { type: "scatter", mode: "lines+markers", x, y }
          : { type: "bar", x, y };
  return { data: [trace], layout };
}

export function ChartCard({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  const [kind, setKind] = useState<ChartKind>(spec.type);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => setKind(spec.type), [spec.type]);
  useEffect(() => {
    if (kind === "table" || !el.current) return;
    let cancelled = false;
    const node = el.current;
    (async () => {
      try {
        const mod = (await import("plotly.js-dist-min")) as unknown as { default: { react: (n: HTMLElement, d: unknown, l: unknown, c: unknown) => void; purge: (n: HTMLElement) => void } };
        if (cancelled) return;
        const fig = buildFigure(spec, result, kind);
        mod.default.react(node, fig.data, fig.layout, { displayModeBar: false, responsive: true });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, result, kind]);
  if (spec.type === "table" && kind === "table") return null;
  return (
    <div className="card">
      <div className="card__head">
        <strong>{spec.title || "Chart"}</strong>
        <span className="seg" role="group" aria-label="Chart type">
          {KINDS.filter((k) => k !== "table").map((k) => (
            <button key={k} className={k === kind ? "is-on" : ""} onClick={() => setKind(k)}>
              {k}
            </button>
          ))}
        </span>
      </div>
      {error ? <div className="notice">The chart could not be drawn: {error}</div> : <div ref={el} className="chart" />}
    </div>
  );
}

// ---------------------------------------------------------------- SQL + citations
export function SqlBlock({ sql }: { sql: string[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!sql.length) return null;
  const text = sql.join("\n\n");
  return (
    <div className="card">
      <button className="card__head card__head--btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <strong>SQL used ({sql.length})</strong>
        <span className="muted">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="code-wrap">
          <button
            className="btn btn--small"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setCopied(true));
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <pre className="code">{text}</pre>
        </div>
      )}
    </div>
  );
}

export function Citations({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return (
    <div className="card">
      <div className="card__head">
        <strong>Sources</strong>
        <span className="muted">{items.length}</span>
      </div>
      <ul className="cites">
        {items.map((c, i) => (
          <li key={i}>
            <span className="chip chip--src">
              {c.fileAlias} · {c.page !== undefined ? `page ${c.page}` : `slide ${c.slide}`}
            </span>
            <span className="cite__text">“{c.snippet}”</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
