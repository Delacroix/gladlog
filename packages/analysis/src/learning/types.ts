/**
 * 跨对局学习的共享类型(spec: docs/superpowers/specs/2026-07-26-self-learning-rules-design.md)。
 * 台账(desktop main)与筛/提炼/应用(本目录)共用 —— 谓词单源的前提是类型单源。
 *
 * 跨场键是 category(+候选事件 type),**不是 findingKey**:findingKey 含
 * eventIds,那是每场候选的局部 id,跨场永不重复(aggregate() 跨场也只用
 * category,findingKey 只服务单场 flags)。
 */

/** 台账一行 = 一次分析 run(内嵌该场 findings)。同场重分析追加新行,
 * 读取时按 matchId 取 createdAt 最大的一行(last-run-wins,整场替换 ——
 * 逐 finding 后写胜出会让被新一轮放弃的旧 finding 永久残留)。 */
export interface LedgerRun {
  v: 1;
  matchId: string;
  /** 对局开始时间(ms)—— 窗口排序键(meta.json 的 startTime)。 */
  startTime: number;
  win: boolean;
  zoneId?: string;
  bracket?: string;
  /** 敌方专精 id(meta.teams[1]);旧档缺 teams 时 []。 */
  enemySpecs: number[];
  /** 只记录不作废:学习记忆与 prompt 缓存失效解耦(spec §1)。 */
  promptVersion: number;
  createdAt: number;
  findings: LedgerFinding[];
}

export interface LedgerFinding {
  /** 已过 normalizeFindingCategory 的 slug(写入侧保证)。 */
  category: string;
  severity: string;
  /** finding 引用的候选事件 type 去重升序(live 写入时有;回填旧场为 [])。 */
  eventTypes: string[];
}

/** 台账归并后的对局视图 = LedgerRun 去掉信封字段;scan/统计的输入。 */
export type LedgerMatch = Omit<LedgerRun, "v" | "promptVersion" | "createdAt">;

export interface PatternCondition {
  enemySpec?: number;
  zoneId?: string;
}

export interface GroupStats {
  /** 实际窗口大小(min(符合条件的对局数, PATTERN_WINDOW_MATCHES))。 */
  windowMatches: number;
  hits: number;
  /** 全历史(不限窗口)首/末命中对局的 startTime;无命中时 0。 */
  firstSeen: number;
  lastSeen: number;
  /** 窗口内按 TREND_BUCKET_MATCHES 场分桶的命中数,旧→新。 */
  trend: number[];
  /** 窗口内最近命中的对局 id,新→旧,≤3 —— 提炼实例与 UI 证据链。 */
  exampleMatchIds: string[];
  /** 命中是否横跨窗口新旧两半(排除一波连败尖峰)。 */
  spansBothHalves: boolean;
}

export interface StablePattern {
  /** 确定性 id,同时用作 ruleId:cat:<c>[|type:<t>][|spec:<id>][|zone:<id>] */
  patternId: string;
  category: string;
  /** [] = category 级;["death"] = category+type 级(单 type)。 */
  eventTypes: string[];
  condition: PatternCondition | null;
  windowMatches: number;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  trend: number[];
  exampleMatchIds: string[];
}

export interface LearnedRule {
  ruleId: string;
  status: "active" | "improved";
  category: string;
  eventTypes: string[];
  condition: PatternCondition | null;
  stats: {
    windowMatches: number;
    hits: number;
    firstSeen: number;
    lastSeen: number;
    trend: number[];
  };
  /** 模板文本(含 {{hits}}/{{windowMatches}} 占位符),渲染时插值。
   * 缺当前语言 → UI 用确定性兜底(category 标签 + stats),下轮整合懒补。 */
  description: { zh?: string; en?: string };
  advice: { zh?: string; en?: string };
  evidence: string[];
  distilledAt: number;
  distillModel: string;
}

export interface RulesDoc {
  schemaVersion: 1;
  updatedAt: number;
  /** 上次整合时台账覆盖的对局数 —— 增量自动触发的判据。 */
  ledgerMatches: number;
  rules: LearnedRule[];
}
