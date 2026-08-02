/** C2 fix: app quit must wait for the recording to actually stop (StopRecord's
 * async round trip), otherwise OBS will most likely keep recording forever
 * after the process dies. Electron's `before-quit` is the only hook that can
 * intervene before quit — but it is a SYNCHRONOUS event, so making quit await a
 * Promise requires suspending it with `event.preventDefault()` and calling
 * quit() again manually once cleanup is done.
 *
 * Semantics:
 * - first before-quit: preventDefault, start cleanup (stopRecorder, capped by
 *   timeoutMs — a lost OBS connection / hung network must not wedge the quit
 *   flow), then call stopHost() and quit() when cleanup finishes.
 * - another before-quit arriving WHILE cleanup runs (the user clicking twice,
 *   or some platforms emitting one again after all windows close):
 *   preventDefault as well, but do NOT restart cleanup (no re-entry — exactly
 *   one cleanup chain is ever in flight).
 * - quit() is usually app.quit() internally, which re-triggers before-quit;
 *   on that pass cleanup has already finished, so it is let through (no
 *   preventDefault) and the app really exits.
 *
 * The only reason this was carved out of index.ts is testability: real
 * electron's app/BrowserWindow cannot be instantiated cheaply under vitest,
 * while this layer depends on three pure function dependencies and can be
 * tested completely without electron. */
export interface QuitLifecycleDeps {
  /** Usually `() => recorder?.stop() ?? Promise.resolve()` */
  stopRecorder: () => Promise<void>;
  /** Usually `() => host?.stop()` */
  stopHost: () => void;
  /** Usually `() => app.quit()` */
  quit: () => void;
  /**
   * Usually `() => stopAllAiActivity()` (ai.ts): reap in-flight local CLI child
   * processes (claude/agy/codex spawns) and the DeepSeek fetch. #21 item9, a
   * completeness fix rather than an existing bug — once the host process exits
   * these connections would naturally drop/become orphans anyway.
   * Optional (omitting it means doing nothing); fire-and-forget, and NOT part
   * of the timeoutMs race below — it is a synchronous call with no async tail
   * to await.
   */
  stopAiActivity?: () => void;
  /** Cap on waiting for a hung stop-recording, default 4s (a 3-5s range keeps
   * quit from wedging). */
  timeoutMs?: number;
}

export interface QuitLifecycleHandler {
  /** Wire up as `app.on("before-quit", (e) => handler.onBeforeQuit(e))`. */
  onBeforeQuit(event: { preventDefault(): void }): void;
  /** Test-only: await the cleanup chain (production code need not call it). */
  waitForIdle(): Promise<void>;
}

export function createQuitLifecycleHandler(
  deps: QuitLifecycleDeps,
): QuitLifecycleHandler {
  type Phase = "idle" | "stopping" | "finishing";
  let phase: Phase = "idle";
  let inFlight: Promise<void> | null = null;

  async function finish(): Promise<void> {
    // Fire-and-forget, same best-effort shape as stopHost: not part of the
    // timeoutMs race below (a synchronous call has no async tail to await),
    // and a failure must not hold up the quit flow.
    try {
      deps.stopAiActivity?.();
    } catch {
      // Best effort: the quit flow must not stall on an error here.
    }
    const timeoutMs = deps.timeoutMs ?? 4000;
    await Promise.race([
      deps.stopRecorder().catch(() => {
        /* Best effort: the quit flow must not stall on an OBS error */
      }),
      new Promise<void>((res) => setTimeout(res, timeoutMs)),
    ]);
    try {
      deps.stopHost();
    } catch {
      // Caught by a review round: stopHost is a synchronous call and, unlike
      // stopRecorder, has no .catch backstop — a synchronous throw would reject
      // finish() outright, with no production caller to catch it, turning into
      // an unhandled rejection AND meaning quit() below is never called (a quit
      // flow worse than before the fix). Best effort, never holds up quit.
    }
    // Flip to finishing BEFORE calling quit(): quit() often synchronously
    // triggers the next before-quit (electron's app.quit() does), so the pass
    // must already be allowed through by then.
    phase = "finishing";
    deps.quit();
  }

  return {
    onBeforeQuit(event) {
      if (phase === "finishing") return; // cleanup done: real quit, allow it
      event.preventDefault();
      if (phase === "idle") {
        phase = "stopping";
        inFlight = finish();
      }
      // phase === "stopping": cleanup still running — block this redundant
      // quit request, no re-entry
    },
    waitForIdle: () => inFlight ?? Promise.resolve(),
  };
}
