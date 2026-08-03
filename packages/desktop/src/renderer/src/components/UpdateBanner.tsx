import { useEffect, useState } from "react";

import type { UpdateState } from "../../../main/updater";
import {
  fetchUpdateState,
  requestUpdateInstall,
  subscribeUpdateState,
} from "../update/updateBridge";

/** The type-only import of UpdateState is mandatory: a value import of
 *  main/updater.ts would drag electron-updater into the renderer bundle and
 *  break both `npm run build:ui` (the visual-regression web server) and the
 *  production electron-vite build. Precedent: preload/api.ts:6 imports
 *  RecorderStatus the same way. */

/**
 * Update indicator in the top bar (spec §4.5, the two stages the user signed
 * off on): downloading = one thin non-interactive line; ready = a dismissible
 * banner that degrades into a small always-there button after "稍后".
 * idle / checking / disabled render nothing — a failed check must never nag
 * (network failure is the normal case when pulling 110 MB from GitHub, and it
 * breaks no feature). The one error worth interrupting for is handled further
 * down.
 *
 * Every update-side call goes through update/updateBridge.ts. That module owns
 * the defensive access to `bridge().update` (component tests and the fixture
 * preview routinely lack whole surfaces) and, further down, the §4.7
 * lastSeenVersion predicate. Re-implementing either here would be the
 * hand-copied predicate CLAUDE.md forbids.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void fetchUpdateState().then((s) => {
      if (s) setState(s);
    });
    // Both push and snapshot: mounting later than the event (window reopen /
    // view switch) would otherwise lose the state entirely.
    return subscribeUpdateState((s) => {
      setState(s);
      // A newly arrived "ready" reopens the banner even if an older one was
      // dismissed — a different version is a different piece of news.
      if (s.phase === "ready") setDismissed(false);
    });
  }, []);

  if (state?.phase === "downloading") {
    return (
      <div className="upd-slot">
        <span className="upd-line">
          正在下载 {state.version} · {Math.round(state.percent)}%
        </span>
      </div>
    );
  }
  if (state?.phase === "ready") {
    return (
      <div className="upd-slot">
        {dismissed ? (
          <button className="upd-chip" onClick={() => setDismissed(false)}>
            新版 {state.version} 已就绪
          </button>
        ) : (
          <span className="upd-banner" role="status">
            <span>新版 {state.version} 已就绪</span>
            <button
              className="upd-primary"
              onClick={() => void requestUpdateInstall()}
            >
              立即重启
            </button>
            <button onClick={() => setDismissed(true)}>稍后</button>
          </span>
        )}
      </div>
    );
  }
  return null;
}
