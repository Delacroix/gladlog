/**
 * OBS phase-2 gate check -- run this ON WINDOWS, with WoW running.
 *
 *   npm run recorder:gatecheck --workspace=packages/desktop
 *
 * Answers, in one shot, everything design doc 3 says must be confirmed on real
 * hardware before the managed-OBS work starts. THROWAWAY probe: hardcodes,
 * writes to a temp directory, touches no app code.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import OBSWebSocket from "obs-websocket-js";

import { computeVideoWindow } from "../src/shared/videoTime";

const OBS_VERSION = "32.2.1";
const OBS_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/OBS-Studio-${OBS_VERSION}-Windows-x64.zip`;
const OBS_SHA256 =
  "db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de";
const OBS_BYTES = 187_817_017;
const WS_PORT = 4466;
const WS_PASSWORD = "gladlog-gatecheck";
const OVERLAYS = [
  "RTSS",
  "RTSSHooksLoader64",
  "MSIAfterburner",
  "NVIDIA Share",
  "GeForceExperience",
];

const row = (k: string, v: string) => console.log(`${k.padEnd(12)} ${v}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd: string): string =>
  spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
    encoding: "utf-8",
  }).stdout ?? "";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms),
    ),
  ]);
}

function dirSizeMb(dir: string): number {
  let bytes = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else bytes += statSync(p).size;
    }
  };
  walk(dir);
  return Math.round(bytes / 1_000_000);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.error("这个脚本只能在 Windows 上跑 —— 它要验的就是 Windows 行为。");
    process.exit(2);
  }

  const root = join(tmpdir(), "gladlog-obs-gate");
  mkdirSync(root, { recursive: true });
  const zipPath = join(root, "obs.zip");
  const obsRoot = join(root, OBS_VERSION);
  const recDir = join(root, "rec");
  mkdirSync(recDir, { recursive: true });

  // --- download + verify ------------------------------------------------
  if (!existsSync(zipPath) || statSync(zipPath).size !== OBS_BYTES) {
    console.log(`下载 OBS ${OBS_VERSION}(179MB,只下一次)…`);
    const res = await fetch(OBS_URL);
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as never),
      createWriteStream(zipPath),
    );
  }
  const got = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  row(
    "download",
    got === OBS_SHA256 ? `OK (${OBS_BYTES}B)` : `哈希不符 ${got}`,
  );
  if (got !== OBS_SHA256) process.exit(1);

  // --- extract with the system tar (bsdtar) -- assumption under test -----
  const obsExe = join(obsRoot, "bin", "64bit", "obs64.exe");
  if (!existsSync(obsExe)) {
    mkdirSync(obsRoot, { recursive: true });
    const r = spawnSync("tar", ["-xf", zipPath, "-C", obsRoot], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      row("extract", `tar -xf 失败:${(r.stderr ?? "").slice(0, 200)}`);
      process.exit(1);
    }
  }
  row(
    "extract",
    existsSync(obsExe)
      ? `OK (${dirSizeMb(obsRoot)}MB,全量未裁剪)`
      : "obs64.exe 不在预期路径",
  );

  // --- write a minimal portable config ----------------------------------
  writeFileSync(join(obsRoot, "portable_mode.txt"), "");
  const cfg = join(obsRoot, "config", "obs-studio");
  mkdirSync(join(cfg, "plugin_config", "obs-websocket"), { recursive: true });
  mkdirSync(join(cfg, "basic", "profiles", "gladlog"), { recursive: true });
  mkdirSync(join(cfg, "basic", "scenes"), { recursive: true });

  writeFileSync(
    join(cfg, "user.ini"),
    [
      "[General]",
      "FirstRun=true",
      "",
      "[Basic]",
      "Profile=gladlog",
      "ProfileDir=gladlog",
      "SceneCollection=gladlog",
      "SceneCollectionFile=gladlog",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cfg, "global.ini"),
    `[General]\nLastVersion=${OBS_VERSION}\n`,
  );
  writeFileSync(
    join(cfg, "plugin_config", "obs-websocket", "config.json"),
    JSON.stringify({
      first_load: false,
      server_enabled: true,
      server_port: WS_PORT,
      server_password: WS_PASSWORD,
      auth_required: true,
      alerts_enabled: false,
    }),
  );
  writeFileSync(
    join(cfg, "basic", "profiles", "gladlog", "basic.ini"),
    [
      "[General]",
      "Name=gladlog",
      "",
      "[Output]",
      "Mode=Advanced",
      "",
      "[AdvOut]",
      "RecType=Standard",
      `RecFilePath=${recDir}`,
      "RecFormat2=hybrid_mp4",
      "RecEncoder=obs_x264",
      "RecSplitFile=true",
      "",
      "[Video]",
      "AutoRemux=false",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cfg, "basic", "profiles", "gladlog", "recordEncoder.json"),
    JSON.stringify({ rate_control: "CBR", bitrate: 8000, keyint_sec: 1 }),
  );
  writeFileSync(
    join(cfg, "basic", "scenes", "gladlog.json"),
    JSON.stringify({
      name: "gladlog",
      current_scene: "gladlog",
      current_program_scene: "gladlog",
      sources: [
        {
          name: "gladlog",
          id: "scene",
          versioned_id: "scene",
          settings: { items: [] },
        },
      ],
    }),
  );

  // --- environment checks (design doc 3's top three risks) --------------
  const gpuList = ps("Get-CimInstance Win32_VideoController | % { $_.Name }")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const gpuPref = ps(
    "try { (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences').PSObject.Properties | " +
      "? { $_.Name -like '*Wow*' } | % { \"$($_.Name)=$($_.Value)\" } } catch { '' }",
  ).trim();
  row(
    "gpu",
    `显卡 ${gpuList.length} 块:${gpuList.join(" / ")}` +
      (gpuList.length > 1
        ? ` —— 多卡机器,WoW 的 GPU 偏好:${gpuPref || "(未设置)"};` +
          "起录后请对照 OBS 日志里 'Loading up D3D11 on adapter' 那行是否同一块"
        : "(单卡,无适配器不匹配风险)"),
  );

  const wowElevated = ps(
    "try { $p = Get-Process Wow -ErrorAction Stop; " +
      "$p | % { (Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\").CommandLine } | Out-Null; 'running' } " +
      "catch { 'absent' }",
  ).trim();
  const selfAdmin = ps(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ).trim();
  row(
    "integrity",
    `WoW 进程 ${wowElevated};本脚本管理员权限=${selfAdmin} —— ` +
      "若 WoW 提权而这里是 False,钩取会失败(设计文档 §3 第 2 号成因)",
  );

  const running = ps("Get-Process | % { $_.ProcessName }").split(/\r?\n/);
  const hits = OVERLAYS.filter((o) =>
    running.some((p) => p.trim().toLowerCase() === o.toLowerCase()),
  );
  row(
    "hooks",
    hits.length ? `冲突覆盖层在场:${hits.join(", ")}` : "无已知冲突覆盖层",
  );

  // --- spawn ------------------------------------------------------------
  const sentinel = join(cfg, ".sentinel");
  if (existsSync(sentinel)) {
    for (const f of readdirSync(sentinel)) {
      if (f.startsWith("run_")) rmSync(join(sentinel, f), { force: true });
    }
  }
  const bin = join(obsRoot, "bin", "64bit");
  const child = spawn(
    obsExe,
    [
      "--portable",
      "--multi",
      "--only-bundled-plugins",
      "--minimize-to-tray",
      "--disable-updater",
      "--disable-missing-files-check",
      "--collection",
      "gladlog",
      "--profile",
      "gladlog",
      "--scene",
      "gladlog",
      "--websocket_port",
      String(WS_PORT),
      "--websocket_password",
      WS_PASSWORD,
    ],
    { cwd: bin, stdio: "ignore" },
  );

  const obs = new OBSWebSocket();
  // MUST be attached before StartRecord: SplitRecordFile returns no filename,
  // and StopRecord.outputPath keeps returning the FIRST chunk (design doc 2.5).
  const chunks: Array<{ path: string; at: number }> = [];
  obs.on("RecordFileChanged", (d: { newOutputPath: string }) =>
    chunks.push({ path: d.newOutputPath, at: Date.now() }),
  );
  obs.on(
    "RecordStateChanged",
    (d: { outputState: string; outputPath?: string }) => {
      if (d.outputState.endsWith("STARTED") && d.outputPath) {
        chunks.push({ path: d.outputPath, at: Date.now() });
      }
    },
  );

  let hello: { obsWebSocketVersion?: string };
  try {
    hello = await withTimeout(
      obs.connect(`ws://127.0.0.1:${WS_PORT}`, WS_PASSWORD),
      20_000,
      "websocket 连接",
    );
    row("spawn", "OK(连得上就说明事件循环没被模态框阻塞)");
    row("websocket", `OK obs-websocket ${hello.obsWebSocketVersion ?? "?"}`);
  } catch (e) {
    row("spawn", `连不上:${String(e)} —— 去看一眼屏幕上有没有弹窗`);
    child.kill();
    process.exit(1);
  }

  const profile = await obs.call("GetProfileList");
  row(
    "profile",
    profile.currentProfileName === "gladlog"
      ? "OK 生效的是 gladlog(便携路径 cwd 假设成立)"
      : `生效的是 ${profile.currentProfileName} —— 静默回退了,cwd 假设不成立`,
  );

  const kinds = await obs
    .call("GetInputKindList")
    .catch(() => ({ inputKinds: [] as string[] }));
  row(
    "encoders",
    `输入类型 ${kinds.inputKinds.length} 种,game_capture ${
      kinds.inputKinds.includes("game_capture") ? "在" : "不在"
    }`,
  );

  await obs.call("CreateInput", {
    sceneName: "gladlog",
    inputName: "gc",
    inputKind: "game_capture",
    inputSettings: {
      capture_mode: "any_fullscreen",
      priority: 2,
      anti_cheat_hook: true,
    },
    sceneItemEnabled: true,
  });
  await sleep(5000); // give the hook time to attach
  const shotPath = join(root, "shot.png");
  const shot = await obs
    .call("SaveSourceScreenshot", {
      sourceName: "gc",
      imageFormat: "png",
      imageFilePath: shotPath,
    })
    .then(() => "OK")
    .catch((e) => String(e));
  row(
    "capture",
    shot === "OK"
      ? `截图已存 ${shotPath} —— 打开看是不是黑的`
      : `截图失败:${shot}`,
  );

  // --- record + split ---------------------------------------------------
  const recordStart = Date.now();
  await obs.call("StartRecord");
  await sleep(20_000);
  await obs
    .call("SplitRecordFile")
    .catch((e) => row("split", `SplitRecordFile 失败:${String(e)}`));
  await sleep(3000);
  await obs.call("StopRecord");
  await sleep(2000);
  const recordEnd = Date.now();

  row(
    "split",
    chunks.length
      ? `拿到 ${chunks.length} 个分片路径:${chunks.map((c) => c.path).join(" | ")}`
      : "没收到任何 RecordFileChanged / RecordStateChanged 路径",
  );

  // headroom through the SAME predicate the product uses (shared-predicate rule)
  const first = chunks[0];
  if (first) {
    const w = computeVideoWindow({
      matchStartMs: first.at + 5000, // simulated opening 5s into the chunk
      matchEndMs: recordEnd,
      recordingStartedAtMs: first.at,
      durationS: (recordEnd - first.at) / 1000,
    });
    row("headroom", `${w.headroomS.toFixed(2)}s(带符号;二期目标恒为正)`);
  } else {
    row("headroom", "无分片路径,算不出");
  }

  const files = readdirSync(recDir).map((f) => statSync(join(recDir, f)).size);
  const total = files.reduce((n, x) => n + x, 0);
  const secs = (recordEnd - recordStart) / 1000;
  row(
    "bitrate",
    `${(total / 1_000_000).toFixed(1)}MB / ${secs.toFixed(0)}s → 约 ${(
      (total * 8) /
      secs /
      1e6
    ).toFixed(1)} Mbps(用来定设计文档 §10 U2)`,
  );

  await obs.disconnect();
  child.kill();
  console.log("\n产物目录(截图与录像都在,自己看完再删):", root);
}

main().catch((e) => {
  console.error("门测失败:", e);
  process.exit(1);
});
