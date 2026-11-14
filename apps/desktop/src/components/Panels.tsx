import { useEffect, useState } from "react";
import type { EgressRecord } from "@lf/core";
import type { FolderView, ModelStatus, ProbeView, Settings, SettingsView } from "../../shared/ipc";

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------- confirm before send
export function ConfirmDialog({ preview, onAnswer }: { preview: string; onAnswer: (ok: boolean) => void }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Confirm what will be sent">
      <div className="modal__box">
        <h2>Send this to the remote model?</h2>
        <p className="muted">This is the exact payload. It was already written to the egress log. Nothing is sent until you press Send; Cancel keeps the answer on this laptop.</p>
        <pre className="code code--tall">{preview.slice(0, 8000)}</pre>
        <div className="modal__actions">
          <button className="btn" onClick={() => onAnswer(false)} autoFocus>
            Cancel (stay local)
          </button>
          <button className="btn btn--primary" onClick={() => onAnswer(true)}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- folder bar
const STATUS_TEXT: Record<string, string> = { ready: "ready", converting: "reading…", indexed: "indexed", skipped: "skipped", warning: "warning" };

export function FolderBar({ folder, busy, onPick }: { folder: FolderView | null; busy: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="folder">
      <div className="folder__bar">
        <button className="btn btn--primary" onClick={onPick} disabled={busy}>
          {folder ? "Change folder" : "Select folder"}
        </button>
        {folder ? (
          <span>
            <strong>{folder.folderName}</strong>{folder.ready ? "" : " (reading and indexing…)"} · {folder.files.length} files · {folder.tables.length} tables · {folder.documents.length} documents
          </span>
        ) : (
          <span className="muted">Pick the folder with your CSV, Excel, Parquet, PDF and PowerPoint files.</span>
        )}
        {folder && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "hide files" : "show files"}
          </button>
        )}
      </div>
      {folder && open && (
        <ul className="files">
          {folder.files.map((f) => (
            <li key={f.alias} className={`file file--${f.status}`}>
              <span className="file__name">{f.alias}</span>
              <span className="chip">{f.kind}</span>
              <span className="muted">{kb(f.sizeBytes)}</span>
              <span className={`status status--${f.status}`}>{STATUS_TEXT[f.status]}</span>
              {f.notes.length > 0 && <span className="muted file__notes">{f.notes.join(" ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- capability check (first run / header)
export function StatusStrip({ status, onOpenSettings }: { status: ModelStatus | null; onOpenSettings: () => void }) {
  if (!status) return <div className="statusstrip muted">Checking this laptop…</div>;
  return (
    <div className="statusstrip">
      <span className={`dot ${status.local.available ? "dot--ok" : "dot--off"}`} />
      <span>
        {status.local.available
          ? `Local model ready: ${status.local.model}`
          : `Local model not available. ${status.local.reason}${status.local.installHint ? ` To install: ${status.local.installHint}` : ""}`}
      </span>
      <span className={`dot ${status.remote.available ? "dot--ok" : "dot--off"}`} />
      <span>{status.remote.available ? `Remote model ready: ${status.remote.model}` : status.remote.reason}</span>
      <button className="link" onClick={onOpenSettings}>
        settings
      </button>
    </div>
  );
}

export function Welcome({ probe, status, onClose }: { probe: ProbeView | null; status: ModelStatus | null; onClose: () => void }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="modal__box">
        <h2>Welcome</h2>
        <p>
          This assistant answers questions about your own files. A small model on this laptop handles simple questions. Harder questions can be escalated to a stronger remote model, but only through a privacy gate that shows and logs exactly what is sent.
        </p>
        <h4>This laptop</h4>
        {probe ? (
          <>
            <p>
              {status?.local.available
                ? `This laptop can run the small local model (${status.local.model}).`
                : "A local model is not available. Questions will use the remote model with only the information your privacy settings allow."}
            </p>
            <ul className="muted">
              <li>{probe.ramGb} GB memory · GPU: {probe.gpu}</li>
              <li>Local model server: {probe.ollama.reachable ? `running (${probe.ollama.models.length} model(s) installed)` : "not running"}</li>
              <li>Recommended tier: {probe.recommendation.tier}{probe.recommendation.model ? ` (${probe.recommendation.model})` : ""}</li>
              {status?.local.installHint && <li>To enable the local model: <code>{status.local.installHint}</code></li>}
            </ul>
          </>
        ) : (
          <p className="muted">Checking…</p>
        )}
        <div className="modal__actions">
          <button className="btn btn--primary" onClick={onClose}>
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings
const LEVELS: { id: Settings["privacy"]["tabularLevel"]; title: string; line: string }[] = [
  { id: "schema", title: "Schema only", line: "The remote model sees table and column names and types. Never any values." },
  { id: "aggregates", title: "Schema + column summaries", line: "Adds counts, ranges and common values per column. No individual rows." },
  { id: "rows", title: "Schema + summaries + rows", line: "Adds a few sample rows and lets the remote model write the answer from capped results." },
];

export function SettingsPanel({ view, onSave, onClose }: { view: SettingsView; onSave: (s: Settings, apiKey?: string) => Promise<void>; onClose: () => void }) {
  const [s, setS] = useState<Settings>(view.settings);
  const [apiKey, setApiKey] = useState("");
  const [deny, setDeny] = useState(view.settings.privacy.denyColumns.join("\n"));
  const [mask, setMask] = useState(view.settings.privacy.maskColumns.join("\n"));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);

  return (
    <div className="drawer" role="dialog" aria-label="Settings">
      <div className="drawer__head">
        <h2>Settings</h2>
        <button className="btn btn--small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="drawer__body">
        <section>
          <h3>Privacy: what the remote model may see for tables</h3>
          {LEVELS.map((l) => (
            <label key={l.id} className="radio">
              <input type="radio" name="level" checked={s.privacy.tabularLevel === l.id} onChange={() => set("privacy", { ...s.privacy, tabularLevel: l.id })} />
              <span>
                <strong>{l.title}</strong>
                <br />
                <span className="muted">{l.line}</span>
              </span>
            </label>
          ))}
          <label className="field">
            Max rows sent
            <input type="number" min={1} value={s.privacy.maxRowsSent} onChange={(e) => set("privacy", { ...s.privacy, maxRowsSent: num(e.target.value, 500) })} />
          </label>
          <label className="field">
            Max bytes sent
            <input type="number" min={1000} value={s.privacy.maxBytesSent} onChange={(e) => set("privacy", { ...s.privacy, maxBytesSent: num(e.target.value, 200000) })} />
          </label>
          <label className="field">
            Never send columns matching (one pattern per line)
            <textarea rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="ssn&#10;^email$" />
          </label>
          <label className="field">
            Mask values of columns matching (replaced by stable tokens)
            <textarea rows={3} value={mask} onChange={(e) => setMask(e.target.value)} placeholder="broker" />
          </label>
          <label className="field">
            Document passages sent (top K)
            <input type="number" min={1} value={s.privacy.docTopK} onChange={(e) => set("privacy", { ...s.privacy, docTopK: num(e.target.value, 6) })} />
          </label>
          <label className="field">
            Max document characters sent
            <input type="number" min={500} value={s.privacy.docMaxChars} onChange={(e) => set("privacy", { ...s.privacy, docMaxChars: num(e.target.value, 12000) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={s.privacy.confirmBeforeSend} onChange={(e) => set("privacy", { ...s.privacy, confirmBeforeSend: e.target.checked })} />
            Ask me before anything is sent
          </label>
        </section>

        <section>
          <h3>Local model</h3>
          <label className="check">
            <input type="checkbox" checked={s.localModel.enabled} onChange={(e) => set("localModel", { ...s.localModel, enabled: e.target.checked })} />
            Use a local model
          </label>
          <label className="field">
            Model (empty = chosen by this laptop's memory)
            <input value={s.localModel.name ?? ""} onChange={(e) => set("localModel", { ...s.localModel, name: e.target.value || null })} placeholder="qwen3.5:4b" />
          </label>
          <label className="field">
            Server URL
            <input value={s.localModel.baseUrl} onChange={(e) => set("localModel", { ...s.localModel, baseUrl: e.target.value })} />
          </label>
        </section>

        <section>
          <h3>Remote model</h3>
          <label className="check">
            <input type="checkbox" checked={s.remote.enabled} onChange={(e) => set("remote", { ...s.remote, enabled: e.target.checked })} />
            Allow escalation to a remote model
          </label>
          <label className="field">
            Provider
            <select value={s.remote.provider} onChange={(e) => set("remote", { ...s.remote, provider: e.target.value as Settings["remote"]["provider"] })}>
              <option value="openai-compatible">OpenAI-compatible (for example LiteLLM)</option>
              <option value="azure-openai">Azure OpenAI</option>
            </select>
          </label>
          <label className="field">
            Base URL (empty = use the environment)
            <input value={s.remote.baseUrl} onChange={(e) => set("remote", { ...s.remote, baseUrl: e.target.value })} placeholder="https://your-gateway/v1" />
          </label>
          <label className="field">
            Model (or deployment name)
            <input value={s.remote.model} onChange={(e) => set("remote", { ...s.remote, model: e.target.value })} />
          </label>
          {s.remote.provider === "azure-openai" && (
            <label className="field">
              API version
              <input value={s.remote.apiVersion} onChange={(e) => set("remote", { ...s.remote, apiVersion: e.target.value })} />
            </label>
          )}
          <label className="field">
            API key {view.remoteKey.saved ? <span className="muted">(saved ••••{view.remoteKey.last4}, from {view.remoteKey.source})</span> : <span className="muted">(not set)</span>}
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="paste a new key to replace it" />
            <span className="muted">Stored encrypted with your OS keychain. It is never shown again and never reaches this window after saving.</span>
          </label>
        </section>

        <section>
          <h3>Chat and display</h3>
          <label className="field">
            Earlier turns passed to the model
            <input type="number" min={0} max={10} value={s.history.turns} onChange={(e) => set("history", { turns: num(e.target.value, 3) })} />
          </label>
          <label className="field">
            Theme
            <select value={s.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}>
              <option value="dark">Dark technical</option>
              <option value="cbi">Conversational BI (light)</option>
            </select>
          </label>
        </section>
      </div>
      <div className="drawer__foot">
        {err && <span className="bad">{err}</span>}
        <button
          className="btn btn--primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setErr(null);
            try {
              await onSave({ ...s, privacy: { ...s.privacy, denyColumns: lines(deny), maskColumns: lines(mask) } }, apiKey || undefined);
              onClose();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- egress log
export function EgressLogView({ load, onClose }: { load: () => Promise<EgressRecord[]>; onClose: () => void }) {
  const [rows, setRows] = useState<EgressRecord[] | null>(null);
  const [purpose, setPurpose] = useState("all");
  const [day, setDay] = useState("");
  useEffect(() => {
    void load().then((r) => setRows([...r].reverse()));
  }, [load]);
  const shown = (rows ?? []).filter((r) => (purpose === "all" || r.purpose === purpose) && (!day || r.timestamp.startsWith(day)));
  return (
    <div className="drawer drawer--wide" role="dialog" aria-label="Egress log">
      <div className="drawer__head">
        <h2>Everything sent to the remote model</h2>
        <button className="btn btn--small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="drawer__body">
        <div className="filters">
          <label>
            Purpose{" "}
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="all">all</option>
              <option value="write-sql">write-sql</option>
              <option value="answer-from-results">answer-from-results</option>
              <option value="answer-from-chunks">answer-from-chunks</option>
            </select>
          </label>
          <label>
            Day <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <span className="muted">{shown.length} record(s). The log is append-only and stays on this laptop.</span>
        </div>
        {rows === null ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="muted">Nothing has been sent to a remote model.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Purpose</th>
                  <th>Outcome</th>
                  <th>Level</th>
                  <th>Tables</th>
                  <th>Columns</th>
                  <th>Rows</th>
                  <th>Bytes</th>
                  <th>Approved</th>
                  <th>SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.egressId}>
                    <td>{new Date(r.timestamp).toLocaleString()}</td>
                    <td>{r.purpose}</td>
                    <td>{r.outcome}</td>
                    <td>{r.privacyLevel}</td>
                    <td>{r.tables.join(", ")}</td>
                    <td>{r.columns.length}</td>
                    <td>{r.rowCount}</td>
                    <td>{r.byteSize}</td>
                    <td>{r.approvedBy}</td>
                    <td className="mono">{r.payloadSha256.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
