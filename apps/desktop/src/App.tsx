import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LfApi, FolderView, ModelStatus, ProbeView, Settings, SettingsView } from "../shared/ipc";
import { AssistantMessage, Composer, UserMessage } from "./components/Chat";
import Inspector, { Timeline } from "./components/Inspector";
import { ConfirmDialog, EgressLogView, FolderBar, SettingsPanel, StatusStrip, Welcome } from "./components/Panels";
import Pipeline from "./components/Pipeline";
import { derivePipeline, type NodeId } from "./state/pipeline";
import { newTurn, reduceTurn, type TurnState } from "./state/turn";

declare global {
  interface Window {
    lf: LfApi;
  }
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
let counter = 0;
const newId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export default function App() {
  const [folder, setFolder] = useState<FolderView | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [probe, setProbe] = useState<ProbeView | null>(null);
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [node, setNode] = useState<NodeId>("router");
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [picking, setPicking] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [replay, setReplay] = useState<{ t: number; playing: boolean } | null>(null);
  const [speed, setSpeed] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);

  // ---- boot: settings, status, probe, event subscriptions
  useEffect(() => {
    const lf = window.lf;
    void lf.getSettings().then(setSettings);
    void lf.getStatus().then(setStatus).catch(() => undefined);
    void lf.runProbe().then(setProbe).catch(() => undefined);
    try {
      if (!localStorage.getItem("lf-welcomed")) setWelcome(true);
    } catch {
      setWelcome(true);
    }
    const offEvent = lf.onEvent(({ turnId, event }) =>
      setTurns((ts) => ts.map((t) => (t.id === turnId ? reduceTurn(t, { kind: "event", event, now: Date.now() }) : t))),
    );
    const offFiles = lf.onFiles(setFolder);
    const offStatus = lf.onStatus(setStatus);
    return () => {
      offEvent();
      offFiles();
      offStatus();
    };
  }, []);

  const theme = settings?.settings.theme ?? "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const running = turns.some((t) => t.status === "running" || t.status === "confirm");
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setClock(Date.now()), 200);
    return () => clearInterval(i);
  }, [running]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, turns.at(-1)?.text, turns.at(-1)?.final]);

  // ---- the turn shown on the map: the selected one, else the latest
  const viewed = useMemo(() => turns.find((t) => t.id === viewId) ?? turns.at(-1) ?? null, [turns, viewId]);
  const pipelineView = useMemo(() => {
    if (!viewed) return derivePipeline(newTurn("none", "", 0));
    return derivePipeline(viewed, replay ? replay.t : undefined, clock);
  }, [viewed, replay, clock]);

  // ---- replay clock
  const total = viewed ? Math.max(1, viewed.events.at(-1)?.t ?? 1) : 1;
  useEffect(() => {
    if (!replay?.playing) return;
    const i = setInterval(() => {
      setReplay((r) => {
        if (!r) return r;
        const t = r.t + 100 * speed;
        return t >= total ? { t: total, playing: false } : { t, playing: true };
      });
    }, 100);
    return () => clearInterval(i);
  }, [replay?.playing, speed, total]);

  // ---- actions
  const pickFolder = useCallback(async () => {
    setPicking(true);
    try {
      const f = await window.lf.selectFolder();
      if (f) setFolder(f);
    } finally {
      setPicking(false);
    }
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const id = newId();
      const n = settings?.settings.history.turns ?? 3;
      const history = turns
        .filter((t) => t.final)
        .slice(-n)
        .flatMap((t) => [
          { role: "user" as const, text: t.question },
          { role: "assistant" as const, text: t.final!.answer.slice(0, 600) },
        ]);
      setTurns((ts) => [...ts, newTurn(id, question, Date.now())]);
      setViewId(id);
      setReplay(null);
      try {
        await window.lf.ask({ turnId: id, question, history });
      } catch (e) {
        setTurns((ts) => ts.map((t) => (t.id === id ? reduceTurn(t, { kind: "event", event: { type: "error", code: "IPC", message: (e as Error).message }, now: Date.now() }) : t)));
      }
    },
    [turns, settings],
  );

  const answerConfirm = useCallback(async (turn: TurnState, ok: boolean) => {
    if (!turn.confirm) return;
    const id = turn.confirm.egressId;
    setTurns((ts) => ts.map((t) => (t.id === turn.id ? reduceTurn(t, { kind: "confirmed", approved: ok }) : t)));
    await window.lf.confirm(id, ok);
  }, []);

  const saveSettings = useCallback(async (s: Settings, apiKey?: string) => {
    const v = await window.lf.setSettings({ settings: s, ...(apiKey !== undefined ? { apiKey } : {}) });
    setSettings(v);
  }, []);

  const active = turns.find((t) => t.status === "running" || t.status === "confirm");
  const explain = settings?.settings.explain ?? true;
  const askDisabled = !folder?.ready || (!status?.local.available && !status?.remote.available);
  const disabledHint = !folder ? "Select a folder first" : !folder.ready ? "Reading and indexing your files…" : "No model is available: see the status line above";

  const sent = pipelineView.crossed ? viewed?.egress.filter((e) => e.outcome !== "cancelled") ?? [] : [];
  const sentBytes = sent.reduce((n, e) => n + (e.detail?.bytes ?? 0), 0);
  const sentRows = sent.reduce((n, e) => n + (e.detail?.rows ?? 0), 0);
  const elapsed = viewed ? ((viewed.endedAt ?? clock) - viewed.startedAt) / 1000 : 0;

  return (
    <div className={`app${explain ? " app--explain" : ""}`}>
      <header className="top">
        <div className="top__title">
          <span className="logo" aria-hidden>
            ◆
          </span>
          <strong>Local-first data assistant</strong>
          <span className="muted">your files stay on this laptop</span>
        </div>
        <StatusStrip status={status} onOpenSettings={() => setShowSettings(true)} />
        <div className="top__actions">
          <label className="check check--inline">
            <input type="checkbox" checked={explain} onChange={(e) => settings && void saveSettings({ ...settings.settings, explain: e.target.checked })} />
            Under the hood
          </label>
          <button className="btn btn--small" onClick={() => settings && void saveSettings({ ...settings.settings, theme: theme === "dark" ? "cbi" : "dark" })}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <button className="btn btn--small" onClick={() => setShowLog(true)}>
            Egress log
          </button>
          <button className="btn btn--small" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <main className="main">
        <section className="chat" aria-label="Chat">
          <FolderBar folder={folder} busy={picking} onPick={pickFolder} />
          <div className="chat__list" ref={listRef}>
            {turns.length === 0 ? (
              <div className="empty">
                <h2>Ask about your files</h2>
                <p className="muted">
                  {folder ? "Try one of these, built from your real files:" : "Select a folder to begin. A small model on this laptop answers simple questions; harder ones are escalated through a privacy gate."}
                </p>
                <div className="chips">
                  {(folder?.examples ?? []).map((q) => (
                    <button key={q} className="chip chip--btn" onClick={() => void ask(q)} disabled={askDisabled}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((t) => (
                <div key={t.id}>
                  <UserMessage text={t.question} />
                  <AssistantMessage turn={t} selected={viewed?.id === t.id} onSelect={() => { setViewId(t.id); setReplay(null); }} onPick={(q) => void ask(q)} />
                </div>
              ))
            )}
          </div>
          <Composer onSend={(q) => void ask(q)} onStop={() => active && void window.lf.cancel(active.id)} running={!!active} disabled={askDisabled} hint={disabledHint} />
        </section>

        {explain && (
          <aside className="hood" aria-label="Under the hood">
            <div className="hood__head">
              <h2>Under the hood</h2>
              <span className="muted">{viewed ? `“${viewed.question.slice(0, 70)}${viewed.question.length > 70 ? "…" : ""}”` : "Ask a question to watch it move through the system."}</span>
            </div>
            <Pipeline view={pipelineView} mode={pipelineView.mode} selected={node} onSelect={setNode} speed={speed} animateEnabled={true} />
            <div className="narrator" role="status" aria-live="polite">
              {pipelineView.now}
            </div>
            <div className="counters">
              <div className="counter">
                <div className="counter__v">{viewed ? elapsed.toFixed(1) : "0.0"} s</div>
                <div className="counter__k">elapsed</div>
              </div>
              <div className={`counter ${pipelineView.crossed ? "counter--remote" : "counter--local"}`}>
                <div className="counter__v">{pipelineView.crossed ? kb(sentBytes) : "0 B"}</div>
                <div className="counter__k">left the laptop</div>
              </div>
              <div className="counter">
                <div className="counter__v">{sentRows}</div>
                <div className="counter__k">rows sent</div>
              </div>
              <div className="counter">
                <div className="counter__v">{viewed?.final?.table ? viewed.final.table.rowCount.toLocaleString() : "—"}</div>
                <div className="counter__k">rows kept local</div>
              </div>
              <div className="counter">
                <div className="counter__v">{pipelineView.route ?? "—"}</div>
                <div className="counter__k">route</div>
              </div>
            </div>
            {viewed && (
              <div className="replay">
                <button className="btn btn--small" onClick={() => setReplay(replay?.playing ? { ...replay, playing: false } : { t: replay && replay.t < total ? replay.t : 0, playing: true })} disabled={!viewed.final && !viewed.error}>
                  {replay?.playing ? "Pause" : "Replay"}
                </button>
                <input type="range" min={0} max={total} value={replay ? replay.t : total} onChange={(e) => setReplay({ t: Number(e.target.value), playing: false })} aria-label="Replay position" disabled={!viewed.final && !viewed.error} />
                <label>
                  speed{" "}
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                    <option value={0.25}>0.25×</option>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                  </select>
                </label>
                {replay && (
                  <button className="link" onClick={() => setReplay(null)}>
                    back to live
                  </button>
                )}
              </div>
            )}
            <div className="hood__detail">
              <Inspector node={node} view={pipelineView} turn={viewed} />
              {viewed && viewed.steps.length > 0 && <Timeline turn={viewed} />}
            </div>
          </aside>
        )}
      </main>

      {active?.confirm && <ConfirmDialog preview={active.confirm.preview} onAnswer={(ok) => void answerConfirm(active, ok)} />}
      {welcome && (
        <Welcome
          probe={probe}
          status={status}
          onClose={() => {
            setWelcome(false);
            try {
              localStorage.setItem("lf-welcomed", "1");
            } catch {
              /* ignore */
            }
          }}
        />
      )}
      {showSettings && settings && <SettingsPanel view={settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
      {showLog && <EgressLogView load={() => window.lf.getEgressLog(200)} onClose={() => setShowLog(false)} />}
    </div>
  );
}
