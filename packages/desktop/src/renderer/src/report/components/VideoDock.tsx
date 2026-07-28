import { useEffect, useRef, useState } from "react";
import { bridge } from "../../bridge";

interface RecInfo {
  url: string;
  startedAt: number;
  stoppedAt: number;
}

/** 对局录像(OBS 外控一期)。video 是回放时钟 t 的从动件——不自走时钟,
 * 偏差 >0.35s 才重对齐,10+ 处既有 seek 入口因此零改动生效。缺头(日志
 * 滞后起录)表现为开场头几秒视频停在第 0 帧,属一期接受的行为。 */
export function VideoDock({
  matchId,
  t,
  playing,
  speed,
}: {
  matchId: string;
  t: number;
  playing: boolean;
  speed: number;
}) {
  const [rec, setRec] = useState<RecInfo | null>(null);
  const [open, setOpen] = useState(true);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let alive = true;
    try {
      // 桩经常缺 recorder 面(fixture/测试台)—— 缺面时静默隐藏
      void bridge()
        .recorder?.getForMatch(matchId)
        .then((r) => {
          if (alive) setRec(r);
        })
        .catch(() => {});
    } catch {
      /* 桩缺面 */
    }
    return () => {
      alive = false;
    };
  }, [matchId]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !rec) return;
    // 回放时钟可越过视频末尾(录像比对局短);currentTime 会被浏览器钳在
    // 时长上,不钳 expected 的话差值恒 >0.35 → 每帧 seek 打满 CPU
    // (agy flash 复核 #1)。
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    const expected = Math.min(dur, Math.max(0, (t - rec.startedAt) / 1000));
    if (Math.abs(v.currentTime - expected) > 0.35) v.currentTime = expected;
  }, [t, rec]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !rec) return;
    try {
      if (playing) void Promise.resolve(v.play()).catch(() => {});
      else v.pause();
    } catch {
      /* jsdom 无媒体实现 */
    }
  }, [playing, rec]);

  useEffect(() => {
    const v = ref.current;
    if (v) v.playbackRate = speed;
  }, [speed, rec]);

  if (!rec) return null;
  return (
    <div className="rpt-video-dock" data-testid="video-dock">
      <button className="rpt-video-toggle" onClick={() => setOpen((o) => !o)}>
        🎥 录像{open ? " ▾" : " ▸"}
      </button>
      {open &&
        (failed ? (
          <p className="rpt-dim">
            无法播放该录像(建议 OBS 录制格式设为 Hybrid MP4)
          </p>
        ) : (
          <video
            ref={ref}
            data-testid="video-dock-el"
            src={rec.url}
            muted
            playsInline
            onError={() => setFailed(true)}
          />
        ))}
    </div>
  );
}
