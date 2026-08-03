import { useEffect, useState } from "react";

import type { UpdateState } from "../../../main/updater";
import type { GladlogApi } from "../../../preload/api";
import { getBatchStatus, subscribeBatch } from "../batch/batchAnalysis";
import { bridge } from "../bridge";
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

/** The recorder surface is read defensively for one concrete reason: this
 *  component is the very first renderer-side consumer of recorder.onStatus
 *  (preload/api.ts:319), so every pre-existing bridge stub — fixtureBridge.ts
 *  and the ~40 component tests — lacks it entirely and the property access
 *  itself throws. Update-side access is NOT done here; it lives in
 *  update/updateBridge.ts. */
function recorderSurface(): GladlogApi["recorder"] | undefined {
  try {
    return bridge()?.recorder;
  } catch {
    return undefined;
  }
}

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
  const [recording, setRecording] = useState(false);
  const [analyzing, setAnalyzing] = useState(() => getBatchStatus().running);

  // CLAUDE.md's single-source rule applied to "is the app busy": both facts
  // are consumed from their existing owners, never re-derived here.
  //   recording  = RecorderStatus.recording (main is the sole owner)
  //   analyzing  = getBatchStatus().running (the batch/auto-analyze driver)
  // Known hole, deliberately left: a single match analysed by hand from the
  // report page goes through bridge().analysis.run directly
  // (report/components/StructuredAnalysisPanel.tsx:687) and never touches the
  // batch driver, so it does not count as busy. Covering it would mean
  // inventing a second "in flight" registry in the renderer — exactly the
  // hand-copied predicate the rule forbids (main only exposes a per-matchId
  // analysis.getState(id).running, no global snapshot). The cost is bounded:
  // the worst case is losing that one analysis round (its cache was never
  // written); no match data is at risk. Switch to a global running snapshot
  // the day main grows one.
  useEffect(() => {
    const rec = recorderSurface();
    if (!rec) return;
    void rec
      .getStatus()
      .then((s) => setRecording(s.recording))
      .catch(() => {});
    return rec.onStatus((s) => setRecording(s.recording));
  }, []);

  useEffect(
    () => subscribeBatch(() => setAnalyzing(getBatchStatus().running)),
    [],
  );

  const busyReason = recording
    ? "正在录制,退出时会自动更新"
    : analyzing
      ? "正在分析,退出时会自动更新"
      : null;

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
              disabled={busyReason != null}
              onClick={() => void requestUpdateInstall()}
            >
              立即重启
            </button>
            <button onClick={() => setDismissed(true)}>稍后</button>
            {busyReason && <span className="upd-note">{busyReason}</span>}
          </span>
        )}
      </div>
    );
  }
  return null;
}
