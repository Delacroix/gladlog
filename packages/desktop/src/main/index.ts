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
// #21 item7:密钥落盘加密——safeStorage 是 electron 具体依赖,注入而非让
// settingsStore.ts 直接 import "electron"(保持它 electron-free、纯 node 单测)。
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
  // UI 改版 2026-08-01:双栏 ≥1440px 才生效,旧默认 1200 永远看不到 ——
  // 默认升到 1600×1000(小屏钳到工作区),并记忆上次 bounds。
  const statePath = join(userData(), "window-state.json");
  const saved = loadWindowState(statePath);
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(saved?.width ?? 1600, work.width);
  const height = Math.min(saved?.height ?? 1000, work.height);
  // 上次位置必须在某块屏幕上留有最小可见区域(agy 复核 #4:只查左上角时,
  // 贴屏幕右缘的窗口恢复后可能只剩几像素可拖,形同隐形)——要求与某工作区
  // 的交集 ≥ 200×100,不满足则丢弃位置交系统摆放。
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
  // close 时机 getNormalBounds 仍可靠(destroyed 之后就不行);最大化时存的
  // 是还原尺寸 + maximized 标志,下次以最大化打开且还原尺寸正确。
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

// 消息路由本体在 workerMessageHandler.ts(纯函数、可测);这里只接 electron
// 具体依赖(store/recorder/win 是模块级 let,handler 构造时闭包引用,
// 调用发生在 whenReady 全部赋值完成之后 —— 与旧版直接闭包引用等价)。
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
    const icons = createIconCache({
      cacheDir: join(app.getPath("userData"), "icons"),
      // E2E(视觉回归)下不取网:见 iconCache 的 offline 注释。
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
