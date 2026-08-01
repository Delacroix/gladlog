import type { ReportSource } from "./types";

export interface HpPoint {
  t: number;
  hp: number;
  maxHp: number;
}
export interface DeathMark {
  t: number;
  unitId: string;
  name: string;
}
export interface TimelineData {
  start: number;
  end: number;
  hasAdvanced: boolean;
  series: {
    unitId: string;
    name: string;
    classId: number;
    teamId: number;
    points: HpPoint[];
  }[];
  deaths: DeathMark[];
}

/** 降采样桶数 ≈ Timeline.tsx 曲线绘制区宽(1200 viewBox px − 左右 PAD)。
 * advanced 采样 ~12 点/秒,长局单条曲线 2000+ 点画进 ~1160px,>2 点/px 的部分
 * 对 2px 描边曲线不可见,却让 mousemove 重渲每次重建几百 KB 的 path 字符串。 */
const TIMELINE_BUCKETS = 1160;

/** 每时间桶保 HP 比值 min/max 两点(按时间序),首末点恒保留 ——
 * 掉血尖刺和满血平台都不会被抹掉;≤2×桶数的序列原样返回(短局零变化)。 */
function downsampleMinMax(pts: HpPoint[], buckets: number): HpPoint[] {
  if (pts.length <= buckets * 2) return pts;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const span = last.t - first.t;
  if (span <= 0) return [first, last];
  const ratio = (p: HpPoint) => (p.maxHp > 0 ? p.hp / p.maxHp : 0);
  const out: HpPoint[] = [first];
  let bucket = 0;
  let lo: HpPoint | null = null;
  let hi: HpPoint | null = null;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo === hi) out.push(lo);
    else if (lo.t <= hi.t) out.push(lo, hi);
    else out.push(hi, lo);
    lo = hi = null;
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const b = Math.min(
      buckets - 1,
      Math.floor(((p.t - first.t) / span) * buckets),
    );
    if (b !== bucket) {
      flush();
      bucket = b;
    }
    if (!lo || ratio(p) < ratio(lo)) lo = p;
    if (!hi || ratio(p) >= ratio(hi)) hi = p;
  }
  flush();
  out.push(last);
  return out;
}

export function deriveTimeline(m: ReportSource): TimelineData {
  const players = Object.values(m.units).filter(
    (u) => u.kind === "Player" && u.info,
  );
  const allPlayers = Object.values(m.units).filter((u) => u.kind === "Player");
  const series = !m.hasAdvancedLogging
    ? []
    : players
        .map((u) => ({
          unitId: u.id,
          name: u.name,
          classId: u.classId,
          teamId: u.info!.teamId,
          points: downsampleMinMax(
            [...u.advancedSamples]
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((s) => ({ t: s.timestamp, hp: s.hp, maxHp: s.maxHp })),
            TIMELINE_BUCKETS,
          ),
        }))
        .filter((s) => s.points.length > 0)
        .sort((a, b) => a.teamId - b.teamId || a.name.localeCompare(b.name));
  const deaths: DeathMark[] = allPlayers
    .flatMap((u) =>
      u.deaths
        .filter((d) => !d.unconscious)
        .map((d) => ({ t: d.timestamp, unitId: u.id, name: u.name })),
    )
    .sort((a, b) => a.t - b.t);
  return {
    start: m.startTime,
    end: m.endTime,
    hasAdvanced: m.hasAdvancedLogging,
    series,
    deaths,
  };
}
