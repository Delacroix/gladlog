/**
 * 诊断 code → 展示等级(开发者页诊断区的徽标筛选)。
 *
 * `DiagnosticEntry`(preload/api.ts)只有 code/detail/fileKey,没有 level;
 * 定级只能靠 code。这里是**白名单**:表外的 code 一律 error —— 上游新增一个
 * 真错误却忘了登记时,后果是「多吵一次」而不是「被藏进 warn 里没人看见」。
 *
 * 上游 code 的两处来源:
 * - `packages/parser/src/invariants.ts`(kebab-case,数据不变量违反 = warn)
 * - `packages/parser/src/api.ts` / `src/worker/runtime.ts`(UPPER_SNAKE,流程失败 = error)
 *
 * `test/diagnosticLevel.test.ts` 会读 invariants.ts 的字面量与本表对账,
 * 上游改名/新增而这里没跟会打红 CI。
 */

export type DiagnosticLevel = "warn" | "error";

export const DIAGNOSTIC_LEVEL: Record<string, DiagnosticLevel> = {
  // ── parser 不变量(数据有瑕疵,对局仍可用)──
  "start-before-end": "warn",
  monotonic: "warn",
  "time-bounds": "warn",
  "hp-range": "warn",
  "pet-owner-resolves": "warn",
  "line-resolves": "warn",
  "death-has-damage": "warn",
  // ── 流程性失败 ──
  BUILD_FAILED: "error",
  LOGS_DIR_UNREADABLE: "error",
};

export function diagnosticLevel(code: string): DiagnosticLevel {
  return DIAGNOSTIC_LEVEL[code] ?? "error";
}
