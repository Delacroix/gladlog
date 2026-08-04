import type { UpdateState } from "../../../main/updater";
import { bridge } from "../bridge";

/**
 * Renderer-side entry point for auto-update, and the ONLY copy of the §4.7
 * lastSeenVersion predicate — UpdateBanner and SettingsPanel import from here
 * rather than re-deriving it (CLAUDE.md: one predicate, two importers).
 *
 * Every call is wrapped in try/catch for exactly one reason: the bridge stubs
 * used by the fixture preview and by ~40 component tests only implement the
 * surfaces they need, so `bridge().update` is frequently undefined and the
 * property access throws synchronously. Same precedent as App.tsx's settings
 * stub (App.tsx:45-55) and the auto-analyze listener (App.tsx:57-67) — a
 * missing surface degrades to "no update information", never to a crashed view.
 */
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void {
  try {
    return bridge().update.onState(cb);
  } catch {
    return () => {};
  }
}

export async function fetchUpdateState(): Promise<UpdateState | null> {
  try {
    return await bridge().update.getState();
  } catch {
    return null;
  }
}

export async function requestUpdateCheck(): Promise<void> {
  try {
    await bridge().update.check();
  } catch {
    // Failures land in the pushed state (§4.2: never interrupt the user).
  }
}

export async function requestUpdateInstall(): Promise<void> {
  try {
    await bridge().update.install();
  } catch {
    // Same as above; install() is a no-op unless the state is "ready".
  }
}

/** Whether this environment exposes the update surface at all. The settings
 *  page renders "此环境不提供自动更新" when it does not — which is the case
 *  under the fixture preview and in every component test stub. */
export function hasUpdateSurface(): boolean {
  try {
    return typeof bridge().update?.getState === "function";
  } catch {
    return false;
  }
}

/**
 * §4.7: auto-update is invisible by design, so the first launch on a new build
 * leaves a trace. Returns the version to announce, or null when there is
 * nothing to say.
 */
export async function resolveVersionNotice(): Promise<string | null> {
  try {
    const [version, settings] = await Promise.all([
      bridge().app.getVersion(),
      bridge().settings.get(),
    ]);
    const seen = settings.lastSeenVersion ?? null;
    if (seen === version) return null;
    if (seen === null) {
      // Fresh install (or a settings file predating this field): nothing to
      // announce. Record it now, otherwise the notice would fire on the next
      // launch of the very same build.
      await bridge().settings.save({ lastSeenVersion: version });
      return null;
    }
    return version;
  } catch {
    return null;
  }
}

export async function dismissVersionNotice(version: string): Promise<void> {
  try {
    await bridge().settings.save({ lastSeenVersion: version });
  } catch {
    // Nothing to do: worst case the notice shows once more next launch.
  }
}
