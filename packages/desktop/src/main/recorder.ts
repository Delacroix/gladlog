import { DEFAULT_OBS_WS_URL, OBS_PASSWORD_REDACTED } from "../shared/protocol";
import type { ObsClientLike } from "./obsClient";
import type { RecordingEntry, RecordingsStore } from "./recordingsStore";
import { RECORDING_SCHEMA } from "./recordingsStore";

export { DEFAULT_OBS_WS_URL };

/** Safety valve for a segment that stays open and never sees close (worker died / log stream stalled). */
const SAFETY_STOP_MS = 40 * 60_000;
const META_BUFFER_CAP = 20;
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
}

interface RecorderSettings {
  recordingEnabled: boolean;
  obsWebsocketUrl: string | null;
  obsWebsocketPassword: string | null;
  recordingKeepCount: number;
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

  function isAlreadyActiveError(e: unknown): boolean {
    return /already active/i.test(String(e));
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
    const { outputPath } = await withTimeout(client.stopRecord(), "StopRecord");
    // Clear weStartedRecording only after stopRecord is confirmed successful —
    // a mid-way failure (usually firing at an already-dead client during a
    // disconnect; see the onClosed comment in ensureConnected) keeps it true,
    // so the next reconcileWithReality() still recognizes this as gladlog's
    // own debt instead of misjudging a true orphan as "not started by us"
    // because we cleared too early.
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
    deps.recordings.prune(deps.getSettings().recordingKeepCount);
  }

  return {
    onSegmentOpen() {
      if (!deps.getSettings().recordingEnabled) return;
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
        deps.recordings.associate(meta);
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
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
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
  };
}
