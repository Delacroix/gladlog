import { scaleLinear } from "d3-scale";
import { useMemo, useState } from "react";

import { classColor } from "../data/gameConstants";
import type { ExposureMark, PressureBand } from "../derive/pressureLanes";
import type { TimelineData } from "../derive/timeline";
import type { TimeRange } from "../derive/timeRange";
import type { VulnBand } from "../derive/vulnWindows";

/** A drag must span at least this many viewBox pixels to count as a window
 * selection; anything shorter is treated as a plain click (the onClick of
 * bands / curves / death markers is unaffected). */
const DRAG_MIN_PX = 8;

// UI redesign 1a: with two columns the left column is ~1100-1500px, and the
// viewBox scales proportionally, which decides the real height — 800×240
// (10:3) would blow up to 450px tall in a wide column; 1200×240 (5:1) makes a
// 1100px column land at ~220px (the number in the design). TIMELINE_BUCKETS
// (derive/timeline.ts) is kept at 1160 to preserve the invariant
// "bucket count ≈ plot-area width".
const W = 1200,
  H = 240,
  PAD = { l: 34, r: 8, t: 18, b: 18 };
/** Height of the pressure lane (#4): a thin strip drawn along the bottom edge
 * inside the plot area — H is unchanged and the curves are not squeezed. */
const LANE_H = 8;
/** Lane spacing (#10 T2): the gap where the dampening lane sits directly above
 * the pressure lane. */
const LANE_GAP = 2;

/**
 * Smooth path via Catmull-Rom → cubic Bézier: connecting the per-second HP
 * samples with straight segments looks far too harsh. Control-point y values
 * are clamped inside the plot area so overshoot at a sharp drop or spike
 * cannot draw the illusion of >100% or <0%.
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
  // Endpoint y values are clamped too (logging jitter can yield ratios >100%
  // or <0%, and clamping only the control points would leave a kink at the
  // boundary); control-point x is clamped inside its segment so non-uniform
  // sampling cannot make the time axis bend backwards.
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
  /** Set of hidden unitIds: these players' HP curves / death markers are not
   * drawn. */
  hidden?: Set<string>;
  /** Clicking a death marker opens the death review (backlog #6). t is
   * absolute ms. */
  onDeathClick?: (unitId: string, t: number) => void;
  /** KILL WINDOW / VULNERABLE background bands (relative seconds); a click
   * replays that instant. */
  bands?: VulnBand[];
  onBandClick?: (tSeconds: number) => void;
  /** Replay cursor projection (1c): the last instant when switching back from
   * the replay (absolute ms). */
  cursorT?: number | null;
  /** Time-window linkage ①: the current window (relative seconds), drawn as a
   * highlighted selection; the curves always cover the whole match. */
  range?: TimeRange | null;
  /** Drag on the chart to commit a window (relative seconds). */
  onRangeSelect?: (fromS: number, toS: number) => void;
  /** Mistake markers (phase four ③): ⚠ along the top, click to jump into the
   * replay. */
  marks?: Array<{ tS: number; label: string; severity: string }>;
  onMarkClick?: (tS: number) => void;
  /** Pressure lane (#4): spikes as a thin strip at the bottom (click to set
   * the time window) plus exposure diamond markers. */
  pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] };
  /** Dampening lane (#10 T2): a dense per-second 0-100 percentage series drawn
   * as its own thin strip directly above the pressure lane, with opacity
   * mapped from pct/100. */
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
  // The `d` string of each path is the most expensive product of this whole
  // component (hundreds to thousands of Bézier segments per curve). The
  // cursor/dragFrom setState on mousemove re-renders dozens of times per
  // second, so `d` must be memoized along the data dimension — otherwise
  // sweeping across the chart rebuilds every curve string and makes the
  // browser re-parse every path, every frame.
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
    // x/y are rebuilt on every render but are fully determined by data, so the
    // deps are anchored on [series, data]
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, data],
  );
  const relSec = (t: number) => ((t - data.start) / 1000).toFixed(1);

  // Dampening lane (#10 T2): the dense per-second series is first merged into
  // runs of equal pct (RLE) — otherwise one rect per second means hundreds of
  // <rect>s in a long match, all visually identical blocks of colour.
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

  // ⚠ clustering (P1-4): sort by x projection and merge each run of markers
  // less than 8px apart into a single ⚠N
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
  // Death-label avoidance (P1-4): if it is within 40px in x of any ⚠ group or
  // of a neighbouring death label → anchor left and draw a leader line
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
        {/* Dampening lane (#10 T2): its own thin strip directly above the
            pressure lane, more opaque as pct rises; runs merged by RLE, with
            the percentage in the hover title. A pct===0 run would have
            opacity=0 — completely invisible and non-interactive — so it is
            skipped and no rect is drawn. */}
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
        {/* Pressure lane (#4): spikes as a thin strip at the bottom (click to
            set the time window) plus exposure diamond markers. Drawn after the
            bands and before the curves — being overlapped by a curve is fine,
            the blocks are semi-transparent. */}
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
              width={Math.max(3, x2 - x1) /* min width, as bands do */}
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
        {/* Time-window selection (①): the committed window highlighted, plus
            a live preview while dragging */}
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
        {/* Death markers (1c): a dot + ✕ with a name·time label above */}
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
        {/* Mistake ⚠ markers (phase four ③): small triangles along the top,
            coloured by severity; runs less than 8px apart merge into ⚠N
            (P1-4), the title lists each entry, and a click jumps to the first
            one in the group */}
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
        {/* Replay cursor projection (1c): accent dashed line + time label */}
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
      {/* Legend (P1-4): a click toggles the same series as its curve; hidden
          series are dimmed */}
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
