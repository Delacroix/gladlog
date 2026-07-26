/**
 * 跨对局学习服务(spec §3/§5):台账 → patternScan 确定性筛 → AI 提炼
 * (占位符纪律审计)→ rules.json。整合的确定性部分(stats/status)**总是**
 * 落盘;AI 文本失败只影响 description/advice,下轮懒补 —— 学习状态永不
 * 因模型抽风而回滚。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import { parseModelJsonArray } from "@gladlog/analysis/src/analysis/parseModelJson";
import type {
  CandidateEvent,
  Finding,
} from "@gladlog/analysis/src/analysis/types";
import {
  auditDistilledRules,
  buildDistillPrompt,
} from "@gladlog/analysis/src/learning/distillRules";
import {
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  scanPatterns,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LearnedRule,
  LedgerRun,
  RulesDoc,
  StablePattern,
} from "@gladlog/analysis/src/learning/types";
import { resolveAiModel, type AiModelSelection } from "../shared/aiModels";
import { recordAiDebug } from "./aiDebugLog";
import {
  buildCoachSystemPrompt,
  PROMPT_VERSION,
  resolveAiClient,
  type AiBackend,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";
import { createLearningLedger } from "./learningLedger";

/** 台账较上次整合新增 ≥ 此数即自动整合(spec §5)。 */
export const CONSOLIDATE_EVERY_MATCHES = 10;

export interface LearningState {
  backfill: { running: boolean; scanned: number; total: number } | null;
  consolidating: boolean;
  ledgerMatches: number;
  badLines: number;
  lastConsolidatedAt: number | null;
}

export function createLearningService(deps: {
  getSettings: () => {
    anthropicApiKey: string | null;
    aiModels?: AiModelSelection | null;
    wowDirectory: string | null;
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiLanguage?: AiLanguage;
  };
  clientFactory?: (key: string) => AnthropicLike;
  matchesDir: string;
  learningDir: string;
  emit: (channel: string, payload: unknown) => void;
}) {
  const ledger = createLearningLedger(deps.learningDir);
  const rulesPath = join(deps.learningDir, "rules.json");
  const backfillMarker = join(deps.learningDir, "backfill-done.json");

  let consolidating = false;
  let backfill: { running: boolean; scanned: number; total: number } | null =
    null;

  const readRulesDoc = (): RulesDoc | null => {
    try {
      const doc = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDoc;
      return doc.schemaVersion === 1 ? doc : null;
    } catch {
      return null;
    }
  };
  const writeRulesDoc = (doc: RulesDoc): void => {
    mkdirSync(deps.learningDir, { recursive: true });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf-8");
    renameSync(tmp, rulesPath);
  };

  /** 从 meta.json + findings/candidates 铸台账行。meta 缺失时返回 null
   * (没有 startTime 就无法进窗口排序,宁缺勿错)。 */
  const buildRun = (
    matchId: string,
    findings: Array<Pick<Finding, "category" | "severity" | "eventIds">>,
    typeOf: (eventId: string) => string | undefined,
    createdAt: number,
    promptVersion: number,
  ): LedgerRun | null => {
    let meta: {
      id?: string;
      startTime?: number;
      result?: string;
      zoneId?: string;
      bracket?: string;
      teams?: Array<Array<{ specId: number }>>;
    };
    try {
      meta = JSON.parse(
        readFileSync(join(deps.matchesDir, matchId, "meta.json"), "utf-8"),
      );
    } catch {
      return null;
    }
    if (typeof meta.startTime !== "number") return null;
    return {
      v: 1,
      matchId: meta.id ?? matchId,
      startTime: meta.startTime,
      win: String(meta.result ?? "")
        .toLowerCase()
        .startsWith("win"),
      zoneId: meta.zoneId,
      bracket: meta.bracket,
      enemySpecs: (meta.teams?.[1] ?? [])
        .map((t) => t.specId)
        .filter((s) => typeof s === "number" && s > 0),
      promptVersion,
      createdAt,
      findings: findings.map((f) => ({
        category: normalizeFindingCategory(f.category),
        severity: f.severity,
        eventTypes: [
          ...new Set(
            (f.eventIds ?? []).map(typeOf).filter((t): t is string => !!t),
          ),
        ].sort(),
      })),
    };
  };

  const maybeAutoConsolidate = (): void => {
    const { matches } = ledger.read();
    const prev = readRulesDoc();
    const due = prev
      ? matches.length - prev.ledgerMatches >= CONSOLIDATE_EVERY_MATCHES
      : matches.length >= PATTERN_MIN_HITS && existsSync(backfillMarker);
    if (due) void consolidate();
  };

  /** 提炼实例:从证据场的 analysis 缓存捞该 category 的解释文本(≤3 条)。 */
  const collectExamples = (
    rules: LearnedRule[],
    lang: AiLanguage,
  ): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const r of rules) {
      const texts: string[] = [];
      for (const matchId of r.evidence) {
        if (texts.length >= 3) break;
        const base = join(deps.matchesDir, matchId);
        const file = [
          `analysis-v2.${lang}.json`,
          `analysis-v2.${lang === "zh" ? "en" : "zh"}.json`,
          "analysis-v2.json",
        ].find((f) => existsSync(join(base, f)));
        if (!file) continue;
        try {
          const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
          const findings: Array<{ category: string; explanation?: string }> =
            doc.result?.findings ?? [];
          for (const f of findings) {
            if (texts.length >= 3) break;
            if (
              normalizeFindingCategory(f.category) === r.category &&
              f.explanation
            )
              texts.push(f.explanation);
          }
        } catch {
          /* 坏缓存跳过:实例是锦上添花,不是硬依赖 */
        }
      }
      out[r.ruleId] = texts;
    }
    return out;
  };

  async function consolidate(): Promise<void> {
    if (consolidating) return;
    consolidating = true;
    try {
      const { matches } = ledger.read();
      const patterns = scanPatterns(matches);
      const prev = readRulesDoc();
      const byId = new Map<string, LearnedRule>(
        (prev?.rules ?? []).map((r) => [r.ruleId, r]),
      );
      for (const p of patterns) {
        if (!byId.has(p.patternId))
          byId.set(p.patternId, {
            ruleId: p.patternId,
            status: "active",
            category: p.category,
            eventTypes: p.eventTypes,
            condition: p.condition,
            stats: {
              windowMatches: p.windowMatches,
              hits: p.hits,
              firstSeen: p.firstSeen,
              lastSeen: p.lastSeen,
              trend: p.trend,
            },
            description: {},
            advice: {},
            evidence: p.exampleMatchIds,
            distilledAt: 0,
            distillModel: "",
          });
      }
      // 确定性部分:全部规则(含旧规则)按当前台账重算 stats + 退役/复活
      for (const r of byId.values()) {
        const g = measureGroup(matches, r.category, r.eventTypes, r.condition);
        r.stats = {
          windowMatches: g.windowMatches,
          hits: g.hits,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          trend: g.trend,
        };
        r.evidence = g.exampleMatchIds.length ? g.exampleMatchIds : r.evidence;
        r.status = nextRuleStatus(r.status, g.hits);
      }
      const rules = [...byId.values()].sort(
        (a, b) => b.stats.hits - a.stats.hits,
      );

      // AI 提炼:active 且缺当前语言文本的规则(语言切换懒重译走同一条路)。
      // 隔离在自己的 try/catch 里 —— client.stream() 可能抛(401/429/超时),
      // 但确定性部分(上面的 stats/status 重算)已经算完,决不能因为 AI
      // 抽风被拖进外层 catch 而整轮不落盘(spec 核心不变式)。
      const settings = deps.getSettings();
      const lang: AiLanguage = settings.aiLanguage ?? "zh";
      const need = rules.filter(
        (r) => r.status === "active" && !r.description[lang],
      );
      let distilled = 0;
      let droppedByAudit = 0;
      let distillError: string | undefined;
      try {
        const client = resolveAiClient(settings, deps.clientFactory);
        if (need.length > 0 && client) {
          const pats: StablePattern[] = need.map((r) => ({
            patternId: r.ruleId,
            category: r.category,
            eventTypes: r.eventTypes,
            condition: r.condition,
            windowMatches: r.stats.windowMatches,
            hits: r.stats.hits,
            firstSeen: r.stats.firstSeen,
            lastSeen: r.stats.lastSeen,
            trend: r.stats.trend,
            exampleMatchIds: r.evidence,
          }));
          const prompt = buildDistillPrompt(
            pats,
            collectExamples(need, lang),
            lang,
          );
          let raw = "";
          const stream = client.stream({
            model: resolveAiModel(settings),
            max_tokens: 4096,
            system: buildCoachSystemPrompt(lang),
            messages: [{ role: "user", content: prompt }],
          });
          for await (const ev of stream) if (ev.delta) raw += ev.delta;
          recordAiDebug({
            kind: "analysis",
            matchId: "learning#consolidate",
            at: Date.now(),
            model: resolveAiModel(settings),
            prompt,
            raw,
          });
          const audit = auditDistilledRules(parseModelJsonArray(raw), pats);
          droppedByAudit = audit.dropped.length;
          for (const t of audit.texts) {
            const r = byId.get(t.patternId)!;
            r.description[lang] = t.description;
            r.advice[lang] = t.advice;
            r.distilledAt = Date.now();
            r.distillModel = resolveAiModel(settings);
            distilled++;
          }
        }
      } catch (err) {
        // 提炼失败只缺文本:规则仍在,stats/status 已经是最新的,下轮整合
        // 懒补 description/advice。
        distillError = err instanceof Error ? err.message : String(err);
      }

      writeRulesDoc({
        schemaVersion: 1,
        updatedAt: Date.now(),
        ledgerMatches: matches.length,
        rules,
      });
      ledger.compact();
      deps.emit("gladlog:learning:done", {
        rules: rules.length,
        distilled,
        dropped: droppedByAudit,
        ...(distillError ? { distillError } : {}),
      });
    } catch (err) {
      deps.emit("gladlog:learning:error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      consolidating = false;
    }
  }

  /** 回填(spec §1):扫全部 analysis-v2 缓存进台账。与 aggregate() 关键
   * 差异:**不看 promptVersion** —— 旧版本场也是学习记忆。 */
  async function runBackfill(): Promise<void> {
    const { readdirSync } = await import("fs");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(deps.matchesDir).filter(
        (d) => !d.startsWith(".") && !d.startsWith("_"),
      );
    } catch {
      dirs = [];
    }
    backfill = { running: true, scanned: 0, total: dirs.length };
    let batch: LedgerRun[] = [];
    for (const dir of dirs) {
      backfill.scanned++;
      const base = join(deps.matchesDir, dir);
      const file = [
        "analysis-v2.zh.json",
        "analysis-v2.en.json",
        "analysis-v2.json",
      ].find((f) => existsSync(join(base, f)));
      if (!file) continue;
      try {
        const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
        const findings: Array<
          Pick<Finding, "category" | "severity" | "eventIds">
        > = doc.result?.findings ?? [];
        // 回填没有 candidates → eventTypes 全 [](type 级模式从 live 数据累积)
        const run = buildRun(
          dir,
          findings,
          () => undefined,
          doc.createdAt ?? 0,
          doc.promptVersion ?? 0,
        );
        if (run) batch.push(run);
      } catch {
        /* 坏缓存跳过 */
      }
      if (batch.length >= 50) {
        ledger.append(batch);
        batch = [];
        deps.emit("gladlog:learning:progress", {
          scanned: backfill.scanned,
          total: backfill.total,
        });
        // 让位其它 IPC(与 App 后台补载同思路)
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    ledger.append(batch);
    writeFileSync(
      backfillMarker,
      JSON.stringify({ at: Date.now(), scanned: backfill.scanned }),
      "utf-8",
    );
    backfill = { ...backfill, running: false };
    deps.emit("gladlog:learning:progress", {
      scanned: backfill.scanned,
      total: backfill.total,
    });
    maybeAutoConsolidate(); // 回填完成 → 首次整合
  }

  return {
    init(): void {
      if (!existsSync(backfillMarker)) {
        mkdirSync(deps.learningDir, { recursive: true });
        void runBackfill().catch((err) =>
          deps.emit("gladlog:learning:error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    /** analysis 写入点(spec §1):初轮 run 落盘后调用。失败静默 ——
     * 台账写不进不能影响分析主流程。 */
    recordAnalysis(e: {
      matchId: string;
      findings: Finding[];
      candidates: CandidateEvent[];
    }): void {
      try {
        const byId = new Map(e.candidates.map((c) => [c.id, c.type]));
        const run = buildRun(
          e.matchId,
          e.findings,
          (id) => byId.get(id),
          Date.now(),
          PROMPT_VERSION,
        );
        if (!run) return;
        ledger.append([run]);
        maybeAutoConsolidate();
      } catch {
        /* best-effort */
      }
    },
    consolidate,
    async getRules(): Promise<RulesDoc | null> {
      return readRulesDoc();
    },
    async getState(): Promise<LearningState> {
      const { matches, badLines } = ledger.read();
      return {
        backfill,
        consolidating,
        ledgerMatches: matches.length,
        badLines,
        lastConsolidatedAt: readRulesDoc()?.updatedAt ?? null,
      };
    },
  };
}
export type LearningService = ReturnType<typeof createLearningService>;
