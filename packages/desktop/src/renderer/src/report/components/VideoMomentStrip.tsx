import type { VideoMoment } from "../derive/videoMoments";

/** 视频下方的对齐标记条(brainstorm A 定稿):burst-band 金带打底,
 * ✕ 死亡 / ⚠ 失误 点标;点击 seek。只画 major + mistakes,minor 不进条。
 * 横轴 = 视频秒(0..durationS),调用方已把战斗时刻换算成视频秒。 */
export interface StripMark {
  videoS: number;
  toVideoS?: number;
  moment: VideoMoment;
}

export function VideoMomentStrip({
  marks,
  durationS,
  onSeek,
}: {
  marks: StripMark[];
  durationS: number;
  onSeek: (videoS: number) => void;
}) {
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const pct = (s: number) => Math.min(100, Math.max(0, (s / durationS) * 100));
  const bands = marks.filter((m) => m.moment.kind === "burst-band");
  const points = marks.filter(
    (m) =>
      m.moment.kind !== "burst-band" &&
      (m.moment.weight === "major" || m.moment.kind === "mistake"),
  );
  return (
    <div className="rpt-video-strip" data-testid="video-strip">
      {bands.map((m, i) => (
        <div
          key={`b${i}`}
          className="rpt-video-strip-band"
          style={{
            left: `${pct(m.videoS)}%`,
            width: `${Math.max(0.4, pct(m.toVideoS ?? m.videoS + 1) - pct(m.videoS))}%`,
          }}
          title={`${m.moment.label}(点击定位)`}
          onClick={() => onSeek(m.videoS)}
        />
      ))}
      {points.map((m, i) => (
        <button
          key={`p${i}`}
          className={`rpt-video-strip-mark rpt-video-strip-${m.moment.kind === "death" ? "death" : m.moment.kind === "mistake" ? "mistake" : "other"}`}
          style={{ left: `${pct(m.videoS)}%` }}
          title={`${m.moment.label}(点击定位)`}
          onClick={() => onSeek(m.videoS)}
        >
          {m.moment.kind === "death"
            ? "✕"
            : m.moment.kind === "mistake"
              ? "⚠"
              : "•"}
        </button>
      ))}
    </div>
  );
}
