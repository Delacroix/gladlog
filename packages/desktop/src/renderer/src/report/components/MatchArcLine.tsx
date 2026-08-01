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
 * 纯渲染层,不重算相位边界。紧凑单行(横向滚动,不换行):早期/中期/后期
 * pill + 转折点可点 button(跳回放,契约同 MatchReport 的
 * onSeek(tSeconds, unitNames))。
 *
 * 复核轮修复:`phase.prose` 是 `buildMatchArc` 喂给 LLM 的原句(纯英文),
 * 不在这里渲染——本产品 UI 全中文,而 prose 没有配套的 zh 版本,建一个
 * 翻译层是另起一套没人维护的谓词(违反门规谓词即规范)。`turningPoint.label`
 * 同理是英文(法术名/单位名,T1 结构化输出目前只暴露 {tS, label} 两个
 * 字段,没有可拼装出中文短句的结构化子字段)——按同一原则处理:按钮正文
 * 只显示时刻,中文 aria-label 描述「这是个转折点」,英文 label 只留在
 * title= 提示条(法术名保留英文是本应用既有惯例,提示条属于可接受位置)。
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
          {/* onSeek 缺席时不渲染成「看着能点、点了没反应」的死按钮——
              没有跳转能力就不装样子。 */}
          {p.turningPoint && onSeek && (
            <button
              type="button"
              className="rpt-arc-turning"
              aria-label={`跳转到转折点 ${mmss(p.turningPoint.tS)}`}
              title={p.turningPoint.label}
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
