import { app, BrowserWindow } from "electron";
import log from "electron-log/main";
import { join } from "path";
import type { WorkerConfig, WorkerToMain } from "../shared/protocol";
import type { LogsStatusSnapshot } from "../preload/api";
import {
  detectWowDirCandidates,
  realFsProbe,
  resolveLogsDir,
} from "./detectWowDir";
import { exportReportImage } from "./exportImage";
import { registerIpc } from "./ipc";
import { MatchStore } from "./matchStore";
import { SettingsStore, type GladlogSettings } from "./settingsStore";
import { WorkerHost } from "./workerHost";
import { realClientFactory, stopAllAiActivity } from "./ai";
import { createIconCache } from "./iconCache";
import { createCompareService } from "./compare";
import { createAnalysisService } from "./analysis";
import { createLearningService } from "./learning";
import { createRecorderService, type RecorderService } from "./recorder";
import { realObsClient } from "./obsClient";
import { RecordingsStore } from "./recordingsStore";
import { createQuitLifecycleHandler } from "./quitLifecycle";
import { handleVodProtocol, registerVodScheme } from "./vodProtocol";
import { loadBundledCorpus, gameBuildFromManifest } from "./corpusLoader";
import datagenManifest from "@gladlog/analysis/src/data/datagen-manifest.json";
import { e2eUserDataDir } from "./e2eEnv";

app.setName("gladlog");
// vod:// 特权 scheme 必须在 app ready 前注册
registerVodScheme();
// E2E:必须早于任何 app.getPath('userData') 调用(下方 settings 即是)
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
const settings = new SettingsStore(
  join(app.getPath("userData"), "settings.json"),
);
let store: MatchStore;
let host: WorkerHost | null = null;
let recorder: RecorderService | null = null;

// C2 修复:退出时必须等 recorder.stop()(StopRecord 的异步往返)跑完再真正
// app.quit(),否则 OBS 大概率在进程死后继续录到天荒地老。见 quitLifecycle.ts
// 的语义注释;这里只是把 electron 具体的三个依赖接进去。
const quitLifecycle = createQuitLifecycleHandler({
  stopRecorder: () => recorder?.stop() ?? Promise.resolve(),
  stopHost: () => host?.stop(),
  // #21 item9:完整性起见一并收掉飞行中的 AI 分析(CLI 子进程/DeepSeek
  // fetch),不算既有 bug(宿主退出后它们本就会自然断)。
  stopAiActivity: () => stopAllAiActivity(),
  quit: () => app.quit(),
});
app.on("before-quit", (event) => quitLifecycle.onBeforeQuit(event));

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

function onWorkerMessage(msg: WorkerToMain): void {
  if (msg.type === "match" || msg.type === "shuffle") {
    const r = store.store(msg.payload);
    if (r.stored && r.meta) {
      recorder?.associate(r.meta);
      win?.webContents.send("gladlog:logs:matchStored", r.meta);
    }
  } else if (msg.type === "segmentOpen") {
    recorder?.onSegmentOpen({
      startTime: msg.startTime,
      bracket: msg.bracket,
    });
  } else if (msg.type === "segmentClose") {
    recorder?.onSegmentClose({ endTime: msg.endTime, aborted: msg.aborted });
  } else if (msg.type === "status") {
    lastStatus = {
      watching: msg.watching,
      logsDir: msg.logsDir,
      files: msg.files,
    };
    win?.webContents.send("gladlog:logs:statusChanged", lastStatus);
  } else if (msg.type === "diagnostic") {
    const entry = {
      fileKey: msg.fileKey,
      code: msg.code,
      detail: msg.detail,
      at: Date.now(),
    };
    log.warn("[worker diagnostic]", JSON.stringify(entry));
    win?.webContents.send("gladlog:logs:diagnostic", entry);
  }
}

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
  if (!dir) return; // 等用户手选
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
    // SP-B2.1:userData 覆盖路径优先于内置语料 —— 换新 reference_vectors.json
    // 不必重发安装包,把新文件丢进用户数据目录、重启 app 即生效;覆盖文件
    // 缺失/损坏/形状不对时透明回退到内置版本(见 corpusLoader.loadBundledCorpus)。
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
      loadCorpus: loadBundledCorpus(corpusPaths, (info) =>
        log.info(
          `[corpus] loaded ${info.path} (wowPatchVersion=${info.wowPatchVersion}, builtAt=${info.builtAt})`,
        ),
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
    const icons = createIconCache({
      cacheDir: join(app.getPath("userData"), "icons"),
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
    // 录像/worker 收尾统一交给上面的 before-quit 钩子(quitLifecycle)—
    // app.quit() 会触发它,等 recorder.stop() 真正跑完(封顶超时)才退出。
    app.quit();
  });
}
