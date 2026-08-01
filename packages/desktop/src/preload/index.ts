import { contextBridge, ipcRenderer } from "electron";
import type { GladlogApi } from "./api";

// doc 字节直传的消费端解析:实现与说明见 shared/parseDocBytes(测试
// 直接拿它对旧管线做 deep-equal)。
import { parseDocBytes } from "../shared/parseDocBytes";

function sub<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const listener = (_e: unknown, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: GladlogApi = {
  logs: {
    getStatus: () => ipcRenderer.invoke("gladlog:logs:getStatus"),
    onStatusChanged: sub("gladlog:logs:statusChanged"),
    onMatchStored: sub("gladlog:logs:matchStored"),
    onDiagnostic: sub("gladlog:logs:diagnostic"),
    importFiles: () => ipcRenderer.invoke("gladlog:logs:importFiles"),
    onImportProgress: sub("gladlog:import:progress"),
  },
  matches: {
    list: () => ipcRenderer.invoke("gladlog:matches:list"),
    get: (id) =>
      ipcRenderer
        .invoke("gladlog:matches:get", id)
        .then((buf) => parseDocBytes(buf)),
    page: (opts) => ipcRenderer.invoke("gladlog:matches:page", opts),
    rebuildIndex: () => ipcRenderer.invoke("gladlog:matches:rebuildIndex"),
    rawLine: (id, opts) =>
      ipcRenderer.invoke("gladlog:matches:rawLine", id, opts),
    exportImage: (opts) =>
      ipcRenderer.invoke("gladlog:matches:exportImage", opts),
  },
  settings: {
    get: () => ipcRenderer.invoke("gladlog:settings:get"),
    save: (partial) => ipcRenderer.invoke("gladlog:settings:save", partial),
  },
  app: {
    getVersion: () => ipcRenderer.invoke("gladlog:app:getVersion"),
    selectDirectory: () => ipcRenderer.invoke("gladlog:app:selectDirectory"),
    openExternal: (url) => ipcRenderer.invoke("gladlog:app:openExternal", url),
  },
  compare: {
    run: (input) => ipcRenderer.invoke("gladlog:compare:run", input),
    cancel: () => ipcRenderer.invoke("gladlog:compare:cancel"),
    getCached: (matchId) =>
      ipcRenderer.invoke("gladlog:compare:getCached", matchId),
    onDelta: sub<{ matchId: string; text: string }>("gladlog:compare:delta"),
    onDone: sub<{ matchId: string; result: unknown }>("gladlog:compare:done"),
    onError: sub<{ matchId: string; message: string }>("gladlog:compare:error"),
  },
  analysis: {
    run: (input) => ipcRenderer.invoke("gladlog:analysis:run", input),
    cancel: (matchId?: string) =>
      ipcRenderer.invoke("gladlog:analysis:cancel", matchId),
    getState: (matchId) =>
      ipcRenderer.invoke("gladlog:analysis:getState", matchId),
    getCached: (matchId, slotKey) =>
      ipcRenderer.invoke("gladlog:analysis:getCached", matchId, slotKey),
    getFlags: (matchId) =>
      ipcRenderer.invoke("gladlog:analysis:getFlags", matchId),
    aggregate: () => ipcRenderer.invoke("gladlog:analysis:aggregate"),
    listAnalyzed: () => ipcRenderer.invoke("gladlog:analysis:listAnalyzed"),
    notebook: () => ipcRenderer.invoke("gladlog:analysis:notebook"),
    deepen: (input) => ipcRenderer.invoke("gladlog:analysis:deepen", input),
    analyzeWindow: (input) =>
      ipcRenderer.invoke("gladlog:analysis:analyzeWindow", input),
    setFlag: (matchId, key, flag) =>
      ipcRenderer.invoke("gladlog:analysis:setFlag", matchId, key, flag),
    onDelta: sub<{ matchId: string; text: string }>("gladlog:analysis:delta"),
    onDone: sub<{ matchId: string; result: unknown }>("gladlog:analysis:done"),
    onError: sub<{ matchId: string; message: string }>(
      "gladlog:analysis:error",
    ),
  },
  learning: {
    getRules: () => ipcRenderer.invoke("gladlog:learning:getRules"),
    getState: () => ipcRenderer.invoke("gladlog:learning:getState"),
    consolidate: () => ipcRenderer.invoke("gladlog:learning:consolidate"),
    onProgress: sub<{ scanned: number; total: number }>(
      "gladlog:learning:progress",
    ),
    onDone: sub<{
      rules: number;
      distilled: number;
      dropped: number;
      distillError?: string;
    }>("gladlog:learning:done"),
    onError: sub<{ message: string }>("gladlog:learning:error"),
  },
  recorder: {
    getStatus: () => ipcRenderer.invoke("gladlog:recorder:getStatus"),
    testConnection: (overrides) =>
      ipcRenderer.invoke("gladlog:recorder:testConnection", overrides),
    autoConfig: () => ipcRenderer.invoke("gladlog:recorder:autoConfig"),
    getForMatch: (matchId) =>
      ipcRenderer.invoke("gladlog:recorder:getForMatch", matchId),
    onStatus: sub("gladlog:recorder:status"),
  },
  icon: {
    get: (name) => ipcRenderer.invoke("gladlog:icon:get", name),
  },
  debug: {
    aiCalls: () => ipcRenderer.invoke("gladlog:debug:aiCalls"),
  },
  ai: {
    detectCli: (backend) => ipcRenderer.invoke("gladlog:ai:detectCli", backend),
  },
};
contextBridge.exposeInMainWorld("gladlog", api);
