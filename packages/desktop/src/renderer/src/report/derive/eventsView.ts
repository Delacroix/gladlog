import { displaySpellName } from "./spellDisplay";
import { tInRange, type TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

/**
 * events 视图(第四阶段②,WCL Events 的结构化过滤版 —— 不做表达式 DSL):
 * 把各单位事件数组摊平成统一行,供 类型/来源/目标/技能/时间窗 五维过滤。
 * 兼作 B2 溯源的落地容器:每行都是「源日志事件」粒度,▶ 可跳回放。
 */

export type EventKind =
  "damage" | "heal" | "cast" | "aura" | "dispel" | "interrupt" | "death";

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  damage: "伤害",
  heal: "治疗",
  cast: "施放",
  aura: "光环",
  dispel: "驱散",
  interrupt: "打断",
  death: "死亡",
};

export interface EventRow {
  tS: number;
  kind: EventKind;
  srcName: string;
  destName: string;
  spellId: string;
  spellName: string;
  /** 数额(伤害/治疗)或补充说明(打断了什么/驱掉了什么/光环增减)。 */
  detail: string;
  /** 数值化数额(伤害/治疗行;数额微条与 tick 聚合求和用)。 */
  amount?: number;
  /** 死亡行的单位 id(死亡回顾直达用);其余行不带。 */
  destId?: string;
  /** 源行在对局 rawLines 里的下标(B2 溯源);旧档解析无此字段 → undefined。 */
  lineIndex?: number;
}

/** 死亡清场折叠:连续同目标 −失去,跨度 ≤1.5s、条数 ≥5 → 一条聚合行。 */
export const AURA_FLOOD_SPAN_S = 1.5;
export const AURA_FLOOD_MIN = 5;
/** 聚合段 ±1.5s 内该目标有 death 行 → 标「死亡清场」。 */
export const AURA_FLOOD_DEATH_SLACK_S = 1.5;
/** 周期 tick 聚合:相邻同 (kind,src,dest,spell) 间隔 ≤2s、条数 ≥3。 */
export const TICK_GAP_S = 2;
export const TICK_MIN = 3;

export interface AuraFloodRow {
  kind: "aura-flood";
  tS: number;
  destName: string;
  count: number;
  deathClear: boolean;
  children: EventRow[];
}

export interface TickGroupRow {
  kind: "tick-group";
  tS: number;
  /** 被聚合行的原始 kind(damage | heal)。 */
  rowKind: EventKind;
  srcName: string;
  destName: string;
  spellId: string;
  spellName: string;
  count: number;
  /** 数额求和。 */
  amount: number;
  children: EventRow[];
}

/** 展示行 = 原始行 | 聚合行。聚合行展开时 children 以普通行渲染
 * (扁平列表设计:行高恒定,为第二阶段窗口化留门)。 */
export type DisplayRow = EventRow | AuraFloodRow | TickGroupRow;

export const isGroupRow = (r: DisplayRow): r is AuraFloodRow | TickGroupRow =>
  r.kind === "aura-flood" || r.kind === "tick-group";

export interface EventsFilter {
  kinds: EventKind[]; // 空 = 全部
  unitName: string | null; // 来源或目标匹配(短名)
  spellQuery: string; // 技能名子串(不区分大小写)
  range: TimeRange | null; // 时间窗(与全局时间窗联动共用类型)
}

export const EMPTY_EVENTS_FILTER: EventsFilter = {
  kinds: [],
  unitName: null,
  spellQuery: "",
  range: null,
};

interface RawEvent {
  timestamp: number;
  eventName?: string;
  spellId?: number | string;
  spellName?: string;
  srcName?: string;
  destName?: string;
  amount?: number;
  effectiveAmount?: number;
  extraSpellName?: string;
  params?: string[];
  unconscious?: boolean;
  lineIndex?: number;
}

interface UnitLike {
  id: string;
  name: string;
  kind?: string;
  info?: unknown;
  ownerId?: string;
  damageOut?: RawEvent[];
  healOut?: RawEvent[];
  casts?: RawEvent[];
  auraEvents?: RawEvent[];
  actionsOut?: RawEvent[];
  deaths?: RawEvent[];
}

const fmtAmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

/** 数额格式(tick 聚合行等 UI 复用,与行内 detail 同一口径)。 */
export const fmtEventAmt = fmtAmt;

const spellNameOf = (e: RawEvent): string =>
  displaySpellName(String(e.spellId ?? ""), e.spellName);

/** 摊平 + 排序(一次,昂贵);过滤在 filterEventRows 里做(便宜,可高频)。 */
export function deriveEventRows(source: ReportSource): EventRow[] {
  try {
    const startMs = source.startTime;
    const rel = (ts: number) => Math.round(((ts - startMs) / 1000) * 10) / 10;
    const rows: EventRow[] = [];
    const push = (
      e: RawEvent,
      kind: EventKind,
      detail: string,
      extra?: { destOverride?: string; amount?: number; destId?: string },
    ) =>
      rows.push({
        tS: rel(e.timestamp),
        kind,
        srcName: (e.srcName ?? "").split("-")[0]!,
        destName: (extra?.destOverride ?? e.destName ?? "").split("-")[0]!,
        spellId: String(e.spellId ?? ""),
        spellName: spellNameOf(e),
        detail,
        amount: extra?.amount,
        destId: extra?.destId,
        lineIndex: e.lineIndex,
      });

    for (const u of Object.values(source.units) as unknown as UnitLike[]) {
      // 玩家 + 宠物都进(宠物事件本就带自己的 src 名)
      for (const e of u.damageOut ?? []) {
        const amt = Math.abs(e.effectiveAmount ?? e.amount ?? 0);
        push(e, "damage", fmtAmt(amt), { amount: amt });
      }
      for (const e of u.healOut ?? []) {
        const amt = Math.abs(e.effectiveAmount ?? e.amount ?? 0);
        push(e, "heal", fmtAmt(amt), { amount: amt });
      }
      for (const e of u.casts ?? []) {
        if (e.eventName === "SPELL_CAST_SUCCESS") push(e, "cast", "");
      }
      for (const e of u.auraEvents ?? []) {
        const ev = e.eventName ?? "";
        if (ev === "SPELL_AURA_APPLIED") push(e, "aura", "+获得");
        else if (ev === "SPELL_AURA_REMOVED") push(e, "aura", "−失去");
      }
      for (const e of u.actionsOut ?? []) {
        const ev = e.eventName ?? "";
        const extra = e.extraSpellName ?? e.params?.[12] ?? "";
        if (ev === "SPELL_DISPEL" || ev === "SPELL_STOLEN")
          push(e, "dispel", `驱掉 ${extra}`);
        else if (ev === "SPELL_INTERRUPT")
          push(e, "interrupt", `打断 ${extra}`);
      }
      for (const e of u.deaths ?? []) {
        if (!e.unconscious)
          push(e, "death", "死亡", {
            destOverride: (u.name ?? "").split("-")[0],
            destId: u.id,
          });
      }
    }
    return rows.sort((a, b) => a.tS - b.tS);
  } catch {
    return [];
  }
}

const rowMatches = (r: EventRow, f: EventsFilter, q: string): boolean => {
  if (f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
  if (f.unitName && r.srcName !== f.unitName && r.destName !== f.unitName)
    return false;
  if (q && !r.spellName.toLowerCase().includes(q)) return false;
  if (!tInRange(r.tS, f.range)) return false;
  return true;
};

export function filterEventRows(rows: EventRow[], f: EventsFilter): EventRow[] {
  const q = f.spellQuery.trim().toLowerCase();
  return rows.filter((r) => rowMatches(r, f, q));
}

/** 聚合后处理:死亡清场折叠 + 周期 tick 聚合。只认表格里**连续**的行
 * (与肉眼看到的刷屏一致);全量行上做,过滤语义见 filterDisplayRows。 */
export function groupEventRows(rows: EventRow[]): DisplayRow[] {
  const deaths = rows.filter((r) => r.kind === "death");
  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.kind === "aura" && r.detail === "−失去") {
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j]!.kind === "aura" &&
        rows[j]!.detail === "−失去" &&
        rows[j]!.destName === r.destName &&
        rows[j]!.tS - r.tS <= AURA_FLOOD_SPAN_S
      )
        j++;
      if (j - i >= AURA_FLOOD_MIN) {
        const children = rows.slice(i, j);
        const lastT = children[children.length - 1]!.tS;
        const deathClear = deaths.some(
          (d) =>
            d.destName === r.destName &&
            d.tS >= r.tS - AURA_FLOOD_DEATH_SLACK_S &&
            d.tS <= lastT + AURA_FLOOD_DEATH_SLACK_S,
        );
        out.push({
          kind: "aura-flood",
          tS: r.tS,
          destName: r.destName,
          count: children.length,
          deathClear,
          children,
        });
        i = j;
        continue;
      }
    }
    if (r.kind === "damage" || r.kind === "heal") {
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j]!.kind === r.kind &&
        rows[j]!.srcName === r.srcName &&
        rows[j]!.destName === r.destName &&
        rows[j]!.spellName === r.spellName &&
        rows[j]!.tS - rows[j - 1]!.tS <= TICK_GAP_S
      )
        j++;
      if (j - i >= TICK_MIN) {
        const children = rows.slice(i, j);
        out.push({
          kind: "tick-group",
          tS: r.tS,
          rowKind: r.kind,
          srcName: r.srcName,
          destName: r.destName,
          spellId: r.spellId,
          spellName: r.spellName,
          count: children.length,
          amount: children.reduce((s, c) => s + (c.amount ?? 0), 0),
          children,
        });
        i = j;
        continue;
      }
    }
    out.push(r);
    i++;
  }
  return out;
}

/** 过滤语义:聚合组任一 child 命中即整组显示;matched = 命中的**原始**行数
 * (计数文案的口径:{过滤后原始行} / {全部原始行})。 */
export function filterDisplayRows(
  display: DisplayRow[],
  f: EventsFilter,
): { rows: DisplayRow[]; matched: number } {
  const q = f.spellQuery.trim().toLowerCase();
  const rows: DisplayRow[] = [];
  let matched = 0;
  for (const d of display) {
    if (isGroupRow(d)) {
      const hit = d.children.reduce(
        (s, c) => s + (rowMatches(c, f, q) ? 1 : 0),
        0,
      );
      if (hit > 0) {
        rows.push(d);
        matched += hit;
      }
    } else if (rowMatches(d, f, q)) {
      rows.push(d);
      matched++;
    }
  }
  return { rows, matched };
}
