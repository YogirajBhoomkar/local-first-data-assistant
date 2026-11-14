// Preload (sandboxed, CommonJS). Exposes a minimal typed API on window.lf and nothing else.
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type LfApi, type FolderView, type ModelStatus, type TurnEnvelope } from "../shared/ipc.js";

const api: LfApi = {
  selectFolder: () => ipcRenderer.invoke(CHANNELS.selectFolder),
  getFolder: () => ipcRenderer.invoke(CHANNELS.getFolder),
  ask: (req) => ipcRenderer.invoke(CHANNELS.ask, req),
  confirm: (egressId, approved) => ipcRenderer.invoke(CHANNELS.confirm, { egressId, approved }),
  cancel: (turnId) => ipcRenderer.invoke(CHANNELS.cancel, { turnId }),
  getEgressLog: (limit) => ipcRenderer.invoke(CHANNELS.egressLog, { limit }),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  setSettings: (update) => ipcRenderer.invoke(CHANNELS.setSettings, update),
  runProbe: () => ipcRenderer.invoke(CHANNELS.probe),
  getStatus: () => ipcRenderer.invoke(CHANNELS.status),
  onEvent: (cb) => {
    const h = (_: unknown, e: TurnEnvelope) => cb(e);
    ipcRenderer.on(CHANNELS.event, h);
    return () => ipcRenderer.removeListener(CHANNELS.event, h);
  },
  onFiles: (cb) => {
    const h = (_: unknown, f: FolderView) => cb(f);
    ipcRenderer.on(CHANNELS.files, h);
    return () => ipcRenderer.removeListener(CHANNELS.files, h);
  },
  onStatus: (cb) => {
    const h = (_: unknown, s: ModelStatus) => cb(s);
    ipcRenderer.on(CHANNELS.statusPush, h);
    return () => ipcRenderer.removeListener(CHANNELS.statusPush, h);
  },
};

contextBridge.exposeInMainWorld("lf", api);
