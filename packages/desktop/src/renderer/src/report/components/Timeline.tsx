import { scaleLinear } from "d3-scale";
import { useMemo, useState } from "react";

import { classColor } from "../data/gameConstants";
import type { ExposureMark, PressureBand } from "../derive/pressureLanes";
import type { TimelineData } from "../derive/timeline";
import type { TimeRange } from "../derive/timeRange";
import type { VulnBand } from "../derive/vulnWindows";

/** 拖选至少要拖出这么多 viewBox 像素才算窗口选择,否则视为普通点击
 * (band/曲线/死亡标记的 onClick 不受影响)。 */
const DRAG_MIN_PX = 8;

// UI 改版 1a:双栏后左列 ~1100-1500px,viewBox 等比缩放决定实高 ——
// 800×240(10:3)在宽列下会放高到 450px;1200×240(5:1)让 1100px 列
// 正好 ~220px(设计稿数字)。TIMELINE_BUCKETS(derive/timeline.ts)按
// 「桶数≈绘制区宽」不变量同步 1160。
const W = 1200,
  H = 240,
  PAD = { l: 34, r: 8, t: 18, b: 18 };
/** 承压泳道(#4)高度:画在绘图区内底缘细条,不改 H、不缩曲线。 */
const LANE_H = 8;
/** 泳道间距(#10 T2):dampening 泳道叠在承压泳道正上方的空隙。 */
const LANE_GAP = 2;

/**
 * Catmull-Rom → 三次贝塞尔的平滑路径:每秒采样的 HP 折线直接连线太生硬。
 * 控制点 y 钳制在绘图区内,防止急降/急升处的过冲画出 >100% 或 <0% 的假象。
 */
function smoothPath(
  pts: Array<{ x: number; y: number }>,
  yMin: number,
  yMax: number,
): string {
  if (pts.length === 0) return "";
  if (pts.length < 3)
    return pts
      .map(
        (p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`,
      )
      .join(" ");
  const cy = (v: number) => Math.max(yMin, Math.min(yMax, v));
  // 端点 y 也钳制(logging 抖动可能给出 >100%/<0% 的比值,控制点钳而端点
  // 不钳会在边界处画出折角);控制点 x 钳在段内,非均匀采样时防时间轴回弯。
  const P = pts.map((p) => ({ x: p.x, y: cy(p.y) }));
  let d = `M${P[0]!.x.toFixed(1)},${P[0]!.y.toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)]!;
    const p1 = P[i]!;
    const p2 = P[i + 1]!;
    const p3 = P[Math.min(P.length - 1, i + 2)]!;
    const cx = (v: number) => Math.max(p1.x, Math.min(p2.x, v));
    const c1x = cx(p1.x + (p2.x - p0.x) / 6);
    const c1y = cy(p1.y + (p2.y - p0.y) / 6);
    const c2x = cx(p2.x - (p3.x - p1.x) / 6);
    const c2y = cy(p2.y - (p3.y - p1.y) / 6);
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

export function Timeline({
  data,
  onSelectUnit,
  hidden,
  onDeathClick,
  bands,
  onBandClick,
  cursorT,
  range,
  onRangeSelect,
  marks,
  onMarkClick,
  pressure,
  dampening,
}: {
  data: TimelineData;
  onSelectUnit?: (unitId: string) => void;
  /** 隐藏的 unitId 集合:这些玩家的生命曲线/死亡标记不画。 */
  hidden?: Set<string>;
  /** 死亡标记点击 → 打开死亡回顾(backlog #6)。t 为绝对 ms。 */
  onDeathClick?: (unitId: string, t: number) => void;
  /** KILL WINDOW/VULNERABLE 背景色带(相对秒);点击 → 回放该时刻。 */
  bands?: VulnBand[];
  onBandClick?: (tSeconds: number) => void;
  /** 回放光标投影(1c):从回放切回时的最后时刻(绝对 ms)。 */
  cursorT?: number | null;
  /** 时间窗联动①:当前窗口(相对秒),画成高亮选区;曲线永远全场。 */
  range?: TimeRange | null;
  /** 图上拖选提交窗口(相对秒)。 */
  onRangeSelect?: (fromS: number, toS: number) => void;
  /** 失误标记(第四阶段③):顶部 ⚠,点击跳回放。 */
  marks?: Array<{ tS: number; label: string; severity: string }>;
  onMarkClick?: (tS: number) => void;
  /** 承压泳道(#4):spike 底部细条(点击设时间窗)+ exposure 菱形标记。 */
  pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] };
  /** dampening 泳道(#10 T2):每秒 0-100 百分比稠密序列,画在承压泳道正
   * 上方一条独立细条,透明度按 pct/100 映射。 */
  dampening?: Array<{ tS: number; pct: number }>;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const series = useMemo(
    () =>
      hidden ? data.series.filter((s) => !hidden.has(s.unitId)) : data.series,
    [data, hidden],
  );
  const deaths = hidden
    ? data.deaths.filter((d) => !hidden.has(d.unitId))
    : data.deaths;
  const x = scaleLinear()
    .domain([data.start, data.end])
    .range([PAD.l, W - PAD.r]);
  const y = scaleLinear()
    .domain([0, 1])
    .range([H - PAD.b, PAD.t]);
  // path 的 d 字符串是全组件最贵的产出(每条曲线几百~上千段贝塞尔)。
  // cursor/dragFrom 的 mousemove setState 每秒重渲几十次,d 必须 memo 在
  // 数据维度上,否则划过图表 = 每帧重建全部曲线字符串 + 浏览器重新解析路径。
  const linePaths = useMemo(
    () =>
      series.map((s) => ({
        s,
        d: smoothPath(
          s.points.map((p) => ({
            x: x(p.t),
            y: y(p.maxHp > 0 ? p.hp / p.maxHp : 0),
          })),
          PAD.t,
          H - PAD.b,
        ),
      })),
    // x/y 每渲染重建但由 data 完全决定,故依赖锚在 [series, data]
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, data],
  );
  const relSec = (t: number) => ((t - data.start) / 1000).toFixed(1);

  // dampening 泳道(#10 T2):稠密的每秒序列先按连续同 pct 合并成段(RLE),
  // 不然逐秒画 rect——长局几百个 <rect> 全是视觉上的重复色块。
  const dampBands = useMemo(() => {
    if (!dampening || dampening.length === 0) return [];
    const bands: Array<{ fromS: number; toS: number; pct: number }> = [];
    for (const p of dampening) {
      const last = bands[bands.length - 1];
      if (last && last.pct === p.pct) {
        last.toS = p.tS + 1;
      } else {
        bands.push({ fromS: p.tS, toS: p.tS + 1, pct: p.pct });
      }
    }
    return bands;
  }, [dampening]);

  // ⚠ 聚簇(P1-4):按 x 投影排序,间距 <8px 的连续组并为一个 ⚠N
  const MARK_CLUSTER_PX = 8;
  const SEV_RANK: Record<string, number> = { major: 0, average: 1, minor: 2 };
  const markGroups: Array<{
    x: number;
    items: Array<{ tS: number; label: string; severity: string }>;
  }> = [];
  for (const mk of (marks ?? [])
    .filter((mk) => mk.tS > 0)
    .map((mk) => ({ ...mk, px: x(data.start + mk.tS * 1000) }))
    .sort((a, b) => a.px - b.px)) {
    const last = markGroups[markGroups.length - 1];
    const lastX = last?.items.length
      ? x(data.start + last.items[last.items.length - 1]!.tS * 1000)
      : null;
    if (last && lastX !== null && mk.px - lastX < MARK_CLUSTER_PX)
      last.items.push(mk);
    else markGroups.push({ x: mk.px, items: [mk] });
  }
  const worstSev = (items: Array<{ severity: string }>): string =>
    items.reduce(
      (w, m) =>
        (SEV_RANK[m.severity] ?? 9) < (SEV_RANK[w] ?? 9) ? m.severity : w,
      items[0]?.severity ?? "minor",
    );
  // 死亡标签避让(P1-4):与任一 ⚠ 组或相邻死亡标签 x 距 <40px → 左锚 + 引导线
  const AVOID_PX = 40;
  const deathFlip = deaths.map((d, i) => {
    const dx = x(d.t);
    return (
      markGroups.some((g) => Math.abs(g.x - dx) < AVOID_PX) ||
      deaths.some(
        (o, j) => j !== i && Math.abs(x(o.t) - dx) < AVOID_PX && j < i,
      )
    );
  });

  return (
    <div className="rpt-timeline-wrap">
      <svg
        data-testid="rpt-timeline"
        viewBox={`0 0 ${W} ${H}`}
        className="rpt-timeline"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setCursor(((e.clientX - rect.left) / rect.width) * W);
        }}
        onMouseLeave={() => {
          setCursor(null);
          setDragFrom(null);
        }}
        onMouseDown={
          onRangeSelect
            ? (e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setDragFrom(((e.clientX - rect.left) / rect.width) * W);
              }
            : undefined
        }
        onMouseUp={
          onRangeSelect
            ? () => {
                if (
                  dragFrom !== null &&
                  cursor !== null &&
                  Math.abs(cursor - dragFrom) >= DRAG_MIN_PX
                ) {
                  const [a, b] = [
                    Math.min(dragFrom, cursor),
                    Math.max(dragFrom, cursor),
                  ];
                  const toRel = (px: number) =>
                    Math.max(
                      0,
                      Math.round((x.invert(px) - data.start) / 100) / 10,
                    );
                  onRangeSelect(toRel(a), toRel(b));
                }
                setDragFrom(null);
              }
            : undefined
        }
      >
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(p)}
              y2={y(p)}
              className="rpt-tl-grid"
            />
            <text x={4} y={y(p) + 4} className="rpt-tl-axis">
              {Math.round(p * 100)}%
            </text>
          </g>
        ))}
        {(bands ?? []).map((b, i) => {
          const fromX = x(data.start + b.fromS * 1000);
          const toX = x(data.start + b.toS * 1000);
          return (
            <rect
              key={`band${i}`}
              data-testid="tl-band"
              className={`rpt-tl-band rpt-tl-band-${b.kind}`}
              x={fromX}
              y={PAD.t}
              width={Math.max(2, toX - fromX)}
              height={H - PAD.t - PAD.b}
              onClick={onBandClick ? () => onBandClick(b.fromS) : undefined}
              style={{ cursor: onBandClick ? "pointer" : undefined }}
            >
              <title>
                {(b.kind === "burst"
                  ? `击杀尝试 on ${b.targetName}(团队伤害 ${(b.damage / 1000).toFixed(0)}k)`
                  : `${b.targetName} 脆弱且未被惩罚`) +
                  (onBandClick ? "(点击回放)" : "")}
              </title>
            </rect>
          );
        })}
        {/* dampening 泳道(#10 T2):承压泳道正上方一条独立细条,pct 越高
            透明度越高;RLE 合并段,悬浮 title 显示百分比。pct===0 的段
            opacity=0 完全不可见且不可交互,直接跳过不画 rect。 */}
        {dampBands
          .filter((b) => b.pct > 0)
          .map((b, i) => {
            const x1 = x(data.start + b.fromS * 1000);
            const x2 = x(data.start + b.toS * 1000);
            return (
              <rect
                key={`dp${i}`}
                data-testid="rpt-damp-lane"
                className="rpt-dampening-lane"
                x={x1}
                width={Math.max(1, x2 - x1)}
                y={H - PAD.b - LANE_H * 2 - LANE_GAP}
                height={LANE_H}
                opacity={b.pct / 100}
              >
                <title>{`Dampening ${b.pct}%`}</title>
              </rect>
            );
          })}
        {/* 承压泳道(#4):底部细条 spike(点击设时间窗)+ exposure 菱形标记。
            放在 bands 之后、曲线之前——被曲线压住无妨,块半透明。 */}
        {(pressure?.spikes ?? []).map((s, i) => {
          const x1 = x(data.start + s.fromS * 1000);
          const x2 = x(data.start + s.toS * 1000);
          const dmgM = (s.totalDamage / 1_000_000).toFixed(2);
          const mm = (v: number) =>
            `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
          return (
            <rect
              key={`ps${i}`}
              data-testid="pressure-spike"
              className="rpt-pressure-spike"
              x={x1}
              width={Math.max(3, x2 - x1) /* 最小宽度,bands 先例精神 */}
              y={H - PAD.b - LANE_H}
              height={LANE_H}
              onClick={
                onRangeSelect ? () => onRangeSelect(s.fromS, s.toS) : undefined
              }
              style={{ cursor: onRangeSelect ? "pointer" : undefined }}
            >
              <title>{`${mm(s.fromS)}–${mm(s.toS)} ${s.targetName.split("-")[0]} 承压 ${dmgM}M(${s.dpsK}k DPS)${onRangeSelect ? "(点击设为时间窗)" : ""}`}</title>
            </rect>
          );
        })}
        {(pressure?.exposures ?? []).map((e, i) => {
          const cx = x(data.start + e.tS * 1000);
          const cy = H - PAD.b - LANE_H / 2;
          return (
            <path
              key={`pe${i}`}
              data-testid="pressure-exposure"
              className={`rpt-pressure-exposure rpt-pressure-exposure-${e.label.toLowerCase()}`}
              d={`M ${cx} ${cy - 5} L ${cx + 4} ${cy} L ${cx} ${cy + 5} L ${cx - 4} ${cy} Z`}
            >
              <title>{e.title}</title>
            </path>
          );
        })}
        {/* 时间窗选区(①):已提交窗口高亮 + 拖选过程中的预览 */}
        {range && (
          <rect
            data-testid="tl-range"
            className="rpt-tl-range"
            x={x(data.start + range.fromS * 1000)}
            y={PAD.t}
            width={Math.max(
              2,
              x(data.start + range.toS * 1000) -
                x(data.start + range.fromS * 1000),
            )}
            height={H - PAD.t - PAD.b}
          />
        )}
        {dragFrom !== null &&
          cursor !== null &&
          Math.abs(cursor - dragFrom) >= DRAG_MIN_PX && (
            <rect
              className="rpt-tl-range rpt-tl-range-preview"
              x={Math.min(dragFrom, cursor)}
              y={PAD.t}
              width={Math.abs(cursor - dragFrom)}
              height={H - PAD.t - PAD.b}
            />
          )}
        {linePaths.map(({ s, d }) => (
          <path
            key={s.unitId}
            className="rpt-tl-line"
            fill="none"
            stroke={classColor(s.classId)}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: onSelectUnit ? "pointer" : undefined }}
            onClick={() => onSelectUnit?.(s.unitId)}
            d={d}
          >
            <title>{s.name}</title>
          </path>
        ))}
        {/* 死亡标记(1c):圆点 + ✕ + 上方名字·时间标注 */}
        {deaths.map((d, i) => (
          <g
            key={i}
            className={
              onDeathClick ? "rpt-tl-death rpt-tl-death-click" : "rpt-tl-death"
            }
            transform={`translate(${x(d.t).toFixed(1)},${PAD.t})`}
            onClick={
              onDeathClick ? () => onDeathClick(d.unitId, d.t) : undefined
            }
          >
            <circle r={5} className="rpt-tl-death-dot" />
            <text y={2.6} className="rpt-tl-death-x" textAnchor="middle">
              ✕
            </text>
            {deathFlip[i] ? (
              <g>
                <line
                  x1={-6}
                  x2={-14}
                  y1={-11}
                  y2={-11}
                  stroke="var(--hairline)"
                />
                <text
                  y={-8}
                  x={-16}
                  className="rpt-tl-death-label"
                  textAnchor="end"
                >
                  {d.name.split("-")[0]} {relSec(d.t)}s
                </text>
              </g>
            ) : (
              <text y={-8} className="rpt-tl-death-label" textAnchor="middle">
                {d.name.split("-")[0]} {relSec(d.t)}s
              </text>
            )}
            <title>{`${d.name} 死亡 @ ${relSec(d.t)}s${onDeathClick ? " — 点击看死亡回顾" : ""}`}</title>
          </g>
        ))}
        {/* 失误 ⚠ 标记(第四阶段③):顶部小三角,按严重度着色;
            间距 <8px 的连续组并为 ⚠N(P1-4),title 列出各条,点击跳组内第一条 */}
        {markGroups.map((g, i) =>
          g.items.length === 1 ? (
            <text
              key={`mk${i}`}
              x={g.x}
              y={PAD.t - 6}
              textAnchor="middle"
              className={`rpt-tl-mistake rpt-tl-mistake-${g.items[0]!.severity}`}
              data-testid="tl-mistake"
              onClick={
                onMarkClick ? () => onMarkClick(g.items[0]!.tS) : undefined
              }
              style={{ cursor: onMarkClick ? "pointer" : undefined }}
            >
              ⚠<title>{g.items[0]!.label}</title>
            </text>
          ) : (
            <g
              key={`mk${i}`}
              data-testid="tl-mistake"
              className={`rpt-tl-mistake rpt-tl-mistake-${worstSev(g.items)}`}
              onClick={
                onMarkClick ? () => onMarkClick(g.items[0]!.tS) : undefined
              }
              style={{ cursor: onMarkClick ? "pointer" : undefined }}
            >
              <rect
                x={g.x - 10}
                y={PAD.t - 15}
                width={20 + (g.items.length > 9 ? 5 : 0)}
                height={11}
                rx={3}
                className="rpt-tl-mistake-plate"
              />
              <text x={g.x} y={PAD.t - 6} textAnchor="middle">
                ⚠{g.items.length}
              </text>
              <title>{g.items.map((m) => m.label).join("\n")}</title>
            </g>
          ),
        )}
        {/* 回放光标投影(1c):accent 虚线 + 时间标签 */}
        {cursorT != null && cursorT >= data.start && cursorT <= data.end && (
          <g className="rpt-tl-replay-cursor" data-testid="tl-replay-cursor">
            <line
              x1={x(cursorT)}
              x2={x(cursorT)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--accent)"
              strokeDasharray="3 3"
            />
            <text
              x={x(cursorT) + 4}
              y={PAD.t + 9}
              className="rpt-tl-axis"
              fill="var(--accent)"
            >
              回放 {relSec(cursorT)}s
            </text>
          </g>
        )}
        {cursor !== null && cursor >= PAD.l && cursor <= W - PAD.r ? (
          <g>
            <line
              x1={cursor}
              x2={cursor}
              y1={PAD.t - 12}
              y2={H - PAD.b}
              className="rpt-tl-cursor"
            />
            <text x={cursor + 4} y={PAD.t - 4} className="rpt-tl-axis">
              {relSec(x.invert(cursor))}s
            </text>
          </g>
        ) : null}
      </svg>
      {/* 图例(P1-4):点击 = 同曲线 toggle;隐藏中的系列降透明度 */}
      <div className="rpt-tl-legend" data-testid="tl-legend">
        {data.series.map((s) => (
          <button
            key={s.unitId}
            className={
              hidden?.has(s.unitId)
                ? "rpt-tl-legend-item off"
                : "rpt-tl-legend-item"
            }
            onClick={() => onSelectUnit?.(s.unitId)}
          >
            <span
              className="rpt-tl-legend-swatch"
              style={{ background: classColor(s.classId) }}
            />
            {s.name.split("-")[0]}
          </button>
        ))}
      </div>
    </div>
  );
}
