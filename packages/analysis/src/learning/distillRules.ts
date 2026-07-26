/**
 * AI 提炼(spec §3):稳定模式 → 规则文本。AI 只做「翻译成人话 + 归纳」,
 * 不允许发明事实 —— 审计沿用 findings 的占位符纪律:文本禁裸数字,唯二
 * 合法数字是 {{hits}}/{{windowMatches}},渲染时由代码从 stats 插值。
 */
import { claimChecker } from "../compare/claimChecker";
import { causalLint } from "../analysis/causalLint";
import type { StablePattern } from "./types";

export function distillFacts(p: {
  hits: number;
  windowMatches: number;
}): Record<string, string> {
  return { hits: String(p.hits), windowMatches: String(p.windowMatches) };
}

export function buildDistillPrompt(
  patterns: StablePattern[],
  examples: Record<string, string[]>,
  lang: "zh" | "en",
): string {
  const data = patterns.map((p) => ({
    patternId: p.patternId,
    category: p.category,
    eventTypes: p.eventTypes,
    condition: p.condition,
    hits: p.hits,
    windowMatches: p.windowMatches,
    exampleFindings: examples[p.patternId] ?? [],
  }));
  const language =
    lang === "zh"
      ? "Write description/advice in Simplified Chinese. Keep spell/ability names in English."
      : "Write description/advice in English.";
  return [
    "You are summarizing a player's RECURRING habits across many arena matches.",
    "Each pattern below was found by deterministic statistics over past AI findings.",
    "For EACH pattern, write a short description of the habit and one actionable training advice.",
    "",
    "PATTERNS (JSON):",
    JSON.stringify(data, null, 1),
    "",
    "HARD RULES:",
    '1. Output ONLY a JSON array: [{"patternId": "...", "description": "...", "advice": "..."}]. No prose, no markdown fence.',
    "2. patternId MUST be copied verbatim from the patterns above. Exactly one object per pattern.",
    "3. NEVER write a bare number. The ONLY numbers allowed are the literal placeholders {{hits}} and {{windowMatches}}.",
    "4. Ground every statement ONLY in the given stats and exampleFindings. Do not invent events, spells, or reasons.",
    '5. No causal certainty ("caused", "because you died"); use hedged phrasing ("tends to", "often coincides with").',
    `6. ${language}`,
  ].join("\n");
}

export function auditDistilledRules(
  parsed: unknown[] | null,
  patterns: StablePattern[],
): {
  texts: Array<{ patternId: string; description: string; advice: string }>;
  dropped: Array<{ patternId?: string; reason: string }>;
} {
  const texts: Array<{
    patternId: string;
    description: string;
    advice: string;
  }> = [];
  const dropped: Array<{ patternId?: string; reason: string }> = [];
  if (!Array.isArray(parsed)) return { texts, dropped };
  const byId = new Map(patterns.map((p) => [p.patternId, p]));
  const seen = new Set<string>();

  for (const item of parsed) {
    const o = item as {
      patternId?: unknown;
      description?: unknown;
      advice?: unknown;
    };
    if (
      typeof o?.patternId !== "string" ||
      typeof o?.description !== "string" ||
      typeof o?.advice !== "string"
    ) {
      dropped.push({ reason: "shape: missing patternId/description/advice" });
      continue;
    }
    const p = byId.get(o.patternId);
    if (!p) {
      dropped.push({ patternId: o.patternId, reason: "unknown patternId" });
      continue;
    }
    if (seen.has(o.patternId)) {
      dropped.push({ patternId: o.patternId, reason: "duplicate patternId" });
      continue;
    }
    const facts = distillFacts(p);
    const bad = ["description", "advice"]
      .map((field) => {
        const text = field === "description" ? o.description : o.advice;
        const check = claimChecker(text as string, facts);
        if (!check.ok)
          return `${field} numeric: ${check.violations.join("; ")}`;
        // auditFindings 同款加严:剥占位符与 2v2/3v3 后不许残留任何数字
        const prose = (text as string)
          .replace(/\{\{\s*[\w.]+\s*\}\}/g, " ")
          .replace(/\b\d+v\d+\b/gi, " ");
        if (/\d/.test(prose)) return `${field}: raw digit outside placeholder`;
        const causal = causalLint(text as string);
        if (causal.length > 0) return `${field} causal: ${causal.join("; ")}`;
        return null;
      })
      .filter((x): x is string => x !== null);
    if (bad.length > 0) {
      dropped.push({ patternId: o.patternId, reason: bad.join(" | ") });
      continue;
    }
    seen.add(o.patternId);
    texts.push({
      patternId: o.patternId,
      description: o.description,
      advice: o.advice,
    });
  }
  return { texts, dropped };
}
