import { DEFAULT_OBS_WS_URL, OBS_PASSWORD_REDACTED } from "../shared/protocol";
import type { CaptureBackend, CaptureChunk } from "./captureBackend";
import type { ObsClientLike } from "./obsClient";
import type { RecordingEntry, RecordingsStore } from "./recordingsStore";
import { RECORDING_SCHEMA } from "./recordingsStore";

export { DEFAULT_OBS_WS_URL };

/** Safety valve for a segment that stays open and never sees close (worker died / log stream stalled). */
const SAFETY_STOP_MS = 40 * 60_000;
const META_BUFFER_CAP = 20;
/** Managed-mode idle-split cadence (design doc §5.5): while continuously
 * recording outside a match window, cut a fresh chunk every 10 minutes so a
 * long play session doesn't accumulate into one unbounded file. Paused the
 * moment a match opens and restarted only after the post-close split -- the
 * hard invariant is "never split during a match" (task-5 brief). */
const IDLE_SPLIT_MS = 10 * 60_000;
/** Managed-mode per-chunk ceiling (design doc §5.5, 复核 I4 -- this is
 * SAFETY_STOP_MS's managed-mode reincarnation, but kept as its own constant:
 * SAFETY_STOP_MS stops the bypass recording outright on timeout, whereas this
 * one just forces a split and keeps recording continuously). Armed the moment
 * a chunk opens; cleared/rearmed on every subsequent chunk open (idle split,
 * match-boundary split, or this timer itself firing). */
const MAX_CHUNK_MS = 40 * 60_000;
/** Timeout for a single OBS request. All start/stop calls share one serialized
 * promise chain, so any bare await that hangs (OBS stop stuck on encoder/disk)
 * would queue the chain — including the 40-minute safety valve — to death and
 * let the recording run forever (2026-08-02 forensics: the only path that
 * explains "still recording past 40 minutes"). */
const OBS_CALL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(`${what} timed out after ${OBS_CALL_TIMEOUT_MS}ms`)),
      OBS_CALL_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface RecorderStatus {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
}

export interface RecorderService {
  onSegmentOpen(info: { startTime: number; bracket: string }): void;
  onSegmentClose(info: { endTime: number | null; aborted: boolean }): void;
  associate(meta: { id: string; startTime: number; endTime: number }): void;
  getForMatch(matchId: string): RecordingEntry | null;
  getStatus(): RecorderStatus;
  /** overrides = the current (possibly unsaved) inputs on the settings page:
   * url of null means use the default address; empty/absent/sentinel password
   * falls back to the saved real value. Real-machine gotcha: typing the
   * password and clicking Test without saving would test with an empty
   * password and report "missing authentication string". */
  testConnection(overrides?: {
    url?: string | null;
    password?: string | null;
  }): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  /** Run retention immediately (double-gate prune: count + bytes). Never
   * throws -- retention must never break the caller (startup wiring,
   * failure-path recovery). */
  pruneNow(): void;
  /** Managed mode only (task-5 brief 5c); the future watcher (Task 5b) calls
   * this on a WoW-process up-transition. A no-op whenever isManagedActive()
   * is false or no managedBackend was injected -- belt-and-suspenders, since
   * the watcher itself is only ever started under the same gate. */
  onWowUp(): void;
  /** Managed mode only; mirrors onWowUp for the down-transition -- stops
   * continuous recording and closes the tail chunk. Same defensive gate. */
  onWowDown(): void;
  /** Proactively connect once at app startup when recording is enabled
   * (review Important #2, 2026-08-03): `connected` used to start false and
   * only flip true inside ensureConnected(), which was only ever reached from
   * onSegmentOpen / doClose's orphan branch -- so a user with recording
   * enabled and OBS already running healthily saw the "未连接" banner from
   * launch until their first match, even though nothing was actually wrong.
   * Serialized on the same chain as start/stop so it cannot race a match
   * opening concurrently. Never throws -- like pruneNow, a failed startup
   * connect must degrade to lastError + status only, never take down the
   * caller (app.whenReady's init sequence). */
  connectAtStartup(): Promise<void>;
}

interface RecorderSettings {
  recordingEnabled: boolean;
  obsWebsocketUrl: string | null;
  obsWebsocketPassword: string | null;
  recordingKeepCount: number;
  recordingMaxBytes: number;
  /** Handoff note (task-5 brief, 复核 NEW-2): `GladlogSettings` does not yet
   * carry this field -- persisting it is Task 6's job. It lives here,
   * OPTIONAL, as a temporary structural type: `SettingsStore.get()` (typed as
   * `GladlogSettings`) has no such property today, and TS happily allows that
   * against an optional target field, so `index.ts`'s existing
   * `getSettings: () => settings.get()` keeps typechecking unmodified.
   * Missing/undefined reads as "external" (today's only reality). The moment
   * Task 6 adds `recordingMode` to `GladlogSettings`, this field should become
   * non-optional and this comment can go. */
  recordingMode?: "managed" | "external";
}

/** Single-source managed-mode gate (task-5 brief 复核 B2/NEW-2): every entry
 * point that might touch the managed CaptureBackend -- onWowUp/onWowDown,
 * onSegmentOpen/onSegmentClose's managed branch, the idle/max-chunk timers,
 * and the future Task 5b assembly layer's decision whether to even create a
 * watcher/backend at all -- imports and calls THIS, never hand-copies the
 * three-term conjunction (CLAUDE.md's shared-predicate rule: that class of
 * duplication is the #1 recurring bug source in this repo). */
export function isManagedActive(
  s: Pick<RecorderSettings, "recordingEnabled" | "recordingMode">,
): boolean {
  return (
    s.recordingEnabled &&
    s.recordingMode === "managed" &&
    process.platform === "win32"
  );
}

/** Externally drives OBS record start/stop (route C, phase 1). Iron rule: any
 * OBS failure only degrades into lastError, never throws upward — parsing,
 * ingestion, and the analysis main path must be unaffected by recording.
 * Start/stop are serialized on a single promise chain to prevent interleaving
 * of back-to-back matches. */
export function createRecorderService(deps: {
  getSettings: () => RecorderSettings;
  recordings: RecordingsStore;
  clientFactory: () => ObsClientLike;
  emit: (channel: string, payload: unknown) => void;
  now?: () => number;
  /** Managed mode only; injected by Task 5b's assembly layer once
   * isManagedActive() was true at startup. undefined = bypass-only (mac/CI/
   * external mode) -- every managed entry point defensively re-checks
   * isManagedActive() anyway (belt-and-suspenders), so a stale/mismatched
   * backend reference can never fire managed side effects on its own. */
  managedBackend?: CaptureBackend;
}): RecorderService {
  let client: ObsClientLike | null = null;
  let connected = false;
  let recording = false;
  /** Gotcha caught in review round: reconcileWithReality() cannot rely on
   * GetRecordStatus's outputActive alone — that only proves "OBS is
   * recording", not "gladlog told it to record". When the user has OBS open
   * and is recording manually (e.g. their own stream backup), gladlog
   * connects, sees outputActive=true with local recording=false, and blindly
   * wrapping it up as an orphan would stop the user's own recording — a
   * destructive operation; the original behavior of "leave it alone, just set
   * lastError" is actually safer.
   *
   * Hence this "positive evidence" bit: only when gladlog itself successfully
   * called startRecord and has not yet confirmed a successful stopRecord may
   * closeOrphanRecording() act. Semantically it records ownership of the
   * current round, not ownership of "this video".
   *
   * Deliberately kept in memory only, never persisted: onClosed (websocket
   * disconnect) does not clear it — that is exactly the scenario C1 fixes
   * (OBS keeps recording independently during the disconnect; after
   * reconnecting we must still recognize it as ours). But an app crash or
   * restart wipes memory, at which point even a genuine gladlog orphan
   * recording degrades to the old behavior (startRecord reports already
   * active → lastError, OBS is left untouched). This is a deliberate
   * trade-off: better that the rare "true orphan after app restart" needs a
   * one-time manual cleanup in OBS than that the common "user running their
   * own OBS recording" gets stopped by mistake — asymmetric risk; the
   * destructiveness of the latter far outweighs the inconvenience of the
   * former. */
  let weStartedRecording = false;
  let startedAt = 0;
  let lastError: string | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  const metaBuffer: Array<{ id: string; startTime: number; endTime: number }> =
    [];
  let chain: Promise<void> = Promise.resolve();
  const now = deps.now ?? Date.now;

  // -- Managed mode (task-5 brief 5c) -- entirely separate state machine from
  // the bypass one above; mode-branching, not unification (复核 I2). Runs on
  // its own serialized chain so a hung managed backend call can never wedge
  // the bypass chain or vice versa (they are mutually exclusive in practice --
  // isManagedActive() gates which one ever runs -- but keeping them on
  // separate chains means that stays true even if that invariant is ever
  // violated).
  let managedRunning = false; // WoW up ⇒ continuous recording should be active
  let managedInMatch = false; // segmentOpen..segmentClose window: idle timer pauses here
  let managedIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let managedMaxChunkTimer: ReturnType<typeof setTimeout> | null = null;
  let chunkOpenedUnsub: (() => void) | null = null;
  let managedChain: Promise<void> = Promise.resolve();
  const runManaged = (fn: () => Promise<void>) => {
    managedChain = managedChain.then(fn).catch(() => {});
  };

  const status = (): RecorderStatus => ({
    enabled: deps.getSettings().recordingEnabled,
    connected,
    recording,
    lastError,
  });
  const pushStatus = () => deps.emit("gladlog:recorder:status", status());
  const run = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(() => {});
  };

  /** Double-gate retention (design doc 4.2). Called from every path that ends
   * a segment -- success AND failure -- plus once at startup (main/index.ts),
   * so a run of stopRecord failures still reclaims disk instead of retention
   * living only on the success path (the bug this task fixes). Never throws:
   * retention must never break the main recording pipeline. */
  function pruneNow(): void {
    try {
      const s = deps.getSettings();
      deps.recordings.prune({
        keepCount: s.recordingKeepCount,
        maxBytes: s.recordingMaxBytes,
      });
    } catch {
      /* retention must never break the main pipeline */
    }
  }

  function isAlreadyActiveError(e: unknown): boolean {
    return /already active/i.test(String(e));
  }

  // -- Managed-mode helpers --

  function clearManagedIdleTimer(): void {
    if (managedIdleTimer) {
      clearTimeout(managedIdleTimer);
      managedIdleTimer = null;
    }
  }
  function armManagedIdleTimer(): void {
    clearManagedIdleTimer();
    managedIdleTimer = setTimeout(() => {
      runManaged(() => managedSplit("idle"));
    }, IDLE_SPLIT_MS);
  }
  function clearManagedMaxChunkTimer(): void {
    if (managedMaxChunkTimer) {
      clearTimeout(managedMaxChunkTimer);
      managedMaxChunkTimer = null;
    }
  }
  function armManagedMaxChunkTimer(): void {
    clearManagedMaxChunkTimer();
    managedMaxChunkTimer = setTimeout(() => {
      runManaged(() => managedSplit("max-chunk"));
    }, MAX_CHUNK_MS);
  }

  /** Wires the backend's persistent chunk-open listener exactly once (M9:
   * obs-websocket-js has no `off`, so this is deliberately never
   * unsubscribed for the life of the recorder -- it must keep tracking every
   * chunk across repeated WoW up/down cycles). Deferred to first use (inside
   * onWowUp's managedActive-gated branch) rather than at construction time,
   * so a recorder built with a managedBackend but never actually eligible to
   * run managed (isManagedActive()===false throughout) makes truly ZERO
   * backend calls -- not even a subscribe. */
  function ensureChunkOpenedSubscription(): void {
    if (chunkOpenedUnsub || !deps.managedBackend) return;
    chunkOpenedUnsub = deps.managedBackend.onChunkOpened((c: CaptureChunk) => {
      deps.recordings.openChunk(c.videoPath, c.startedAt);
      armManagedMaxChunkTimer();
      // A fresh chunk just opened; the idle-split clock only runs outside a
      // match window (the hard invariant: never split mid-match), so only
      // (re)arm it here when we are not currently between segmentOpen and
      // segmentClose.
      if (!managedInMatch) armManagedIdleTimer();
    });
  }

  /** Shared by the idle timer, the max-chunk timer, and the post-match-close
   * split -- all three are "cut the current chunk now" with the same
   * closeChunk + pruneNow + idle-timer-restart tail. Never throws: backend
   * failures degrade to lastError only (iron rule, same as the bypass path).
   * Tolerates splitChunk() resolving null (Task 4's note: a split can cleanly
   * time out under rapid retries) by logging and re-arming both timers for
   * another attempt later, rather than retrying in a tight loop. */
  async function managedSplit(
    reason: "idle" | "max-chunk" | "match-end",
  ): Promise<void> {
    // Deliberately gated on backend presence alone, not isManagedActive(): by
    // the time this runs, a managed session is already under way (its timers
    // only ever get armed from inside an isManagedActive()-gated entry point
    // in the first place -- see onWowUp/ensureChunkOpenedSubscription), and a
    // settings flicker mid-session must not leave an already-open chunk
    // stranded forever. onWowDown remains the authoritative "actually stop"
    // signal.
    if (!deps.managedBackend) return;
    let closed: CaptureChunk | null = null;
    try {
      closed = await deps.managedBackend.splitChunk();
      lastError = null;
    } catch (e) {
      lastError = String(e);
      closed = null; // an exception and a clean null both mean "no new chunk
      // opened" -- both must fall into the same no-retry-storm handling below.
    }
    if (closed) {
      deps.recordings.closeChunk(closed.videoPath, closed.stoppedAt ?? now());
      pruneNow();
    } else {
      console.warn(`[recorder] splitChunk 未产出新分片,跳过(reason=${reason})`);
      // onChunkOpened will not fire for a failed split (no new chunk was
      // actually opened by the backend) -- without this, a failed split would
      // silently disable every future idle/max-chunk split for the rest of
      // the session. Re-arming here is "try again next window", not a tight
      // retry.
      if (!managedInMatch) armManagedIdleTimer();
      armManagedMaxChunkTimer();
    }
    if (reason === "max-chunk") {
      console.warn("[recorder] 单分片超 40 分钟,已强制分片");
    }
    pushStatus();
  }

  /** C1 state-mismatch cleanup: OBS is still recording while we locally think
   * we are not (typical trigger: OBS kept recording independently during a
   * websocket disconnect). The chosen semantics are "stop this orphan
   * recording and try to index it" rather than "adopt it as the new segment" —
   * adoption would pollute the new match's time window with the old recording,
   * and associate()'s overlap matching would get harder to align. We use the
   * startedAt we still remember (not cleared before the disconnect) as the
   * orphan's start; if even startedAt is missing (should be unreachable,
   * defensive fallback) we degrade to the current time rather than crash on
   * indexing. A stopRecord failure itself (e.g. OBS was manually stopped
   * between GetRecordStatus and StopRecord) is also swallowed so recovery does
   * not fail as a whole — the next startRecord's already-active fallback will
   * take another shot.
   *
   * Only invoked when weStartedRecording is true (see call-site comments and
   * the notes at the variable declaration); the extra guard here is purely
   * defensive (belt-and-suspenders), so a future change that forgets the
   * call-site check cannot mistakenly stop a recording gladlog did not
   * start. */
  async function closeOrphanRecording(): Promise<void> {
    if (!client || !weStartedRecording) return;
    try {
      const { outputPath } = await withTimeout(
        client.stopRecord(),
        "StopRecord",
      );
      const entry: RecordingEntry = {
        schema: RECORDING_SCHEMA,
        videoPath: outputPath,
        startedAt: startedAt || now(),
        stoppedAt: now(),
        matchIds: [],
      };
      deps.recordings.add(entry);
      for (const m of metaBuffer) deps.recordings.associate(m);
    } catch {
      /* best effort: see comment above */
    } finally {
      recording = false;
      // At this point we have connected to OBS and confirmed/attempted in
      // person (not guessing during a disconnect), so regardless of whether
      // stopRecord succeeded, this round's ownership is settled — keeping it
      // true carries no extra information; its only effect would be raising
      // the odds of a future misjudgment.
      weStartedRecording = false;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      // Failure path too (see comment above): a stopRecord failure here must
      // not mean retention silently skips this round.
      pruneNow();
    }
  }

  /** Reconcile once after every (re)connect: query OBS's real recording state
   * and compare with the local in-memory bit. Only done right after
   * connecting — once connected is true, later ensureConnected calls
   * short-circuit and do not reconcile again (no need; no new source of state
   * mismatch). */
  async function reconcileWithReality(): Promise<void> {
    if (!client) return;
    let obsRecording: boolean;
    try {
      obsRecording = (
        await withTimeout(client.getRecordStatus(), "GetRecordStatus")
      ).outputActive;
    } catch {
      return; // can't query — keep current state; startRecord's already-active fallback covers it
    }
    if (obsRecording && !recording) {
      if (weStartedRecording) {
        await closeOrphanRecording();
      }
      // else: OBS is recording, we are not, and there is no positive evidence
      // that gladlog started it — most likely the user started recording
      // manually (or it is a stale orphan from before a gladlog crash/restart;
      // weStartedRecording is not persisted, so it cannot be recovered). Never
      // touch it: let the upcoming startRecord() fail with "already active"
      // the old way and go through lastError — the only choice that cannot
      // damage the user's data (gotcha caught in review round; details at the
      // weStartedRecording declaration).
    } else if (!obsRecording && recording) {
      // Reverse mismatch: OBS already stopped (manual stop / crash-restart);
      // stop believing locally that we are recording.
      // I3 known gap (honestly labeled, not handled): this branch corresponds
      // to "the OBS process itself crashed and restarted" — not the websocket
      // disconnect case where OBS keeps recording (that one is covered by
      // closeOrphanRecording indexing via stopRecord()'s outputPath). When the
      // OBS process crashes, the half-written video file really exists, but
      // GetRecordStatus only returns outputActive with no file path — there is
      // no way to recover and index it here. Orphans that truly have no index
      // row at all can only be surfaced by RecordingsStore.prune()'s
      // unindexed-file visibility log (I3) for manual cleanup; no
      // auto-indexing or auto-deleting.
      recording = false;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    }
  }

  async function ensureConnected(): Promise<void> {
    if (connected && client) return;
    const s = deps.getSettings();
    client = deps.clientFactory();
    client.onClosed(() => {
      connected = false;
      // recording is still cleared to false — this is the signal "we no
      // longer trust ourselves to be managing this recording", not an
      // assertion "OBS actually stopped" (after a disconnect OBS is most
      // likely still recording on its own). Clearing it is necessary:
      // onSegmentOpen dedupes back-to-back DOUBLE_START via
      // `if (recording) return`; without clearing, the next match's open
      // would be blocked by that dedupe and not even attempt to reconnect.
      // The real OBS state is asked by reconcileWithReality() after
      // reconnecting; if it turns out "still recording", it is wrapped up as
      // an orphan (see closeOrphanRecording).
      recording = false;
      // Deliberately does NOT null `client` here (considered during the
      // testConnection re-review fix above). It would be a no-op for control
      // flow: every read of `client` is gated behind either `connected`
      // (already false the moment this fires, so ensureConnected()'s
      // short-circuit `if (connected && client) return;` already falls
      // through regardless of whether `client` itself is null or dead) or a
      // call site that runs ensureConnected() first and so gets a freshly
      // reassigned `client` before touching it (closeOrphanRecording via
      // doClose / reconcileWithReality). The one place a stale-but-non-null
      // `client` combined with connected=true actually broke the invariant
      // was testConnection flipping connected back to true independently --
      // fixed at that call site instead of here.
      pushStatus();
    });
    await withTimeout(
      client.connect(
        s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL,
        s.obsWebsocketPassword ?? undefined,
      ),
      "connect",
    );
    connected = true;
    await reconcileWithReality();
  }

  async function doClose(): Promise<void> {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (!recording) {
      // A disconnect cleared recording (needed by onClosed's dedupe) / a past
      // stopRecord failed — but weStartedRecording still remembers this debt
      // is ours. When play ends with no next match, this is the only chance
      // to stop recording: reconnect and collect the orphan. Previously this
      // returned immediately, so "last match disconnects → OBS never stops",
      // and the 40-minute safety valve and the quit path were disabled by the
      // same gate (main root cause of the 2026-08-02 real-machine "recording
      // never ends after playing").
      if (!weStartedRecording) return;
      await ensureConnected(); // reconcile on reconnect has likely collected it already
      await closeOrphanRecording(); // idempotent: no-op if collected; direct stop when never disconnected
      return;
    }
    if (!client) return;
    // Leave the "recording" state first: if stopRecord throws (OBS stopped
    // manually on its side, etc.), recording must not stay stuck at true, or
    // every later match would refuse to record (agy flash review #3).
    recording = false;
    try {
      const { outputPath } = await withTimeout(
        client.stopRecord(),
        "StopRecord",
      );
      // Clear weStartedRecording only after stopRecord is confirmed
      // successful — a mid-way failure (usually firing at an already-dead
      // client during a disconnect; see the onClosed comment in
      // ensureConnected) keeps it true, so the next reconcileWithReality()
      // still recognizes this as gladlog's own debt instead of misjudging a
      // true orphan as "not started by us" because we cleared too early.
      weStartedRecording = false;
      const entry: RecordingEntry = {
        schema: RECORDING_SCHEMA,
        videoPath: outputPath,
        startedAt,
        stoppedAt: now(),
        matchIds: [],
      };
      deps.recordings.add(entry);
      // One of the two-way fallbacks: the match message arrived before
      // segmentClose, so its meta is already in the buffer
      for (const m of metaBuffer) deps.recordings.associate(m);
      pruneNow();
    } catch (e) {
      // stopRecord (or something after it) failed: this segment couldn't be
      // indexed, but retention must not silently skip this round either -- a
      // run of failures used to mean disk was never reclaimed at all (the bug
      // this task fixes). Rethrow so callers still set lastError exactly as
      // before.
      pruneNow();
      throw e;
    }
  }

  return {
    onSegmentOpen(info) {
      const s = deps.getSettings();
      if (!s.recordingEnabled) return;
      if (isManagedActive(s) && deps.managedBackend) {
        // Hard invariant (task-5 brief): NEVER split during a match. Pausing
        // the idle timer here, synchronously, is deliberate -- it must not
        // wait for the managed chain to drain, or an idle timeout already
        // queued just ahead of this segmentOpen could still fire and split
        // mid-match.
        managedInMatch = true;
        clearManagedIdleTimer();
        runManaged(async () => {
          try {
            // U3: hybrid_mp4 chapter marker -- pure enhancement, failure is
            // silent by CaptureBackend's own contract and must never touch
            // lastError or block the match from being tracked.
            await deps.managedBackend!.markChapter(`match ${info.bracket}`);
          } catch {
            /* markChapter is enhancement-only; silent per interface contract */
          }
        });
        return;
      }
      run(async () => {
        if (recording) return; // back-to-back / DOUBLE_START: same recording keeps covering
        try {
          await ensureConnected();
          try {
            await withTimeout(client!.startRecord(), "StartRecord");
          } catch (e) {
            // Second line of defense: reconcileWithReality() is a snapshot at
            // connect time; there is still a tiny TOCTOU window between
            // GetRecordStatus and this startRecord (e.g. OBS just restarted
            // and state has not synced). On "already active", wrap up the
            // orphan and retry once instead of failing this match outright
            // and leaving lastError stuck until the next one (the core
            // consequence C1 addresses: retries failing forever) — but again
            // only act when weStartedRecording is true; otherwise it may be a
            // user-initiated recording, so let the error go to lastError as
            // before (caught in review round; same rationale as
            // reconcileWithReality).
            if (!isAlreadyActiveError(e) || !weStartedRecording) throw e;
            await closeOrphanRecording();
            await withTimeout(client!.startRecord(), "StartRecord");
          }
          startedAt = now();
          recording = true;
          weStartedRecording = true;
          lastError = null;
          safetyTimer = setTimeout(
            () =>
              run(async () => {
                try {
                  await doClose();
                } catch (e) {
                  lastError = String(e);
                } finally {
                  pushStatus();
                }
              }),
            SAFETY_STOP_MS,
          );
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
    onSegmentClose() {
      // Managed branch is keyed on managedInMatch (not isManagedActive()) --
      // if we entered this match via the managed markChapter path, the close
      // must mirror it regardless of any settings flicker in between; falling
      // through to the bypass branch here would silently strand the open
      // chunk (see managedSplit's comment on the same tradeoff).
      if (managedInMatch && deps.managedBackend) {
        managedInMatch = false;
        runManaged(async () => {
          try {
            await deps.managedBackend!.markChapter("match end");
          } catch {
            /* enhancement-only; silent per interface contract */
          }
          await managedSplit("match-end");
        });
        return;
      }
      // Not gated on recordingEnabled: turning the setting off mid-match must
      // still be able to stop the recording (doClose is a no-op when not
      // recording anyway; agy flash review #4).
      run(async () => {
        try {
          await doClose();
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
    associate(meta) {
      metaBuffer.push(meta);
      if (metaBuffer.length > META_BUFFER_CAP) metaBuffer.shift();
      try {
        const hit = deps.recordings.associate(meta);
        // 设计 §5.5「如实记录不许静默」(复核 I16): negative headroom -- the
        // match is reported as starting before the chunk that ended up
        // carrying it. TOLERANCE_MS's overlap window can legitimately absorb
        // this (log lag, or back-to-back matches whose gap is smaller than
        // that margin), so it must not fail ingestion; but silently accepting
        // it would hide a real timing anomaly if one is happening. Applies to
        // both modes -- this is a property of the association result, not of
        // how the chunk was produced.
        if (hit && meta.startTime < hit.startedAt) {
          console.warn(
            `[recorder] associate: meta.startTime(${meta.startTime}) < chunk.startedAt(${hit.startedAt}) -- 负 headroom`,
          );
        }
      } catch {
        /* a corrupted index must not affect ingestion */
      }
    },
    getForMatch: (id) => deps.recordings.getForMatch(id),
    getStatus: status,
    async testConnection(overrides) {
      try {
        const c = deps.clientFactory();
        const s = deps.getSettings();
        const url =
          overrides && "url" in overrides
            ? (overrides.url ?? DEFAULT_OBS_WS_URL)
            : (s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL);
        const typed = overrides?.password;
        const password =
          typed && typed !== OBS_PASSWORD_REDACTED
            ? typed
            : (s.obsWebsocketPassword ?? undefined);
        await c.connect(url, password);
        await c.disconnect();
        // Review Important #2: a successful test must be reflected in the
        // status the banner/settings row read, not just returned to the
        // caller -- otherwise "测试连接" can succeed while the row still says
        // 未连接 until the next match opens. This uses a throwaway client (not
        // the persistent `client`/`connected` pair ensureConnected manages),
        // so only flip `connected` on SUCCESS: a failed test with edited-but-
        // unsaved overrides must not stomp on a real, currently-connected
        // persistent session by reporting it disconnected.
        //
        // Re-review fix (2026-08-03): setting `connected = true` here broke
        // the invariant ensureConnected() relies on -- connected===true ⇒ the
        // persistent `client` is live. Reachable sequence: OBS restarts →
        // the persistent client's onClosed fires, sets connected=false but
        // leaves `client` pointed at the now-dead object (nothing nulls it
        // there) → user clicks 测试连接 (or 自动配置, which also routes
        // through here) → this throwaway probe succeeds → connected=true
        // again, with a dead persistent client. ensureConnected()'s
        // short-circuit `if (connected && client) return;` would then never
        // reconnect for the rest of the session. Drop the stale persistent
        // reference so the next ensureConnected() call is forced through the
        // real reconnect path.
        //
        // Guarded on "were we already connected" (read BEFORE this
        // assignment), not unconditional: if we were already connected,
        // `client` is presumably live and may be mid-recording -- doClose()
        // needs that exact reference to call stopRecord() on, and nulling it
        // out from under an active recording would leave `recording` stuck
        // true with no client to stop it. connected=false always implies
        // recording=false (see onClosed), so this guard can never null a
        // client an active recording still depends on.
        if (!connected) client = null;
        connected = true;
        pushStatus();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    async connectAtStartup() {
      const s = deps.getSettings();
      // 复核 I1: in managed mode there is no user-run OBS on :4455 to dial --
      // doing so anyway just fails every startup and pollutes lastError with
      // a connection refusal that has nothing to do with managed recording.
      if (isManagedActive(s)) return;
      if (!s.recordingEnabled) return;
      await new Promise<void>((res) =>
        run(async () => {
          try {
            await ensureConnected();
            lastError = null;
          } catch (e) {
            // Degrade to lastError only -- never throw out of startup wiring
            // (same iron rule as pruneNow: recorder failures must not affect
            // the rest of app init).
            lastError = String(e);
          }
          pushStatus();
          res();
        }),
      );
    },
    async stop() {
      await new Promise<void>((res) =>
        run(async () => {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
          try {
            await doClose();
          } catch {
            /* best effort on the quit path */
          }
          try {
            if (client) await withTimeout(client.disconnect(), "disconnect");
          } catch {
            /* same as above */
          }
          connected = false;
          res();
        }),
      );
    },
    pruneNow,
    onWowUp() {
      const s = deps.getSettings();
      if (!isManagedActive(s) || !deps.managedBackend) return;
      if (managedRunning) return; // idempotent: duplicate up-signal must not double-start
      managedRunning = true;
      ensureChunkOpenedSubscription();
      runManaged(async () => {
        try {
          await deps.managedBackend!.startContinuous();
          lastError = null;
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
    onWowDown() {
      const s = deps.getSettings();
      if (!isManagedActive(s) || !deps.managedBackend) return;
      if (!managedRunning) return;
      managedRunning = false;
      managedInMatch = false;
      clearManagedIdleTimer();
      clearManagedMaxChunkTimer();
      runManaged(async () => {
        try {
          const closed = await deps.managedBackend!.stopContinuous();
          if (closed) {
            deps.recordings.closeChunk(
              closed.videoPath,
              closed.stoppedAt ?? now(),
            );
            pruneNow();
          }
          lastError = null;
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
  };
}
