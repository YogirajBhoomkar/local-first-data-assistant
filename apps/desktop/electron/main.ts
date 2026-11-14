// Main process: windows, menus, dialogs, lifecycle, the settings and key store, and the broker between
// the window and the agent process. No agent logic lives here.
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfTest } from "./selftest.js";
import {
  AskRequestSchema,
  CHANNELS,
  CancelSchema,
  ConfirmSchema,
  EgressQuerySchema,
  SettingsSchema,
  SettingsUpdateSchema,
  type AgentMessage,
  type AgentRequest,
  type FolderView,
  type ModelStatus,
  type Settings,
  type SettingsView,
} from "../shared/ipc.js";

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// In development, values for the remote model can come from a .env at the repo root (never printed).
if (isDev) {
  try {
    process.loadEnvFile(join(here, "../../../.env"));
  } catch {
    /* no .env: the remote model is then configured in Settings */
  }
}

// ------------------------------------------------------------------ settings and the API key
const settingsFile = () => join(app.getPath("userData"), "settings.json");
const keyFile = () => join(app.getPath("userData"), "remote-key.bin");

function loadSettings(): Settings {
  try {
    return SettingsSchema.parse(JSON.parse(readFileSync(settingsFile(), "utf8")));
  } catch {
    return SettingsSchema.parse({});
  }
}
function saveSettings(s: Settings): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
/** The key is stored encrypted with the OS keychain (safeStorage) and never sent to the window. */
function loadKey(): string | null {
  try {
    if (!existsSync(keyFile()) || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(readFileSync(keyFile()));
  } catch {
    return null;
  }
}
function saveKey(key: string): void {
  if (!key) {
    rmSync(keyFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain is not available, so the key cannot be stored safely.");
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(keyFile(), safeStorage.encryptString(key));
}
function settingsView(): SettingsView {
  const key = loadKey();
  const env = process.env.LF_REMOTE_API_KEY || process.env.LLM_API_KEY || "";
  return {
    settings: loadSettings(),
    remoteKey: key
      ? { saved: true, last4: key.slice(-4), source: "keychain" }
      : env
        ? { saved: true, last4: env.slice(-4), source: "environment" }
        : { saved: false, last4: "", source: "none" },
  };
}

// ------------------------------------------------------------------ the agent process
let agent: UtilityProcess | null = null;
let win: BrowserWindow | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function startAgent(): void {
  agent = utilityProcess.fork(join(here, "agent-process.mjs"), [], { serviceName: "local-first-agent", env: { ...process.env } as Record<string, string> });
  agent.on("message", (m: AgentMessage) => {
    if (m.type === "response") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p?.resolve(m.result);
      else p?.reject(new Error(m.error));
    } else if (m.type === "event") win?.webContents.send(CHANNELS.event, { turnId: m.turnId, event: m.event });
    else if (m.type === "files") win?.webContents.send(CHANNELS.files, m.folder);
    else if (m.type === "status") win?.webContents.send(CHANNELS.statusPush, m.status);
  });
  agent.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`The agent process stopped (code ${code}).`));
    pending.clear();
    agent = null;
  });
}

type DistributiveOmit<T> = T extends unknown ? Omit<T, "id"> : never;
function call<T = unknown>(req: DistributiveOmit<AgentRequest>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!agent) return reject(new Error("The agent process is not running."));
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    agent.postMessage({ ...req, id });
  });
}

// ------------------------------------------------------------------ window and security
function csp(): string {
  const dev = isDev && !!process.env.VITE_DEV_SERVER_URL;
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws://localhost:* http://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b1020",
    title: "Local-first data assistant",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.removeMenu();
  const wc = win.webContents;
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) {
      void dialog
        .showMessageBox(win!, { type: "question", buttons: ["Open in browser", "Cancel"], defaultId: 1, cancelId: 1, message: "Open this link in your browser?", detail: url })
        .then((r) => {
          if (r.response === 0) void shell.openExternal(url);
        });
    }
    return { action: "deny" };
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (isDev && dev) void win.loadURL(dev);
  else void win.loadFile(join(here, "../dist-renderer/index.html"));
  win.on("closed", () => (win = null));
}

// ------------------------------------------------------------------ IPC (every input validated)
function registerIpc(): void {
  ipcMain.handle(CHANNELS.selectFolder, async (): Promise<FolderView | null> => {
    if (process.env.LF_SELFTEST_FOLDER) return call<FolderView>({ type: "selectFolder", folder: process.env.LF_SELFTEST_FOLDER });
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Select the folder with your data files" });
    if (r.canceled || !r.filePaths[0]) return null;
    return call<FolderView>({ type: "selectFolder", folder: r.filePaths[0] });
  });
  ipcMain.handle(CHANNELS.getFolder, async () => null);
  ipcMain.handle(CHANNELS.ask, async (_e, raw) => {
    const payload = AskRequestSchema.parse(raw);
    await call({ type: "ask", payload });
  });
  ipcMain.handle(CHANNELS.confirm, async (_e, raw) => {
    const { egressId, approved } = ConfirmSchema.parse(raw);
    await call({ type: "confirm", egressId, approved });
  });
  ipcMain.handle(CHANNELS.cancel, async (_e, raw) => {
    const { turnId } = CancelSchema.parse(raw);
    await call({ type: "cancel", turnId });
  });
  ipcMain.handle(CHANNELS.egressLog, async (_e, raw) => call({ type: "egressLog", limit: EgressQuerySchema.parse(raw).limit }));
  ipcMain.handle(CHANNELS.getSettings, async () => settingsView());
  ipcMain.handle(CHANNELS.setSettings, async (_e, raw) => {
    const update = SettingsUpdateSchema.parse(raw);
    if (update.settings) saveSettings(update.settings);
    if (update.apiKey !== undefined) saveKey(update.apiKey);
    await call<ModelStatus>({ type: "applySettings", settings: loadSettings(), apiKey: loadKey() });
    return settingsView();
  });
  ipcMain.handle(CHANNELS.probe, async () => call({ type: "probe" }));
  ipcMain.handle(CHANNELS.status, async () => call<ModelStatus>({ type: "status" }));
}

void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp()] } });
  });
  startAgent();
  registerIpc();
  createWindow();
  try {
    await call({ type: "init", settings: loadSettings(), apiKey: loadKey(), userData: app.getPath("userData") });
  } catch (e) {
    console.error("agent init failed:", (e as Error).message);
  }
  if (process.env.LF_SELFTEST_FOLDER && win) {
    const ok = await runSelfTest(win, {
      question: process.env.LF_SELFTEST_QUESTION ?? "How many policies are there?",
      shotsDir: process.env.LF_SELFTEST_SHOTS ?? join(app.getPath("temp"), "lf-shots"),
      timeoutMs: Number(process.env.LF_SELFTEST_TIMEOUT ?? 600000),
      confirm: (process.env.LF_SELFTEST_CONFIRM as "approve" | "cancel" | undefined) ?? "approve",
    }).catch((e) => {
      console.log("SELFTEST ERROR", (e as Error).message);
      return false;
    });
    app.exit(ok ? 0 : 1);
  }
});

app.on("window-all-closed", () => {
  agent?.kill();
  app.quit();
});
