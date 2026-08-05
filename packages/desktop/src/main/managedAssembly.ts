import { MANAGED_WS_PORT } from "../shared/obsAsset";
import type { ObsAssets } from "./obsAssets";
import type { ObsConfigSpec } from "./obsConfigWriter";
import type {
  ManagedObsHandle,
  SpawnManagedObsSpec,
} from "./managedObsProcess";
import type {
  ManagedObsBackend,
  ManagedObsBackendDeps,
} from "./managedObsBackend";
import type { CaptureBackend } from "./captureBackend";
import { isManagedActive, type RecorderStatus } from "./recorder";

/**
 * Task-5b 装配层(main/index.ts 启动/退出序列的可测核心)。The brief's 7-step
 * startup sequence lives in `assembleManagedRecording` below; this module is
 * pure Node (no `electron` import) so it can be unit tested with fakes for
 * every dependency, exactly like recorder.ts/managedObsBackend.ts before it.
 *
 * `ManagedAssemblyState` is the one piece of mutable, cross-call memory this
 * module needs: index.ts owns a single instance for the app's lifetime, so
 * repeated calls (runtime settings toggle, install-then-retry) can be
 * idempotent/re-entry-safe (复核 NEW-3 — "装了就自动录" must not need an app
 * restart) without resorting to module-scope globals inside this file.
 */
export interface ManagedAssemblyState {
  running: boolean;
  handle: ManagedObsHandle | null;
  backend: ManagedObsBackend | null;
  watch: { start(): void; stop(): void } | null;
}

export function createManagedAssemblyState(): ManagedAssemblyState {
  return { running: false, handle: null, backend: null, watch: null };
}

export interface AssembleManagedRecordingDeps {
  state: ManagedAssemblyState;
  /** Same settings shape isManagedActive() itself takes — the mode gate
   * (brief step 1) is done INSIDE this function via that shared predicate,
   * never hand-copied (CLAUDE.md shared-predicate rule). */
  getSettings: () => Parameters<typeof isManagedActive>[0];
  /** Brief step 2 (password provisioning: `settings.managedWsPassword ??
   * generate 32 hex random → save`) is deliberately NOT done in here — it
   * needs `settings.save` (a persistence side effect this module has no
   * business owning) and Task 6 hasn't landed the field yet. index.ts
   * resolves-or-generates-and-persists and hands the result through this
   * getter, called at the correct point in the sequence (after the
   * installed-check, before writeObsConfig) but not before the mode gate —
   * see the `④ managedActive=false → 全程零调用` test. */
  getWsPassword: () => string;
  recDir: string;
  assets: Pick<ObsAssets, "root" | "installed">;
  writeObsConfig: (spec: ObsConfigSpec) => void;
  clearSentinels: (obsRoot: string) => void;
  spawnManagedObs: (spec: SpawnManagedObsSpec) => ManagedObsHandle;
  createManagedObsBackend: (deps: ManagedObsBackendDeps) => ManagedObsBackend;
  createWowProcessWatch: (deps: { onUp: () => void; onDown: () => void }) => {
    start(): void;
    stop(): void;
  };
  /** Wires the freshly-built backend into the recorder. recorder.ts reads
   * `deps.managedBackend` fresh on every access (never caches it in a local
   * variable), so mutating the SAME deps object createRecorderService closed
   * over is visible immediately — index.ts implements this by holding a
   * named reference to that object and assigning `.managedBackend` on it. */
  setRecorderManagedBackend: (b: CaptureBackend | null) => void;
  /** Same mutation trick, for recorder.stop()'s managed exit sequence (task-
   * 5b point 1: backend.shutdown() → handle.stop()). */
  setRecorderManagedProcessStop: (fn: (() => Promise<void>) | null) => void;
  onWowUp: () => void;
  onWowDown: () => void;
  /** Pushes a RecorderStatus-shaped snapshot on the SAME channel
   * recorder.ts's own pushStatus uses (gladlog:recorder:status) — no new IPC
   * surface needed for the settings-page status row to see "待安装" / an
   * assembly-time error. Bypasses recorder.getStatus() on purpose: "not
   * installed" is state this module owns, not recorder.ts's. */
  emitStatus: (status: RecorderStatus) => void;
}

function errStatus(enabled: boolean, e: unknown): RecorderStatus {
  return {
    enabled,
    connected: false,
    recording: false,
    lastError: String(e),
    sourceActive: null,
  };
}

/**
 * Task-5b brief's 7-step startup sequence (steps 1/3-7; step 2 is delegated,
 * see `getWsPassword`'s doc comment). Idempotent/re-entry-safe: the
 * `state.running` guard is set synchronously, before the first `await`, so
 * two back-to-back calls (e.g. a rapid settings:save while the first
 * assembly is still mid-flight) can never spawn a second OBS process or
 * start a second watch.
 *
 * Assembly-order invariant (task-5's note to 5b, recorder.ts's own comment
 * ~line 499): `backend.configureSession()` MUST complete — success OR
 * failure — before the watch starts. `probe().ready` is `connected &&
 * sessionConfigured`, and `startContinuous()` never calls configureSession
 * itself; if the watch fired `onWowUp` first, `health.ready` would stay
 * false forever and the bounded retry loop would spin with no way to tell
 * "assembly forgot a step" apart from "OBS genuinely isn't ready yet".
 */
export async function assembleManagedRecording(
  deps: AssembleManagedRecordingDeps,
): Promise<void> {
  const s = deps.getSettings();
  // Step 1 + the `④ managedActive=false → 全程零调用` test: this must be the
  // very first thing checked, before even `assets.installed()`, so a
  // non-managed call touches zero dependencies.
  if (!isManagedActive(s)) return;
  if (deps.state.running) return; // idempotent re-entry guard (复核 NEW-3)

  // Step 3: download is NOT automatic (user-approved deviation from the
  // design doc's "首次运行下载" — 179MB must be a visible user action, not a
  // silent background one). Report 待安装 and stop; only the renderer's
  // "下载并启用" action (recorder:installObs IPC → assets.ensureInstalled)
  // ever downloads, and it re-runs this same function on success.
  if (!deps.assets.installed()) {
    deps.emitStatus({
      enabled: s.recordingEnabled,
      connected: false,
      recording: false,
      lastError: "OBS 未安装 —— 请在设置页点击「下载并启用」",
      sourceActive: null,
    });
    return;
  }

  deps.state.running = true; // before ANY await — see the re-entry-safety doc comment above

  let handle: ManagedObsHandle;
  try {
    const wsPassword = deps.getWsPassword();
    // Step 4
    deps.writeObsConfig({
      obsRoot: deps.assets.root,
      recDir: deps.recDir,
      wsPort: MANAGED_WS_PORT,
      wsPassword,
      bitrateKbps: 8000,
    });
    deps.clearSentinels(deps.assets.root);
    handle = deps.spawnManagedObs({
      obsRoot: deps.assets.root,
      wsPort: MANAGED_WS_PORT,
    });
    deps.state.handle = handle;
    deps.setRecorderManagedProcessStop(() => handle.stop());

    // Step 5
    const backend = deps.createManagedObsBackend({
      ensureProcess: async () => {
        const ready = await handle.ready;
        return { wsUrl: ready.wsUrl, wsPassword };
      },
      recDir: deps.recDir,
    });
    deps.state.backend = backend;
    deps.setRecorderManagedBackend(backend);

    // Step 6 — failures degrade to lastError only; the app must stay alive
    // and the sequence must still proceed to step 7 (see the assembly-order
    // doc comment above the function).
    try {
      await backend.configureSession();
    } catch (e) {
      deps.emitStatus(errStatus(s.recordingEnabled, e));
    }
  } catch (e) {
    // writeObsConfig/clearSentinels are synchronous fs calls that CAN throw
    // (permission errors, disk full) before anything durable (a spawned
    // process) exists yet — safe to reset `running` so a later call (next
    // toggle, next app start) retries from scratch instead of being
    // permanently no-op'd by the re-entry guard above.
    deps.state.running = false;
    deps.emitStatus(errStatus(s.recordingEnabled, e));
    return;
  }

  // Step 7
  const watch = deps.createWowProcessWatch({
    onUp: deps.onWowUp,
    onDown: deps.onWowDown,
  });
  deps.state.watch = watch;
  watch.start();
}

export interface TeardownManagedRecordingDeps {
  state: ManagedAssemblyState;
  /** Usually `() => recorder?.stop() ?? Promise.resolve()`. recorder.stop()
   * itself (task-5b exit sequence) already runs the managed
   * backend.stopContinuous() → backend.shutdown() → handle.stop() sequence
   * internally whenever a managedBackend is present — this wrapper's only
   * remaining job is to also stop the watch and reset assembly state so a
   * later re-toggle back to "managed" can call assembleManagedRecording
   * again cleanly. Used for the RUNTIME toggle-off path only; app quit goes
   * through recorder.stop() directly via quitLifecycle (brief: "现有
   * before-quit 链的 stopRecorder 闭包... 自动覆盖托管"). */
  stopRecorder: () => Promise<void>;
  setRecorderManagedBackend: (b: CaptureBackend | null) => void;
  setRecorderManagedProcessStop: (fn: (() => Promise<void>) | null) => void;
}

export async function teardownManagedRecording(
  deps: TeardownManagedRecordingDeps,
): Promise<void> {
  if (!deps.state.running) return; // idempotent
  deps.state.watch?.stop();
  deps.state.watch = null;
  await deps.stopRecorder();
  deps.setRecorderManagedBackend(null);
  deps.setRecorderManagedProcessStop(null);
  deps.state.handle = null;
  deps.state.backend = null;
  deps.state.running = false;
}
