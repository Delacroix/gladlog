import type { IMatchArcPhase } from "@gladlog/analysis/src/context/matchNarrative";

const PHASE_ZH: Record<IMatchArcPhase["phase"], string> = {
  early: "早期",
  mid: "中期",
  late: "后期",
};

const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;

/**
 * 比赛节奏头部行(#10 T4)。消费 T1 `buildMatchArcStructured` 的结构化相位——
 * 纯渲染层,不重算相位边界。紧凑单行(横向滚动,不换行),转折点渲染为
 * 可点 button(跳回放,契约同 MatchReport 的 onSeek(tSeconds, unitNames))。
 */
export function MatchArcLine({
  phases,
  onSeek,
}: {
  phases: IMatchArcPhase[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  if (phases.length === 0) return null;
  return (
    <div className="rpt-arc-line" data-testid="match-arc-line">
      {phases.map((p, i) => (
        <span className="rpt-arc-phase" key={`${p.phase}-${p.fromS}`}>
          <span className="rpt-arc-phase-label">
            {PHASE_ZH[p.phase]} {mmss(p.fromS)}–{mmss(p.toS)}
          </span>
          <span className="rpt-arc-phase-prose"> · {p.prose}</span>
          {/* agy 复核:onSeek 缺席时不渲染成「看着能点、点了没反应」的死按钮——
              没有跳转能力就不装样子。 */}
          {p.turningPoint && onSeek && (
            <button
              type="button"
              className="rpt-arc-turning"
              aria-label={p.turningPoint.label}
              title={`跳到 ${mmss(p.turningPoint.tS)} 的回放 — ${p.turningPoint.label}`}
              onClick={() => onSeek(p.turningPoint!.tS, [])}
            >
              ⟶ {mmss(p.turningPoint.tS)}
            </button>
          )}
          {i < phases.length - 1 && <span className="rpt-arc-sep"> ｜ </span>}
        </span>
      ))}
    </div>
  );
}
