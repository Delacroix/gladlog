import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, resolve } from "path";

import { atomicWriteFileSync } from "../shared/atomicWrite";

/**
 * Time-window association tolerance: a recording starting later than the match
 * opening is normal (log lag), so the criterion is overlap, not containment.
 */
export const TOLERANCE_MS = 60_000;

/** I2 fix: retention cap for orphan (unassociated) recordings, computed
 * completely independently of the matched recordings' keepCount — otherwise
 * orphans squeeze out keepCount slots and evict recordings that really are
 * associated with a match (audit Important #2: prune used to sort ALL entries
 * by startedAt together, regardless of matchId).
 * 2 is chosen to cover the two in-flight candidates: "the segment currently
 * recording" plus "the segment that just ended and is still waiting for its
 * associate() message". More than that just burns disk for no benefit. */
const ORPHAN_KEEP_CAP = 2;

export interface RecordingEntry {
  videoPath: string;
  /** StartRecord wall-clock epoch ms — the replay side's alignment anchor. */
  startedAt: number;
  stoppedAt: number;
  matchId: string | null;
}

/** Overlap in milliseconds between [e.startedAt, e.stoppedAt] and
 * [meta.startTime, meta.endTime].
 * The field has been mandatory since the store was created, so in theory it is
 * never missing; this still defensively handles legacy data / hand-edited bad
 * lines without stoppedAt, returning null so the caller falls back to the old
 * "closest startedAt" criterion instead of treating it as 0 overlap and wrongly
 * sorting it last (0 overlap is a LEGITIMATE value — two segments touching but
 * not intersecting — and must not be conflated with "unknown"). */
function overlapMs(
  e: RecordingEntry,
  meta: { startTime: number; endTime: number },
): number | null {
  if (typeof e.stoppedAt !== "number") return null;
  const start = Math.max(e.startedAt, meta.startTime);
  const end = Math.min(e.stoppedAt, meta.endTime);
  return Math.max(0, end - start);
}

/** Recording index (kept separate from matchStore — its self-healing path
 * rmSync's a whole match directory, so recordings must never live there).
 * One ndjson line per entry; writes back (association/pruning) rewrite the
 * whole file atomically (tmp + rename). */
export class RecordingsStore {
  constructor(
    private dir: string,
    /** I3: unindexed files (OBS crash orphans / the user's own manual
     * recordings) are only REPORTED for visibility, never deleted — this is
     * OBS's own output directory and may contain the user's manual recordings,
     * so scanning and deleting the whole directory would repeat the same class
     * of destructive act as "blindly stopping the user's recording during
     * cleanup" (see the recorder.ts weStartedRecording lesson). No-op by
     * default; in production main/index.ts wires electron-log in here. */
    private log: (msg: string) => void = () => {},
  ) {}
  private indexPath(): string {
    return join(this.dir, "recordings.ndjson");
  }

  list(): RecordingEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.indexPath(), "utf-8");
    } catch {
      return [];
    }
    // Per-line tolerance: one corrupt line (power-loss truncation) loses only
    // that line — a whole-file catch would let the next rewrite wipe all valid
    // history (agy flash review #2).
    const out: RecordingEntry[] = [];
    for (const l of raw.split("\n")) {
      if (l.trim() === "") continue;
      try {
        out.push(JSON.parse(l) as RecordingEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  private rewrite(entries: RecordingEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWriteFileSync(
      this.indexPath(),
      entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length ? "\n" : ""),
    );
  }

  add(entry: RecordingEntry): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.indexPath(), JSON.stringify(entry) + "\n");
  }

  /** Time-window overlap association; writes back on a hit. With multiple
   * candidates, the one COVERING MORE of the match's time window wins (I1 fix,
   * audit Important #1) — in a quit-and-relaunch scenario, the truncated
   * pre-quit recording A may have a startedAt right next to meta.startTime
   * (the "closest" one) yet only captured a sliver of the match opening before
   * quit cut it off, while the reconnect recording B starts later but actually
   * covers the match's ending. The old "closest startedAt to meta.startTime"
   * criterion reliably picked the useless A and left the useful B in the orphan
   * pile. Only when overlap durations tie (including both 0, or both missing
   * stoppedAt so overlapMs returns null) does it fall back to the old
   * "closest startedAt" criterion.
   * When back-to-back DOUBLE_START matches share one recording, the first meta
   * to arrive wins and the second gets nothing — accepted for phase 1. */
  associate(meta: {
    id: string;
    startTime: number;
    endTime: number;
  }): RecordingEntry | null {
    const entries = this.list();
    const candidates = entries.filter(
      (e) =>
        e.matchId === null &&
        e.startedAt <= meta.endTime + TOLERANCE_MS &&
        e.stoppedAt >= meta.startTime - TOLERANCE_MS,
    );
    if (candidates.length === 0) return null;
    const hit = candidates
      .map((e) => ({ e, overlap: overlapMs(e, meta) }))
      .sort((a, b) => {
        const ao = a.overlap ?? -1;
        const bo = b.overlap ?? -1;
        if (bo !== ao) return bo - ao;
        return (
          Math.abs(a.e.startedAt - meta.startTime) -
          Math.abs(b.e.startedAt - meta.startTime)
        );
      })[0]!.e;
    hit.matchId = meta.id;
    this.rewrite(entries);
    return hit;
  }

  getForMatch(matchId: string): RecordingEntry | null {
    return this.list().find((e) => e.matchId === matchId) ?? null;
  }

  /** I3: scan the recordings directory and report, at info level, the count
   * and total size of files that are not in the index (OBS crashed mid-way and
   * never even reached StopRecord, leaving no index line; or things the user
   * recorded manually into the same directory). Deliberately does NOT delete
   * and does NOT try to distinguish "crash orphan" from "the user's own
   * recording" — the two are indistinguishable from the filesystem's point of
   * view, and guessing would repeat the destroy-user-data mistake.
   * Not covered: this log only makes the files VISIBLE so a human can clean
   * them up; it never reclaims that disk automatically. The only orphans that
   * can be handled automatically are the recorder.ts ones "gladlog started
   * itself and still remembers the startedAt for" (closeOrphanRecording, which
   * indexes the outputPath returned by stopRecord()) — the case where the OBS
   * PROCESS itself crashes and restarts (as opposed to a websocket
   * disconnection), leaving no positive evidence at all, is out of scope for
   * this fix and is honestly recorded here as a remaining gap. */
  private reportUnindexedFiles(entries: RecordingEntry[]): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const indexed = new Set(entries.map((e) => resolve(e.videoPath)));
    let count = 0;
    let bytes = 0;
    for (const name of names) {
      if (name === "recordings.ndjson" || name.endsWith(".tmp")) continue;
      const p = resolve(join(this.dir, name));
      if (indexed.has(p)) continue;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        count++;
        bytes += st.size;
      } catch {
        /* Races such as the file vanishing between readdir and stat — skip;
           the visibility log's ballpark numbers are unaffected */
      }
    }
    if (count > 0) {
      this.log(
        `[recordings] ${count} 个未入索引文件,共 ${(bytes / 1_000_000).toFixed(1)}MB —— ` +
          `可能是 OBS 崩溃孤儿或用户手动录像,不会自动删除,需人工核查`,
      );
    }
  }

  /** Retention policy (I2/I4 fixes, audit Important #2/#4):
   * - matched entries (matchId set) and orphans (matchId === null) get
   *   SEPARATE quotas — orphans never squeeze out matched entries' keepCount
   *   slots, and their own quota is the fixed ORPHAN_KEEP_CAP.
   * - a line is removed from the index only when unlink actually succeeded (or
   *   the file was already gone); lines whose deletion failed (e.g. the file is
   *   held open by vod:// playback on Windows) are kept in the index verbatim
   *   and retried by the next prune — which both keeps a playing link from
   *   breaking and prevents the file itself from becoming unreachable and
   *   occupying disk forever because its index line was dropped (I4: the old
   *   code swallowed the failure in catch {} and still dropped the line outside
   *   keep — a deliberately left leak). */
  prune(keepCount: number): { deleted: number } {
    const entries = this.list();
    this.reportUnindexedFiles(entries);
    if (keepCount <= 0) return { deleted: 0 };

    const matched = entries
      .filter((e) => e.matchId !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
    const orphans = entries
      .filter((e) => e.matchId === null)
      .sort((a, b) => b.startedAt - a.startedAt);
    const keepMatched = matched.slice(0, keepCount);
    const keepOrphans = orphans.slice(0, ORPHAN_KEEP_CAP);
    const candidateDrop = [
      ...matched.slice(keepCount),
      ...orphans.slice(ORPHAN_KEEP_CAP),
    ];
    if (candidateDrop.length === 0) return { deleted: 0 };

    let deleted = 0;
    const survivors: RecordingEntry[] = [];
    for (const e of candidateDrop) {
      let removed = true;
      try {
        if (existsSync(e.videoPath)) unlinkSync(e.videoPath);
      } catch {
        // File in use, etc. — keep the index line and retry on the next
        // prune (I4)
        removed = false;
      }
      if (removed) deleted++;
      else survivors.push(e);
    }
    this.rewrite([...keepMatched, ...keepOrphans, ...survivors]);
    return { deleted };
  }
}
