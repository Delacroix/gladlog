import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Spawns and supervises the managed portable OBS process (design doc §5.4/
 * §5.6). Readiness is decided from OBS's OWN LOG, never a bare TCP probe —
 * ECONNREFUSED conflates "OBS hasn't started yet", "portable mode didn't
 * take", "websocket bound the wrong interface", and "OBS crashed" into one
 * indistinguishable symptom; the log spells out which one happened in a
 * single line each (真机教训 2, 2026-08-04).
 *
 * Real-machine status (2026-08-04): a manual launch with the exact flag set
 * below works (Portable mode: true, websocket on 4466 confirmed in the log —
 * literal line "Server started successfully on port 4466", recorded in the
 * stage-0 ledger). The gate script's own spawn of the same exe, however,
 * never produced a log file at all under its old ad-hoc spawn — cause
 * undiagnosed as of this module landing. `--minimize-to-tray`, `stdio:
 * "ignore"`, and the spawn environment are all suspects; NONE is assumed
 * guilty here — the flags below are the product-path defaults exactly as
 * specified, unchanged, and `extraArgs` exists solely so the gate script can
 * vary one thing at a time on the next real-machine run (single-variable
 * protocol, task-3 brief). Do not "clean up" extraArgs away.
 */

export interface ManagedObsHandle {
  /** Resolves once OBS's own log confirms readiness: a line containing
   * "Portable mode: true" AND a line matching the tolerant regex
   * /obs-websocket.*erver started/ — both found in a log file that appeared
   * AFTER this spawn (never a pre-existing file from an earlier run; the
   * portable logs dir accumulates across runs and an old log can contain
   * every keyword this looks for). "Portable mode: false" rejects
   * immediately. A timeout rejects with the tail of the new log, or "OBS 未
   * 产出日志" when no new log file ever appeared — that distinction is the
   * whole diagnostic value of this module. */
  ready: Promise<{ wsUrl: string }>;
  /** Fires for every complete new line read from any post-spawn log file,
   * in order, exactly once each. Returns an unsubscribe function. */
  onLogLine(cb: (line: string) => void): () => void;
  /** Async graceful stop: ask nicely (child.kill()), give it 3s, then
   * escalate to a tree-kill (taskkill /pid <pid> /T /F on Windows) if it
   * hasn't exited by then. Resolves once the process has actually exited. */
  stop(): Promise<void>;
  /** Synchronous, forceful kill for exit paths that cannot await (SIGINT
   * handlers, process.on("exit"), Electron will-quit). No grace period. */
  killSync(): void;
  exited(): { code: number | null; signal: string | null } | null;
  pid(): number | null;
}

export interface SpawnManagedObsSpec {
  /** Portable OBS root, e.g. <userData>/obs/32.2.1 — same directory
   * writeObsConfig(obsRoot) writes into and createObsAssets(...).root
   * resolves to. */
  obsRoot: string;
  /** Managed instance's websocket port — used only to build the returned
   * wsUrl; the product path does NOT pass a --websocket_port flag (the port
   * lives in config.json, written by writeObsConfig). */
  wsPort: number;
  /** Injected for tests; defaults to node:child_process's spawn. */
  spawnImpl?: typeof spawn;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Default 30_000. */
  readinessTimeoutMs?: number;
  /** GATE-SCRIPT ONLY (single-variable experiment discipline, brief 复核
   * I6): the gate script's first real-machine run keeps its original
   * --websocket_port/--websocket_password flags, passed through here.
   * The product path never sets this — port/password live in config.json. */
  extraArgs?: string[];
  /** Injected for tests: the forceful tree-kill used by both stop()'s
   * escalation and killSync(). Defaults to
   * `taskkill /pid <pid> /T /F` (Windows-only in production; this module is
   * never invoked off-Windows in practice, matching managed recording being
   * win32-only elsewhere). Never throws in the default impl — best effort,
   * the process may already be gone. */
  killTreeImpl?: (pid: number) => void;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const GRACE_STOP_MS = 3_000;
const TAIL_LINES = 20;

/** Tolerant on purpose: the brief records the real machine's literal line as
 * "Server started successfully on port 4466", but obs-websocket's exact
 * wording is not a contract gladlog controls — matching on the stable
 * substring ("erver started") rather than the full sentence survives minor
 * upstream wording changes. */
const WS_STARTED_RE = /obs-websocket.*erver started/;
const PORTABLE_FALSE_RE = /Portable mode:\s*false/;
const PORTABLE_TRUE_RE = /Portable mode:\s*true/;

function defaultKillTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } catch {
    // Best effort: the process may already be gone, or (off-Windows, e.g.
    // this module's own vitest suite on mac) taskkill doesn't exist at all —
    // callers inject killTreeImpl in tests precisely to avoid hitting this.
  }
}

export function spawnManagedObs(spec: SpawnManagedObsSpec): ManagedObsHandle {
  const spawnImpl = spec.spawnImpl ?? spawn;
  // spec.now is accepted (matches the brief's documented interface / this
  // codebase's injectable-clock convention, e.g. recorder.ts) but unused —
  // setTimeout/setInterval alone are enough to drive readiness/timeout, and
  // vitest's fake timers already patch those directly in tests.
  const timeoutMs = spec.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const killTreeImpl = spec.killTreeImpl ?? defaultKillTree;

  const bin = join(spec.obsRoot, "bin", "64bit");
  const exePath = join(bin, "obs64.exe");
  const logsDir = join(spec.obsRoot, "config", "obs-studio", "logs");

  // Snapshot BEFORE spawning (brief 复核 B6): only log files that appear
  // after this point are ever consulted for readiness. The portable logs
  // dir accumulates across runs, and a prior successful run's log contains
  // every keyword readiness looks for — without this snapshot, that stale
  // file would false-positive an early resolve pointed at a process that
  // isn't actually up yet.
  let preSpawnFiles: Set<string>;
  try {
    preSpawnFiles = new Set(
      readdirSync(logsDir).filter((f) => f.endsWith(".txt")),
    );
  } catch {
    preSpawnFiles = new Set();
  }

  const args = [
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
    "--websocket_ipv4_only",
    ...(spec.extraArgs ?? []),
  ];

  const child: ChildProcess = spawnImpl(exePath, args, {
    cwd: bin,
    stdio: "ignore",
  });

  let exitInfo: { code: number | null; signal: string | null } | null = null;
  let settled = false;
  let sawAnyNewFile = false;
  let portableTrue = false;
  let wsStarted = false;
  const tailLines: string[] = [];
  const fileStates = new Map<string, { offset: number; pending: string }>();
  const lineListeners = new Set<(line: string) => void>();

  let resolveReady!: (v: { wsUrl: string }) => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<{ wsUrl: string }>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // A caller that never awaits `ready` before the process dies unexpectedly
  // (e.g. immediately calling stop()/killSync(), or a test asserting on
  // exited()/pid() without touching readiness) must not turn this into an
  // unhandled-rejection crash. This attaches a silent handler directly to
  // the SAME promise object returned below — it does not consume or alter
  // what a real caller sees from their own `await handle.ready` / `.catch`,
  // it only satisfies Node's "was a handler attached" check.
  ready.catch(() => {});

  function settleResolve(v: { wsUrl: string }): void {
    if (settled) return;
    settled = true;
    clearTimeout(readinessTimer);
    resolveReady(v);
  }
  function settleReject(e: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(readinessTimer);
    rejectReady(e);
  }

  function handleLine(line: string): void {
    tailLines.push(line);
    if (tailLines.length > TAIL_LINES) tailLines.shift();
    for (const cb of lineListeners) cb(line);
    if (settled) return;
    if (PORTABLE_FALSE_RE.test(line)) {
      settleReject(
        new Error(`OBS 便携模式未生效(${line.trim()});检查 portable_mode.txt`),
      );
      return;
    }
    if (PORTABLE_TRUE_RE.test(line)) portableTrue = true;
    if (WS_STARTED_RE.test(line)) wsStarted = true;
    if (portableTrue && wsStarted) {
      settleResolve({ wsUrl: `ws://127.0.0.1:${spec.wsPort}` });
    }
  }

  function pollOnce(): void {
    let currentFiles: string[];
    try {
      currentFiles = readdirSync(logsDir).filter((f) => f.endsWith(".txt"));
    } catch {
      currentFiles = [];
    }
    const newFiles = currentFiles.filter((f) => !preSpawnFiles.has(f));
    for (const f of newFiles) {
      if (!fileStates.has(f)) {
        fileStates.set(f, { offset: 0, pending: "" });
        sawAnyNewFile = true;
      }
    }
    for (const f of newFiles) {
      const state = fileStates.get(f);
      if (!state) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(join(logsDir, f));
      } catch {
        continue; // deleted/locked mid-poll — try again next tick
      }
      if (buf.length <= state.offset) continue;
      const chunk = buf.subarray(state.offset).toString("utf-8");
      state.offset = buf.length;
      const combined = state.pending + chunk;
      const parts = combined.split(/\r?\n/);
      state.pending = parts.pop() ?? "";
      for (const rawLine of parts) handleLine(rawLine);
    }
  }

  const pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  const readinessTimer = setTimeout(() => {
    if (settled) return;
    if (!sawAnyNewFile) {
      settleReject(
        new Error(
          `OBS 未产出日志(spawn 后 ${timeoutMs}ms 内 ${logsDir} 下没有出现新文件)`,
        ),
      );
    } else {
      settleReject(
        new Error(
          `OBS 就绪超时(${timeoutMs}ms)。新日志尾部 ${tailLines.length} 行:\n${tailLines.join("\n")}`,
        ),
      );
    }
  }, timeoutMs);

  function cleanupTimers(): void {
    clearInterval(pollTimer);
    clearTimeout(readinessTimer);
  }

  // Single terminal-state notifier, fed by every path that can end the
  // process's life (see review fix below). `stop()` awaits this instead of
  // registering its own "exit" listener, so it resolves no matter WHICH
  // underlying Node event actually fired.
  let exitResolve!: () => void;
  const exitedOnce = new Promise<void>((res) => {
    exitResolve = res;
  });

  /** First terminal event wins; later ones (e.g. "close" arriving after
   * "exit" already set it) are no-ops. Guarantees exited() is non-null and
   * exitedOnce resolves exactly once, from whichever of "exit"/"close"/a
   * pid-less "error" gets there first. */
  function markExited(code: number | null, signal: string | null): void {
    if (exitInfo !== null) return;
    exitInfo = { code, signal };
    cleanupTimers();
    exitResolve();
    if (!settled) {
      settleReject(
        new Error(
          `OBS 进程已退出(code=${code ?? "null"}, signal=${signal ?? "null"})且未确认就绪`,
        ),
      );
    }
  }

  child.on("error", (err) => {
    settleReject(
      new Error(`OBS 进程 spawn 失败(不是连不上,是根本没起来):${String(err)}`),
    );
    // Review fix (task-3, Important): Node does NOT emit "exit" when spawn
    // itself fails (obs64.exe missing after SKIP-list pruning, Defender
    // quarantine, etc.) -- only "error", and "close" is not guaranteed on
    // every platform/Node version either. Without this, exited() stayed
    // null forever after a spawn failure (the gate script then prints "OBS
    // 进程仍在跑" for a process that never existed) and stop()'s trailing
    // await hung indefinitely waiting for an "exit" that never comes.
    // child.pid is the reliable signal: undefined means spawn genuinely
    // never produced a process, so mark it terminal immediately rather than
    // waiting on any further event. (A LATER "error", e.g. a failed IPC
    // send to an already-running child with a real pid, must NOT hit this
    // branch -- that process is still alive and its real "exit"/"close"
    // remains authoritative.)
    if (child.pid === undefined) {
      markExited(null, null);
    }
  });
  child.on("exit", (code, signal) => markExited(code, signal ?? null));
  // Defensive belt-and-braces alongside the pid-undefined branch above:
  // "close" fires for both a normal exit (after "exit", a no-op here since
  // markExited only acts on the first call) and, on platforms/Node versions
  // where it applies, a failed spawn -- covering the case even without the
  // pid check.
  child.on("close", (code, signal) => markExited(code, signal ?? null));

  async function stop(): Promise<void> {
    if (exitInfo !== null) return;
    const pid = child.pid;
    try {
      child.kill();
    } catch {
      // Best effort: process may already be dead.
    }
    let timedOut = false;
    await Promise.race([
      exitedOnce,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, GRACE_STOP_MS);
      }),
    ]);
    if (timedOut && exitInfo === null && pid != null) {
      killTreeImpl(pid);
    }
    // Belt-and-braces bound (review fix): exitedOnce SHOULD already be
    // resolved by markExited via exit/close/the pid-undefined error branch
    // above, but guard against an unforeseen Node/platform edge case with a
    // short timeout so stop() can never hang indefinitely.
    await Promise.race([
      exitedOnce,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    cleanupTimers();
  }

  function killSync(): void {
    cleanupTimers();
    if (exitInfo !== null) return;
    const pid = child.pid;
    try {
      child.kill();
    } catch {
      // Best effort.
    }
    if (pid != null) killTreeImpl(pid);
  }

  return {
    ready,
    onLogLine(cb) {
      lineListeners.add(cb);
      return () => lineListeners.delete(cb);
    },
    stop,
    killSync,
    exited: () => exitInfo,
    pid: () => child.pid ?? null,
  };
}
