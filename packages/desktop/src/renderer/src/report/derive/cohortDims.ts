import { metricLabel, metricScore, verdictLabel } from "@gladlog/analysis";

export interface CohortDim {
  key: string;
  value: number | null;
  p10: number;
  p50: number;
  p90: number;
  percentile: number;
  verdict: string;
}

export interface CohortDimRow {
  key: string;
  keyLabel: string;
  value: number | null;
  valueLabel: string;
  percentile: number;
  percentileLabel: string;
  /** 方向修正后的 0-100 评分(越高越好)= metricScore 单源。 */
  score: number;
  verdict: string;
  verdictLabel: string;
  /** 判定列渲染文本(P3-1 单源:渲染与 faithfulness 门规共吃这一个字段)。
   * zh = `第 N 百分位 · {高于|低于|处于}本分档中位`(话术统一,不再有
   * 裸小数与英文 verdict 并排);en 保持 `value (Nth · verdict)`。 */
  displayLabel: string;
  p10: number;
  p50: number;
  p90: number;
}

export function cohortDims(
  dims: CohortDim[],
  lang: "en" | "zh" = "en",
): CohortDimRow[] {
  return dims.map((d) => {
    const valueLabel = d.value !== null ? String(d.value) : "N/A";
    const percentileLabel =
      lang === "zh" ? `第 ${d.percentile} 百分位` : `${d.percentile}th`;
    // zh 判定从 percentile 确定性推导(analysis 的 verdict 是自由 string,
    // 词表外的会漏成英文并排 —— bottom quartile 实测漏过);en 保持原词。
    const vLabel =
      lang === "zh"
        ? d.percentile > 50
          ? "高于本分档中位"
          : d.percentile < 50
            ? "低于本分档中位"
            : "处于本分档中位"
        : verdictLabel(d.verdict, lang);
    return {
      key: d.key,
      keyLabel: metricLabel(d.key, lang),
      value: d.value,
      valueLabel,
      percentile: d.percentile,
      percentileLabel,
      score: metricScore(d.key, d.percentile),
      verdict: d.verdict,
      verdictLabel: vLabel,
      displayLabel:
        lang === "zh"
          ? `${percentileLabel} · ${vLabel}`
          : `${valueLabel} (${percentileLabel} · ${vLabel})`,
      p10: d.p10,
      p50: d.p50,
      p90: d.p90,
    };
  });
}
