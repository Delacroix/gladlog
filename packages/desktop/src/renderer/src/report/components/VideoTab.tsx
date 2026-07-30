import { useEffect, useRef } from "react";
import type { ReportSource } from "../derive/types";

/** 独立「录像」tab(真机反馈:回放页小窗太小)。全宽原生播放器,自主
 * 播放/拖动/音量;打开时自动定位到本场(shuffle 为本轮)开始。与回放页
 * 的同步小窗互不干扰。 */
export function VideoTab({
  url,
  startedAt,
  source,
}: {
  url: string;
  /** 录像起点墙钟 epoch ms(播放锚点)。 */
  startedAt: number;
  source: ReportSource;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const offset = Math.max(0, (source.startTime - startedAt) / 1000);
    const seek = () => {
      v.currentTime = offset;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [source, startedAt]);

  return (
    <div className="rpt-video-tab">
      <video ref={ref} src={url} controls playsInline />
      <p className="rpt-dim rpt-video-tab-hint">
        已定位到本场开始;要与战斗时间轴联动逐秒对照,用「回放」页的录像小窗。
      </p>
    </div>
  );
}
