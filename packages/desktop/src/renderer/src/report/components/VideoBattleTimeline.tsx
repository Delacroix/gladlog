import { useRef } from "react";

import type { TimelineData } from "../derive/timeline";
import type { VulnBand } from "../derive/vulnWindows";

const W = 1200;
const H = 100;
const PAD = { l: 6, r: 6, t: 8, b: 8 };

/**
 * 录像页「战斗时间轴」卡(UI 改版 2a):主 seek 面 —— HP 曲线 + 金带 +
 * 死亡 ✕ + 播放头,点/拖任意位置 = 视频 seek;控制条细进度条只做微调。
 *
 * 数据与战报**同源 derive**(deriveTimeline/deriveVulnBands 由 MatchReport
 * 传入,不在此重复计算)—— 死亡/爆发窗 glyph 时刻与战报一致是验收硬指标;
 * 绘制组件独立于 Timeline.tsx(那是 240 高的交互工作台,带拖选/泳道/轴,
 * 塞进 96px 高的 seek 面只会两头不像)。
 */
export function VideoBattleTimeline({
  data,
  bands,
  playerTeamId,
  curBattleS,
  onSeek,
  disabled = false,
}: {
  data: TimelineData;
  bands: VulnBand[];
  playerTeamId: number | null;
  /** 播放头(相对本场秒);null = 无播放位置(无录像)。 */
  curBattleS: number | null;
  onSeek?: (battleS: number) => void;
  /** 无录像:照常渲染(数据来自 log),但不响应 seek。 */
  disabled?: boolean;
}) {
  const durS = Math.max(1, (data.end - data.start) / 1000);
  const dragging = useRef(false);
  const x = (s: number) =>
    PAD.l + (Math.min(Math.max(s, 0), durS) / durS) * (W - PAD.l - PAD.r);
  const y = (ratio: number) =>
    H - PAD.b - Math.min(Math.max(ratio, 0), 1) * (H - PAD.t - PAD.b);

  const seekFromEvent = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || !onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const battleS = ((vx - PAD.l) / Math.max(1, W - PAD.l - PAD.r)) * durS;
    onSeek(Math.min(Math.max(battleS, 0), durS));
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={disabled ? "rpt-video-bt-svg disabled" : "rpt-video-bt-svg"}
      data-testid="video-battle-timeline"
      role="slider"
      aria-label="战斗时间轴(点击或拖动定位录像)"
      aria-valuemin={0}
      aria-valuemax={Math.round(durS)}
      aria-valuenow={curBattleS != null ? Math.round(curBattleS) : 0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekFromEvent(e);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {/* 金带/承压带(与战报同一 deriveVulnBands) */}
      {bands.map((b, i) => (
        <rect
          key={i}
          x={x(b.fromS)}
          y={PAD.t}
          width={Math.max(1, x(b.toS) - x(b.fromS))}
          height={H - PAD.t - PAD.b}
          fill={b.kind === "burst" ? "var(--gold)" : "var(--loss)"}
          opacity={b.kind === "burst" ? 0.18 : 0.1}
        />
      ))}
      {/* HP 曲线:友方 win 色 / 敌方 loss 色(96px 高的 seek 面不上职业色);
          敌方降透明度(三点五-4④)—— seek 面的主角是己方血线,八条同亮度
          在 96px 里糊成一团。 */}
      {data.series.map((s) => {
        if (s.points.length < 2) return null;
        const friendly = playerTeamId != null && s.teamId === playerTeamId;
        return (
          <path
            key={s.unitId}
            fill="none"
            stroke={friendly ? "var(--win)" : "var(--loss)"}
            strokeWidth={1.2}
            opacity={friendly ? 0.85 : 0.4}
            d={s.points
              .map(
                (p, j) =>
                  `${j === 0 ? "M" : "L"}${x((p.t - data.start) / 1000).toFixed(1)},${y(
                    p.maxHp > 0 ? p.hp / p.maxHp : 0,
                  ).toFixed(1)}`,
              )
              .join(" ")}
          />
        );
      })}
      {/* 死亡 ✕(与战报同一 timeline.deaths,已滤假死/非玩家) */}
      {data.deaths.map((d, i) => (
        <text
          key={i}
          x={x((d.t - data.start) / 1000)}
          y={PAD.t + 10}
          textAnchor="middle"
          className="rpt-video-bt-death"
        >
          ✕<title>{d.name.split("-")[0]}</title>
        </text>
      ))}
      {/* 播放头 */}
      {curBattleS != null && (
        <line
          x1={x(curBattleS)}
          x2={x(curBattleS)}
          y1={2}
          y2={H - 2}
          className="rpt-video-bt-head"
          data-testid="video-bt-playhead"
        />
      )}
    </svg>
  );
}
