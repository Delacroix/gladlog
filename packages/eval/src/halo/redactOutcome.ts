/**
 * redactOutcome.ts — 子项目 B(判官赛果光环实验)的涂抹变换。
 *
 * 最小干预:只把 MATCH SUMMARY 头行的 `Result: Win|Loss` 改写为
 * `Result: Unknown`,其余字节不变。头行由 buildMatchContext.ts:802 渲染,
 * 这里重新解析渲染文本 —— 格式漂移、标签数不为 1、或语料出现其他显式赛果
 * 措辞时一律 throw,宁可炸掉让人重新审视,不做静默降级。
 * 设计与判读规则:docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md
 */

const RESULT_LABEL_RE = /\bResult: (Win|Loss|Unknown|Draw)\b/g;
const OUTCOME_WORDING_RE =
  /\b(victory|victorious|we won|we lost|defeat(?:ed)?|winning team|losing team)\b/i;

export interface RedactedPrompt {
  text: string;
  result: "Win" | "Loss";
}

export function redactOutcomeLabels(promptText: string): RedactedPrompt {
  const labels = [...promptText.matchAll(RESULT_LABEL_RE)];
  if (labels.length !== 1)
    throw new Error(
      `redactOutcomeLabels: expected exactly 1 "Result:" label, found ${labels.length}`,
    );
  const value = labels[0][1];
  if (value !== "Win" && value !== "Loss")
    throw new Error(
      `redactOutcomeLabels: unusable Result value "${value}" (need Win|Loss)`,
    );
  if (OUTCOME_WORDING_RE.test(promptText))
    throw new Error(
      "redactOutcomeLabels: prompt contains explicit outcome wording beyond the Result: label — minimal redaction no longer holds, review the corpus",
    );
  const m = labels[0];
  const text =
    promptText.slice(0, m.index!) +
    "Result: Unknown" +
    promptText.slice(m.index! + m[0].length);
  return { text, result: value };
}
