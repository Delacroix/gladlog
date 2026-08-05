import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 复核 M8: the three retail/classic/PTR client executable names gladlog's
 * managed recording watches for. Single-sourced here -- the future assembly
 * layer (Task 5b) wires `createWowProcessWatch({ onUp: recorder.onWowUp, ... })`
 * straight off this default probe, so nobody hand-copies the process name
 * list a second time. */
export const WOW_PROCESS_NAMES = ["Wow.exe", "WowClassic.exe", "WowT.exe"];

/** Default probe: `tasklist` with no filter (broad, but reading its entire
 * output and substring-matching is simpler and more robust than juggling
 * `/FI "IMAGENAME eq ..."` three times per tick) is windows-only; this is
 * only ever invoked in managed mode, which recorder.ts's isManagedActive()
 * already gates to process.platform==="win32", so a non-Windows invocation of
 * this default is not a production path. */
async function defaultProbe(): Promise<boolean> {
  const { stdout } = await execFileP("tasklist", []);
  return WOW_PROCESS_NAMES.some((name) => stdout.includes(name));
}

/** Polls for the WoW client process being up/down and debounces the
 * transition (task-5 brief 5b). Injectable probe/interval for testing;
 * production leaves both at their defaults (tasklist probe, 2000ms --
 * arenacoach's same cadence). */
export function createWowProcessWatch(deps: {
  /** default: tasklist probe matching WOW_PROCESS_NAMES */
  probe?: () => Promise<boolean>;
  intervalMs?: number;
  onUp: () => void;
  onDown: () => void;
}): { start(): void; stop(): void } {
  const probe = deps.probe ?? defaultProbe;
  const intervalMs = deps.intervalMs ?? 2000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let up = false;
  /** Consecutive-miss counter: a single transient probe miss (or a probe
   * exception) must not flip state -- only two misses IN A ROW count as
   * genuinely down. Reset on any confirmed "up" reading. */
  let missStreak = 0;

  async function tick(): Promise<void> {
    let result: boolean;
    try {
      result = await probe();
    } catch {
      // A single probe exception is indistinguishable from a transient OS
      // hiccup (tasklist momentarily unavailable, etc.) -- deliberately does
      // NOT touch missStreak or up: no state change on exception, full stop.
      return;
    }
    if (result) {
      missStreak = 0;
      if (!up) {
        up = true;
        deps.onUp();
      }
      return;
    }
    missStreak++;
    if (up && missStreak >= 2) {
      up = false;
      missStreak = 0;
      deps.onDown();
    }
  }

  return {
    start() {
      if (timer) return; // idempotent
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
