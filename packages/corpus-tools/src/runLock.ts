/**
 * Run lock. The schedule fires every 6 hours while the first full run takes
 * about 22 hours — without a lock, several instances would scan the same slice
 * of the feed and re-download the same files, wasting the other side's
 * bandwidth for nothing.
 */

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export function serializeLock(info: LockInfo): string {
  return JSON.stringify(info);
}

export function parseLock(text: string): LockInfo | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.pid !== "number" || typeof o?.startedAt !== "number") {
      return null;
    }
    return { pid: o.pid, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/**
 * Absolute age ceiling for the lock. Past this age we take it over
 * unconditionally, **without asking whether the pid is alive**.
 *
 * Why it is needed: the pid predicate cannot defend against pid reuse. A
 * SIGKILL or power loss leaves the lock file behind → the machine reboots →
 * the kernel hands out pids again from the low end → the old pid is now held
 * by some unrelated process → isAlive returns true → the lock is never
 * released. From then on every run just prints "an archive process is already
 * running" and exits, never even reaching the "0 new matches this run" alert —
 * and the feed only retains 7 days, so a week of silence means a week of data
 * lost forever.
 *
 * 48h: the first full run takes about 22 hours, leaving 100% headroom. An
 * instance still alive after that gets taken over; the cost is brief
 * concurrency, far cheaper than being stuck forever.
 */
export const LOCK_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Whether this lock can be taken over.
 *
 * The primary predicate is "is the lock-holding pid still alive", not a
 * timeout: the first full run takes 22 hours, so any reasonable timeout would
 * kill a perfectly healthy instance. startedAt only serves as the fallback
 * against pid reuse (see LOCK_MAX_AGE_MS). isAlive is injected by the caller
 * (production uses `process.kill(pid, 0)`) to keep this unit-testable.
 */
export function isLockStale(
  info: LockInfo | null,
  isAlive: (pid: number) => boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!info) return true;
  // A clock step backwards makes age negative — a negative age must not count
  // as "very old", so treat it as not stale.
  const age = nowMs - info.startedAt;
  if (age >= LOCK_MAX_AGE_MS) return true;
  return !isAlive(info.pid);
}
