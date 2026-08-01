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
  windowStartS,
  windowEndS,
}: {
  marks: StripMark[];
  durationS: number;
  onSeek: (videoS: number) => void;
  /** 可选:把横轴从「整段录像」收窄到「本轮范围」(自定义控制条按轮 clamp
   * 的配套——省略时按整段录像铺开,既有单测锁定这个默认)。窗口外的标记
   * 直接丢弃,不画在条外或挤在边缘。 */
  windowStartS?: number;
  windowEndS?: number;
}) {
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const winStart = windowStartS ?? 0;
  const winEnd = windowEndS ?? durationS;
  const span = Math.max(0.001, winEnd - winStart);
  const inWindow = (s: number) => s >= winStart && s <= winEnd;
  const pct = (s: number) =>
    Math.min(100, Math.max(0, ((s - winStart) / span) * 100));
  const bands = marks.filter(
    (m) => m.moment.kind === "burst-band" && inWindow(m.videoS),
  );
  const points = marks.filter(
    (m) =>
      m.moment.kind !== "burst-band" &&
      (m.moment.weight === "major" || m.moment.kind === "mistake") &&
      inWindow(m.videoS),
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
