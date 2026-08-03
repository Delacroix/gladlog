import { app, BrowserWindow, safeStorage, screen } from "electron";
import log from "electron-log/main";
import { join } from "path";
import type { WorkerConfig } from "../shared/protocol";
import type { LogsStatusSnapshot } from "../preload/api";
import {
  detectWowDirCandidates,
  realFsProbe,
  resolveLogsDir,
} from "./detectWowDir";
import { exportReportImage } from "./exportImage";
import { registerIpc } from "./ipc";
import { MatchStore } from "./matchStore";
import {
  SettingsStore,
  type GladlogSettings,
  type SettingsStoreWarning,
} from "./settingsStore";
import { WorkerHost } from "./workerHost";
import { createWorkerMessageHandler } from "./workerMessageHandler";
import { realClientFactory, stopAllAiActivity } from "./ai";
import { createIconCache } from "./iconCache";
import { createCompareService } from "./compare";
import { createAnalysisService } from "./analysis";
import { createCoachChatService } from "./coachChat";
import { createLearningService } from "./learning";
import { createRecorderService, type RecorderService } from "./recorder";
import { realObsClient } from "./obsClient";
import { RecordingsStore } from "./recordingsStore";
import { createQuitLifecycleHandler } from "./quitLifecycle";
import { handleVodProtocol, registerVodScheme } from "./vodProtocol";
import { loadWindowState, MIN_WINDOW, saveWindowState } from "./windowState";
import { loadBundledCorpus, gameBuildFromManifest } from "./corpusLoader";
import datagenManifest from "@gladlog/analysis/src/data/datagen-manifest.json";
import { e2eUserDataDir } from "./e2eEnv";

app.setName("gladlog");
// The privileged vod:// scheme must be registered before app ready
registerVodScheme();
// E2E: must come before any app.getPath('userData') call (settings below is one)
const e2eDir = e2eUserDataDir(process.env);
if (e2eDir) app.setPath("userData", e2eDir);

log.initialize();
process.on("uncaughtException", (e) => log.error("[main] uncaught:", e));
process.on("unhandledRejection", (e) =>
  log.error("[main] unhandled rejection:", e),
);

let win: BrowserWindow | null = null;
let lastStatus: LogsStatusSnapshot | null = null;
const quarantined: string[] = [];

const userData = () => app.getPath("userData");
// #21 item7: encrypt secrets at rest — safeStorage is an electron-specific
// dependency, so it is injected rather than letting settingsStore.ts import
// "electron" directly (keeping it electron-free and unit-testable under plain node).
const onSettingsWarn = (w: SettingsStoreWarning) =>
  log.warn(`[settings] ${w.kind}${w.field ? `(${w.field})` : ""}: ${w.detail}`);
const settings = new SettingsStore(
  join(app.getPath("userData"), "settings.json"),
  safeStorage,
  onSettingsWarn,
);
let store: MatchStore;
let host: WorkerHost | null = null;
let recorder: RecorderService | null = null;

// C2 fix: on exit we must wait for recorder.stop() (StopRecord's async round
// trip) to finish before actually calling app.quit(), or OBS will very likely
// keep recording forever after the process dies. See the semantics comment in
// quitLifecycle.ts; here we only wire in the three electron-specific dependencies.
const quitLifecycle = createQuitLifecycleHandler({
  stopRecorder: () => recorder?.stop() ?? Promise.resolve(),
  stopHost: () => host?.stop(),
  // #21 item9: for completeness, also shut down in-flight AI analysis (CLI
  // subprocesses / DeepSeek fetches); not a pre-existing bug (they would die
  // naturally once the host exits anyway).
  stopAiActivity: () => stopAllAiActivity(),
  quit: () => app.quit(),
});
app.on("before-quit", (event) => quitLifecycle.onBeforeQuit(event));

function createWindow(): BrowserWindow {
  // UI redesign 2026-08-01: the two-column layout only kicks in at ≥1440px, so
  // the old 1200 default could never show it — the default is raised to
  // 1600×1000 (clamped to the work area on small screens) and the last bounds
  // are remembered.
  const statePath = join(userData(), "window-state.json");
  const saved = loadWindowState(statePath);
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(saved?.width ?? 1600, work.width);
  const height = Math.min(saved?.height ?? 1000, work.height);
  // The saved position must leave a minimum visible area on some display (agy
  // review #4: checking only the top-left corner meant a window flush against
  // the right screen edge could restore with just a few draggable pixels left,
  // effectively invisible) — the intersection with some work area must be
  // ≥ 200×100; otherwise drop the position and let the OS place the window.
  const posValid =
    saved?.x !== undefined &&
    saved?.y !== undefined &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const visW =
        Math.min(saved.x! + width, a.x + a.width) - Math.max(saved.x!, a.x);
      const visH =
        Math.min(saved.y! + height, a.y + a.height) - Math.max(saved.y!, a.y);
      return visW >= 200 && visH >= 100;
    });
  const w = new BrowserWindow({
    width,
    height,
    ...(posValid ? { x: saved!.x, y: saved!.y } : {}),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (saved?.maximized) w.maximize();
  // getNormalBounds is still reliable at close time (it is not after destroy);
  // when maximized we store the restored size plus the maximized flag, so next
  // launch opens maximized with the correct restored size.
  w.on("close", () => {
    const b = w.getNormalBounds();
    saveWindowState(statePath, {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: w.isMaximized(),
    });
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env["ELECTRON_RENDERER_URL"])
    w.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else w.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return w;
}

function workerConfig(wowDirectory: string): WorkerConfig {
  return {
    logsDir: resolveLogsDir(wowDirectory),
    checkpointsPath: join(userData(), "checkpoints.json"),
    quarantined,
    flushIntervalMs: 2000,
    quietPeriodMs: 5000,
  };
}

// The message routing itself lives in workerMessageHandler.ts (pure and
// testable); here we only wire in electron-specific dependencies (store /
// recorder / win are module-level `let`s captured by closure at handler
// construction, and calls only happen after whenReady has assigned them all —
// equivalent to the old direct closure references).
const onWorkerMessage = createWorkerMessageHandler({
  store: { store: (item) => store.store(item) },
  recorder: {
    associate: (m) => recorder?.associate(m),
    onSegmentOpen: (o) => recorder?.onSegmentOpen(o),
    onSegmentClose: (o) => recorder?.onSegmentClose(o),
  },
  emit: (ch, payload) => win?.webContents.send(ch, payload),
  setStatus: (s) => {
    lastStatus = s;
  },
  logWarn: (m) => log.warn(m),
});

function startMonitoring(s: GladlogSettings): void {
  let dir = s.wowDirectory;
  if (!dir) {
    dir =
      detectWowDirCandidates({
        platform: process.platform,
        probe: realFsProbe(),
      })[0] ?? null;
    if (dir) settings.save({ wowDirectory: dir });
  }
  if (!dir) return; // wait for the user to pick one manually
  const config = workerConfig(dir);
  if (host) host.reconfigure(config);
  else {
    host = new WorkerHost({
      workerModulePath: join(import.meta.dirname, "worker.js"),
      onMessage: onWorkerMessage,
      onQuarantine: (fileKey) => {
        quarantined.push(fileKey);
        log.error(`quarantined ${fileKey}`);
      },
      log: { info: (m) => log.info(m), error: (m) => log.error(m) },
    });
    host.start(config);
  }
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.whenReady().then(() => {
    store = new MatchStore(join(userData(), "matches"));
    store.init();
    win = createWindow();
    // SP-B2.1: the userData override path takes priority over the bundled corpus
    // — shipping a new reference_vectors.json needs no new installer, just drop
    // the file into the user data directory and restart the app. If the override
    // file is missing, corrupt, or the wrong shape, it transparently falls back
    // to the bundled version (see corpusLoader.loadBundledCorpus).
    const corpusPaths = () => [
      join(userData(), "reference_vectors.json"),
      app.isPackaged
        ? join(process.resourcesPath, "reference_vectors.json")
        : join(
            import.meta.dirname,
            "../../../corpus-tools/data/reference_vectors.json",
          ),
    ];

    const compare = createCompareService({
      getSettings: () => settings.get(),
      matchesDir: join(userData(), "matches"),
      loadCorpus: loadBundledCorpus(
        corpusPaths,
        (info) =>
          log.info(
            `[corpus] loaded ${info.path} (wowPatchVersion=${info.wowPatchVersion}, builtAt=${info.builtAt})`,
          ),
        (info) => log.warn(`[corpus] skipped ${info.path}: ${info.reason}`),
      ),
      gameBuild: () =>
        gameBuildFromManifest(datagenManifest as { build?: string }),
      emit: (ch, payload) => win?.webContents.send(ch, payload),
    });
    const learning = createLearningService({
      getSettings: () => settings.get(),
      matchesDir: join(userData(), "matches"),
      learningDir: join(userData(), "learning"),
      clientFactory: realClientFactory,
      emit: (ch, payload) => win?.webContents.send(ch, payload),
    });
    const analysis = createAnalysisService({
      getSettings: () => settings.get(),
      matchesDir: join(userData(), "matches"),
      clientFactory: realClientFactory,
      emit: (ch, payload) => win?.webContents.send(ch, payload),
      onFindings: (e) => learning.recordAnalysis(e),
    });
    const coachChat = createCoachChatService({
      getSettings: () => settings.get(),
      matchesDir: join(userData(), "matches"),
    });
    const icons = createIconCache({
      cacheDir: join(app.getPath("userData"), "icons"),
      // No network under E2E (visual regression): see iconCache's offline comment.
      offline: process.env["GLADLOG_E2E"] === "1",
    });
    const recordings = new RecordingsStore(
      join(userData(), "recordings"),
      (m) => log.info(m),
    );
    recorder = createRecorderService({
      getSettings: () => settings.get(),
      recordings,
      clientFactory: realObsClient,
      emit: (ch, payload) => win?.webContents.send(ch, payload),
    });
    recorder.pruneNow();
    // Review Important #2: connect once at startup so a healthy setup does
    // not show "未连接" until the first match opens. Fire-and-forget -- it
    // never throws (degrades to lastError + pushStatus internally) and window
    // creation must not wait on OBS being reachable.
    void recorder.connectAtStartup();
    handleVodProtocol((p) => recordings.list().some((r) => r.videoPath === p));
    registerIpc({
      recorder,
      store,
      settings,
      getStatus: () => lastStatus,
      getWindow: () => win,
      onWowDirectoryChanged: (s) => startMonitoring(s),
      compare,
      analysis,
      learning,
      chat: coachChat,
      icons,
      exportImage: (opts) =>
        exportReportImage({
          ...opts,
          parent: win,
          preloadPath: join(import.meta.dirname, "../preload/index.cjs"),
          rendererUrl: process.env["ELECTRON_RENDERER_URL"] ?? null,
          rendererFile: join(import.meta.dirname, "../renderer/index.html"),
        }),
    });
    learning.init();
    startMonitoring(settings.get());
  });
  app.on("window-all-closed", () => {
    // Recording and worker teardown are handled uniformly by the before-quit
    // hook above (quitLifecycle) — app.quit() triggers it and only exits once
    // recorder.stop() has actually finished (with a capped timeout).
    app.quit();
  });
}
