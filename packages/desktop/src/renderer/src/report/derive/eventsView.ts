import { displaySpellName } from "./spellDisplay";
import { tInRange, type TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

/**
 * Events view (phase four ②, a structured-filter take on WCL Events — no
 * expression DSL): flattens each unit's event arrays into uniform rows,
 * filterable along five dimensions (kind / source / target / spell / time
 * window). It doubles as the landing container for B2 provenance: every row is
 * at "source log event" granularity, and ▶ jumps into the replay.
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
  /** The amount (damage/heal) or a supplementary note (what was interrupted,
   * what was dispelled, aura gained/lost). */
  detail: string;
  /** Numeric amount (damage/heal rows; used by the amount micro-bar and by the
   * tick-group sum). */
  amount?: number;
  /** Unit id for a death row (so the death review can be opened directly);
   * absent on all other rows. */
  destId?: string;
  /** Index of the source line within the match's rawLines (B2 provenance);
   * undefined when parsed from an older archive that lacks the field. */
  lineIndex?: number;
}

/** Death aura-clear folding: a consecutive run of aura-removed rows on the
 * same target spanning ≤1.5s with ≥5 rows collapses into one group row. */
export const AURA_FLOOD_SPAN_S = 1.5;
export const AURA_FLOOD_MIN = 5;
/** A death row for that target within ±1.5s of the group marks it as a
 * death-triggered aura clear. */
export const AURA_FLOOD_DEATH_SLACK_S = 1.5;
/** Periodic tick grouping: adjacent rows with the same (kind, src, dest,
 * spell) at ≤2s spacing, with ≥3 rows. */
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
  /** The original kind of the grouped rows (damage | heal). */
  rowKind: EventKind;
  srcName: string;
  destName: string;
  spellId: string;
  spellName: string;
  count: number;
  /** Sum of the amounts. */
  amount: number;
  children: EventRow[];
}

/** A display row is either a raw row or a group row. When a group is expanded
 * its children render as ordinary rows (flat-list design: constant row height,
 * leaving the door open for windowing in phase two). */
export type DisplayRow = EventRow | AuraFloodRow | TickGroupRow;

export const isGroupRow = (r: DisplayRow): r is AuraFloodRow | TickGroupRow =>
  r.kind === "aura-flood" || r.kind === "tick-group";

export interface EventsFilter {
  kinds: EventKind[]; // empty = all
  unitName: string | null; // matches source or target (short name)
  spellQuery: string; // substring of the spell name (case-insensitive)
  range: TimeRange | null; // time window (shares the type with the global one)
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

/** Amount formatting (reused by UI such as tick-group rows, under the same
 * convention as the inline detail column). */
export const fmtEventAmt = fmtAmt;

const spellNameOf = (e: RawEvent): string =>
  displaySpellName(String(e.spellId ?? ""), e.spellName);

/** Flatten + sort (done once, expensive); filtering happens in
 * filterEventRows (cheap, safe to run at high frequency). */
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
      // Players and pets both go in (pet events already carry their own src
      // name)
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

/** Grouping post-pass: death aura-clear folding + periodic tick grouping. Only
 * **consecutive** rows in the table count (matching the flood a human actually
 * sees); it runs over the full row set, and the filter semantics live in
 * filterDisplayRows. */
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

/** Filter semantics: a group is shown whole as soon as any child matches;
 * `matched` counts matching **raw** rows (the convention behind the count
 * label: {raw rows after filtering} / {all raw rows}). */
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
