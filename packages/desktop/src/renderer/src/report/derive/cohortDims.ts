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
  /** Direction-corrected 0-100 score (higher is better) = single-sourced from
   * metricScore. */
  score: number;
  verdict: string;
  verdictLabel: string;
  /** Render text for the verdict column (P3-1 single source: rendering and the
   * faithfulness gate both consume this one field).
   * zh = "Nth percentile · {above|below|at} this cohort's median" (unified
   * phrasing, no more bare decimals sitting next to an English verdict);
   * en keeps `value (Nth · verdict)`. */
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
    // The zh verdict is derived deterministically from the percentile
    // (analysis's verdict is a free-form string, and anything outside the
    // vocabulary leaks through as English sitting alongside — "bottom
    // quartile" was observed leaking); en keeps the original wording.
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
