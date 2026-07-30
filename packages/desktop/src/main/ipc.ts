import { listAiDebug } from "./aiDebugLog";
import { detectCliForBackend } from "./cliDetect";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { importLogFiles } from "./importLogs";
import {
  redactSettings,
  sanitizeSettingsPatch,
  type GladlogSettings,
  type SettingsStore,
} from "./settingsStore";
import type { MatchStore } from "./matchStore";
import type { LogsStatusSnapshot } from "../preload/api";
import type { CompareService } from "./compare";
import type { AnalysisService } from "./analysis";
import type { LearningService } from "./learning";
import type { RecorderService } from "./recorder";
import { detectObsWebsocket } from "./obsAutoConfig";
import { vodUrl } from "../shared/vod";

export function registerIpc(deps: {
  store: MatchStore;
  settings: SettingsStore;
  getStatus: () => LogsStatusSnapshot | null;
  getWindow: () => BrowserWindow | null;
  onWowDirectoryChanged: (settings: GladlogSettings) => void;
  compare: CompareService;
  analysis: AnalysisService;
  learning: LearningService;
  recorder: RecorderService;
  icons: { get(name: string): Promise<string | null> };
  exportImage: (opts: {
    matchId: string;
    roundSeq?: number | null;
    range?: { fromS: number; toS: number } | null;
    savePath?: string;
  }) => Promise<{ path: string; width: number; height: number } | null>;
}): void {
  ipcMain.handle("gladlog:logs:getStatus", () => deps.getStatus());
  ipcMain.handle("gladlog:icon:get", (_e, name: string) =>
    deps.icons.get(String(name)),
  );
  ipcMain.handle("gladlog:matches:list", () => deps.store.list());
  ipcMain.handle("gladlog:matches:get", (_e, id: string) => deps.store.get(id));
  ipcMain.handle(
    "gladlog:matches:page",
    (_e, opts: { before?: number; limit: number }) => deps.store.page(opts),
  );
  ipcMain.handle("gladlog:matches:rebuildIndex", () =>
    deps.store.rebuildIndex(),
  );
  ipcMain.handle(
    "gladlog:matches:exportImage",
    (
      _e,
      opts: {
        matchId: string;
        roundSeq?: number | null;
        range?: { fromS: number; toS: number } | null;
        savePath?: string;
      },
    ) => deps.exportImage(opts),
  );
  ipcMain.handle(
    "gladlog:matches:rawLine",
    (_e, id: string, opts: { roundSeq?: number | null; lineIndex: number }) =>
      deps.store.rawLine(String(id), {
        roundSeq: opts?.roundSeq ?? null,
        lineIndex: Number(opts?.lineIndex),
      }),
  );
  ipcMain.handle("gladlog:logs:importFiles", async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "选择 WoWCombatLog 文件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Combat Log", extensions: ["txt", "log"] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return importLogFiles(r.filePaths, deps.store, (ch, payload) => {
      deps.getWindow()?.webContents.send(ch, payload);
    });
  });
  ipcMain.handle("gladlog:settings:get", () =>
    redactSettings(deps.settings.get()),
  );
  ipcMain.handle(
    "gladlog:settings:save",
    (_e, rawPartial: Partial<GladlogSettings>) => {
      const partial = sanitizeSettingsPatch(rawPartial);
      const next = deps.settings.save(partial);
      if ("wowDirectory" in partial) deps.onWowDirectoryChanged(next);
      return redactSettings(next);
    },
  );
  ipcMain.handle("gladlog:app:getVersion", () => app.getVersion());
  ipcMain.handle("gladlog:app:selectDirectory", async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    const dirPath = r.filePaths[0]!;
    deps.onWowDirectoryChanged(deps.settings.save({ wowDirectory: dirPath }));
    return dirPath;
  });
  ipcMain.handle("gladlog:app:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return undefined;
  });
  ipcMain.handle("gladlog:compare:run", (_e, input) => deps.compare.run(input));
  ipcMain.handle("gladlog:compare:cancel", () => deps.compare.cancel());
  ipcMain.handle("gladlog:compare:getCached", (_e, matchId: string) =>
    deps.compare.getCached(matchId),
  );
  ipcMain.handle("gladlog:analysis:run", (_e, input) =>
    deps.analysis.run(input),
  );
  ipcMain.handle("gladlog:analysis:cancel", (_e, matchId?: string) =>
    deps.analysis.cancel(matchId),
  );
  ipcMain.handle("gladlog:analysis:getState", (_e, matchId: string) =>
    deps.analysis.getState(matchId),
  );
  ipcMain.handle("gladlog:analysis:getCached", (_e, matchId: string) =>
    deps.analysis.getCached(matchId),
  );
  ipcMain.handle("gladlog:analysis:getFlags", (_e, matchId: string) =>
    deps.analysis.getFlags(matchId),
  );
  ipcMain.handle("gladlog:analysis:aggregate", () => deps.analysis.aggregate());
  ipcMain.handle("gladlog:analysis:listAnalyzed", () =>
    deps.analysis.listAnalyzed(),
  );
  ipcMain.handle("gladlog:debug:aiCalls", () => listAiDebug());
  ipcMain.handle("gladlog:ai:detectCli", (_e, backend: string) =>
    detectCliForBackend(String(backend)),
  );
  ipcMain.handle("gladlog:analysis:notebook", () => deps.analysis.notebook());
  ipcMain.handle("gladlog:analysis:deepen", (_e, input) =>
    deps.analysis.deepen(input),
  );
  ipcMain.handle("gladlog:analysis:analyzeWindow", (_e, input) =>
    deps.analysis.analyzeWindow(input),
  );
  ipcMain.handle(
    "gladlog:analysis:setFlag",
    (_e, matchId: string, key: string, flag: "done" | "recurring" | null) =>
      deps.analysis.setFlag(matchId, key, flag),
  );
  ipcMain.handle("gladlog:recorder:getStatus", () => deps.recorder.getStatus());
  ipcMain.handle(
    "gladlog:recorder:testConnection",
    (_e, overrides?: { url?: string | null; password?: string | null }) =>
      deps.recorder.testConnection(overrides),
  );
  ipcMain.handle("gladlog:recorder:autoConfig", async () => {
    const d = detectObsWebsocket();
    if (!d.found) return { found: false, enabled: false, ok: false };
    const url = `ws://127.0.0.1:${d.port ?? 4455}`;
    const password = d.authRequired ? (d.password ?? null) : null;
    // 直接落库(main 侧真值,不经哨兵);renderer 之后 get 回来是掩码
    deps.settings.save({
      obsWebsocketUrl: url,
      obsWebsocketPassword: password,
    });
    if (!d.enabled) return { found: true, enabled: false, ok: false };
    const r = await deps.recorder.testConnection({ url, password });
    return { found: true, enabled: true, ok: r.ok, error: r.error };
  });
  ipcMain.handle("gladlog:recorder:getForMatch", (_e, matchId: string) => {
    const r = deps.recorder.getForMatch(String(matchId));
    return r
      ? {
          url: vodUrl(r.videoPath),
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt,
        }
      : null;
  });
  ipcMain.handle("gladlog:learning:getRules", () => deps.learning.getRules());
  ipcMain.handle("gladlog:learning:getState", () => deps.learning.getState());
  ipcMain.handle("gladlog:learning:consolidate", () =>
    deps.learning.consolidate(),
  );
}
