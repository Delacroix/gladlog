import { writeFile } from "node:fs/promises";
import { homedir } from "os";
import { join } from "path";

import { listAiDebug } from "./aiDebugLog";
import { createBugReport, type BugReportInput } from "./bugReport";
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
import type { createCoachChatService } from "./coachChat";

type CoachChatService = ReturnType<typeof createCoachChatService>;
import {
  authUnknownHint,
  detectObsWebsocket,
  resolveAutoConfigPassword,
} from "./obsAutoConfig";
import { vodUrl } from "../shared/vod";
import type { ObsInstallProgress } from "./obsAssets";

export function registerIpc(deps: {
  store: MatchStore;
  settings: SettingsStore;
  getStatus: () => LogsStatusSnapshot | null;
  getWindow: () => BrowserWindow | null;
  onWowDirectoryChanged: (settings: GladlogSettings) => void;
  /** Task-5b runtime toggle (复核 NEW-3): called after every settings:save
   * with the settings before/after the patch, so index.ts can compare
   * isManagedActive() and run assembly/teardown without an app restart.
   * Awaited before settings:save resolves -- the renderer's save button
   * should not report success before the managed session has actually
   * started/stopped reacting. Optional so tests that don't care about
   * managed recording can omit it. */
  onSettingsSaved?: (
    prev: GladlogSettings,
    next: GladlogSettings,
  ) => void | Promise<void>;
  /** Task-5b: the renderer's "下载并启用" action (recorder:installObs IPC).
   * Wraps assets.ensureInstalled() + a post-install assembly run; index.ts
   * owns both the ObsAssets instance and the assembly re-run so this module
   * stays electron-and-OBS-agnostic like every other IPC handler here. */
  installObs: (onProgress: (p: ObsInstallProgress) => void) => Promise<void>;
  /** 复核 I4 (task-5b review round 2): a durable, pollable "is managed OBS
   * installed" query the settings row can call ON MOUNT — the push-only
   * `gladlog:recorder:status` channel only announces 待安装 at whatever
   * moment assembly happens to run (typically before the renderer has even
   * subscribed), so a fresh launch with OBS not yet installed showed 未连接
   * forever, never 待安装. */
  getObsInstallState: () => { installed: boolean };
  compare: CompareService;
  analysis: AnalysisService;
  learning: LearningService;
  recorder: RecorderService;
  chat: CoachChatService;
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
  // Progress goes over an emit channel (same pattern as logs:importProgress):
  // a whole-library rebuild takes minutes, and the developer page wants to
  // show x/n inline instead of popping an alert once it finishes.
  ipcMain.handle("gladlog:matches:rebuildIndex", () =>
    deps.store.rebuildIndex((p) => {
      deps.getWindow()?.webContents.send("gladlog:matches:rebuildProgress", p);
    }),
  );
  ipcMain.handle("gladlog:matches:reparse", (_e, id: string) =>
    deps.store.reparse(String(id)),
  );
  // The directory path is resolved by the store from its index; the renderer
  // only passes an id — no opening for an outside caller to construct an
  // arbitrary shell.openPath argument.
  ipcMain.handle("gladlog:matches:openDir", async (_e, id: string) => {
    const dir = deps.store.dirOf(String(id));
    if (!dir) return false;
    const err = await shell.openPath(dir);
    return err === "";
  });
  // Bug report (2026-08-02): bundle that match's raw.txt + the AI
  // prompt/response + the user's comment, write it to ~/gladlog-sync/bugreports
  // (a Drive-synced folder, so writing uploads it) or keep it locally, and
  // reveal the result in the file manager right after it is generated.
  ipcMain.handle("gladlog:bugreport:create", (_e, input: BugReportInput) => {
    const r = createBugReport({
      input: {
        matchId: input?.matchId ?? null,
        roundSeq: input?.roundSeq ?? null,
        comment: String(input?.comment ?? ""),
      },
      matchesDir: join(app.getPath("userData"), "matches"),
      getMeta: (id) => deps.store.list().find((m) => m.id === id) ?? null,
      appVersion: app.getVersion(),
      platform: process.platform,
      homeDir: homedir(),
      userDataDir: app.getPath("userData"),
    });
    shell.showItemInFolder(r.dir);
    return r;
  });
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
    async (_e, rawPartial: Partial<GladlogSettings>) => {
      const partial = sanitizeSettingsPatch(rawPartial);
      const prev = deps.settings.get();
      const next = deps.settings.save(partial);
      if ("wowDirectory" in partial) deps.onWowDirectoryChanged(next);
      // Task-5b runtime toggle (复核 NEW-3): awaited so the renderer's save
      // does not report success before a managed session actually reacted.
      await deps.onSettingsSaved?.(prev, next);
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
  // Write text to disk + system save dialog (the developer page's "export
  // redacted fixture"). Redaction happens in the renderer — it already holds
  // the parsed doc, and making main re-parse another 62MB would be pure waste.
  ipcMain.handle(
    "gladlog:app:saveTextFile",
    async (_e, opts: { defaultName: string; text: string }) => {
      const win = deps.getWindow();
      if (!win) return null;
      const r = await dialog.showSaveDialog(win, {
        title: "保存文件",
        defaultPath: String(opts?.defaultName ?? "export.json"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (r.canceled || !r.filePath) return null;
      await writeFile(r.filePath, String(opts?.text ?? ""), "utf-8");
      return r.filePath;
    },
  );
  ipcMain.handle("gladlog:compare:run", (_e, input) => deps.compare.run(input));
  ipcMain.handle("gladlog:compare:cancel", () => deps.compare.cancel());
  ipcMain.handle("gladlog:compare:getCached", (_e, matchId: string) =>
    deps.compare.getCached(matchId),
  );
  ipcMain.handle("gladlog:compare:getState", (_e, matchId: string) =>
    deps.compare.getState(matchId),
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
  ipcMain.handle(
    "gladlog:analysis:getCached",
    (_e, matchId: string, slotKey?: string) =>
      deps.analysis.getCached(matchId, slotKey),
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
    const password = resolveAutoConfigPassword(d);
    // Persist directly (the main-side true value, not the sentinel); what the
    // renderer gets back later is masked
    deps.settings.save({
      obsWebsocketUrl: url,
      obsWebsocketPassword: password,
    });
    if (!d.enabled) return { found: true, enabled: false, ok: false };
    const r = await deps.recorder.testConnection({ url, password });
    const hint = authUnknownHint(d.authRequired, r.ok);
    const error = hint ? (r.error ? `${r.error};${hint}` : hint) : r.error;
    return { found: true, enabled: true, ok: r.ok, error };
  });
  // Task-5b: the renderer's "下载并启用" action. Progress is pushed on a
  // separate emit channel (same pattern as logs:importProgress /
  // matches:rebuildProgress above) since a 179MB download takes real time
  // and the settings page wants live x/total, not a single alert at the end.
  ipcMain.handle("gladlog:recorder:installObs", async () => {
    try {
      await deps.installObs((p) => {
        deps
          .getWindow()
          ?.webContents.send("gladlog:recorder:installProgress", p);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  // 复核 I4: durable query, callable on mount (unlike the push-only status
  // channel) so the settings row can render 待安装 immediately instead of
  // waiting for a status push that may have already fired before it mounted.
  ipcMain.handle("gladlog:recorder:obsInstallState", () =>
    deps.getObsInstallState(),
  );
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
  ipcMain.handle("gladlog:chat:getState", (_e, matchId: string) =>
    deps.chat.getState(String(matchId)),
  );
  ipcMain.handle("gladlog:chat:send", (_e, input) => deps.chat.send(input));
  ipcMain.handle("gladlog:chat:cancel", (_e, matchId: string) =>
    deps.chat.cancel(String(matchId)),
  );
}
