import { claimChecker, interpolate } from "../compare/claimChecker";
import { causalLint } from "./causalLint";
import { normalizeFindingCategory } from "./findingCategories";
import { repairSpellNameZh } from "./spellNameZhLint";
import type { AuditResult, CandidateEvent, Finding, RawFinding } from "./types";

/** 严重度排序单源(high > med > low):审计排序与深挖选择共用。 */
export const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  med: 1,
  low: 2,
};
const RANK = SEVERITY_RANK;

export function auditFindings(
  raw: RawFinding[],
  candidates: CandidateEvent[],
): AuditResult {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  const dropped: AuditResult["dropped"] = [];

  for (const f of raw) {
    // Layer 1: grounding — the finding must anchor to >=1 event, and every
    // eventId must resolve. (Empty eventIds is unanchored → drop.)
    const refs = f.eventIds.map((id) => byId.get(id));
    if (f.eventIds.length === 0 || refs.some((r) => !r)) {
      dropped.push({
        finding: f,
        reason: "grounding: unanchored / unknown eventId",
      });
      continue;
    }
    // Facts the explanation may cite = the union of the referenced events' facts.
    // If two referenced events share a fact key with DIFFERING values (e.g. two
    // deaths, each with its own t), that placeholder is ambiguous — a last-write
    // merge would silently mis-attribute. 2026-07-24 精化:只有当解释**实际
    // 使用**了冲突键才丢 —— 旧规则只要冲突键存在就整条丢,把 prompt 明确
    // 鼓励的多事件链条(death+setup、多次漏解)一并误杀(smoke 实测 3/7 条
    // 死于此)。防误归因性质不变:任何被渲染的占位符仍必须唯一解析。
    const facts: Record<string, string> = {};
    const colliding = new Set<string>();
    for (const r of refs as CandidateEvent[])
      for (const [k, v] of Object.entries(r.facts)) {
        if (k in facts && facts[k] !== v) colliding.add(k);
        facts[k] = v;
      }
    // 带序号变体({{t1}}/{{t2}},按 eventIds 顺序):多事件 finding 引用
    // 各自时刻的**唯一合法写法**。没有它,模型写 {{t}} 必被丢 —— 2026-07-25
    // 生产复现:中文回复 5 条里 3 条死于此,用户只看到 2 条。给**全部**键
    // 生成(不只冲突键):模型看不见冲突集,只给冲突键会让 {{duration1}}
    // (两值恰好相同)与单事件的 {{deathT1}} 解析不到反被误丢(smoke 实锤)。
    // 先建变体再并裸键,skip-if-present 防真名恰好带尾数字的键被踩。
    (refs as CandidateEvent[]).forEach((r, i) => {
      for (const [k, v] of Object.entries(r.facts)) {
        const indexed = `${k}${i + 1}`;
        if (!(indexed in facts)) facts[indexed] = v;
      }
    });
    const usedKeys = [
      ...f.explanation.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g),
    ].map((m) => m[1]!);
    const ambiguous = usedKeys.filter((k) => colliding.has(k));
    if (ambiguous.length > 0) {
      dropped.push({
        finding: f,
        reason: `ambiguous: placeholder(s) ${ambiguous.join(",")} collide across referenced events`,
      });
      continue;
    }
    // Layer 2: numeric. claimChecker validates {{key}} resolution + flags raw
    // decimals/percentages. But analysis fabrication is integer-heavy (times,
    // damage, "90k"), and the shared checker allows bare integers — unsafe here.
    // So additionally forbid ANY raw digit outside a placeholder: the prompt
    // mandates every number be a {{placeholder}}, so a bare digit = fabrication
    // or a disobeyed instruction. (Do not fork the shared checker; add the
    // stricter rule at the audit layer.)
    const check = claimChecker(f.explanation, facts);
    if (!check.ok) {
      dropped.push({
        finding: f,
        reason: `numeric: ${check.violations.join("; ")}`,
      });
      continue;
    }
    // Strip placeholders, then bracket/format terms (1v1, 2v2, 3v3 — never a
    // fabricated stat), then flag any remaining raw digit.
    // 剥除用与 claimChecker 同款的**严格**模式:宽松的 [^}]* 会把
    // {{t-1}} 这类非法占位符也剥掉 —— 它过不了 interpolate,会原样渲染进
    // UI;严格模式下它留在文本里,内含数字 → 按裸数字丢弃(agy 复核 F3)。
    const prose = f.explanation
      .replace(/\{\{\s*[\w.]+\s*\}\}/g, " ")
      .replace(/\b\d+v\d+\b/gi, " ");
    if (/\d/.test(prose)) {
      dropped.push({
        finding: f,
        reason: "numeric: raw digit outside placeholder",
      });
      continue;
    }
    // Layer 3: causal-language lint.
    const causal = causalLint(f.explanation);
    if (causal.length > 0) {
      dropped.push({ finding: f, reason: `causal: ${causal.join("; ")}` });
      continue;
    }
    // Layer 4: zh spell-name auto-repair. Unlike causalLint (drop-on-hit),
    // a translated ability name is deterministically fixable 1:1 — dropping
    // the whole finding over one mistranslated name is too destructive, and
    // repairing also restores #15 inline-icon matching (English-name-only
    // scanner) that the untranslated text would otherwise silently miss.
    const { text: repairedExplanation, repairs } = repairSpellNameZh(
      f.explanation,
    );
    if (repairs.length > 0) {
      console.warn(
        `[spellNameZhLint] auditFindings repaired ${repairs.map((r) => `${r.zhName}→${r.enName}`).join(", ")}`,
      );
    }
    findings.push({
      ...f,
      // category 归一(枚举/别名 → slug,词表外原样):聚合键与 findingKey
      // 的稳定性在这里定型,渲染侧只做本地化显示
      category: normalizeFindingCategory(f.category),
      explanation: interpolate(repairedExplanation, facts),
    });
  }

  findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
  return { findings, dropped };
}
