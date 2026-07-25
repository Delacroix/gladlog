import { getEnglishSpellName } from "@gladlog/analysis";

/** 渲染层技能名单源(P2-1):默认原样返回日志名(与 GCD 泳道/榜单明细同口径,
 * CN 日志全站中文、EN 日志全站英文);日志名缺失(如从未施放、只有 id 的技能)
 * 才落英文词典名兜底。analysis 侧(prompt/审计)不走这里。 */
export function displaySpellName(
  spellId: string | null | undefined,
  logName: string | null | undefined,
): string {
  return logName || getEnglishSpellName(spellId ?? "", null);
}
