import { classColor } from "../data/gameConstants";
import type { UnitTotals } from "./summary";

// "stats" is a fourth meter mode (the statistics table) and does not go through
// the numeric meterRows path.
export type MeterMode = "damage" | "healing" | "taken" | "stats";

export interface MeterRow {
  unitId: string;
  name: string;
  classId: number;
  teamId: number;
  value: number;
  widthPct: number;
  label: string;
  /** The exact full value (toLocaleString); backs the abbreviated label's
   *  title. */
  exactLabel: string;
  color: string;
}

/** Tiered abbreviation for meter values (P2-2): ≥1e6 → x.xxM, ≥1e5 → xxxk,
 *  everything else in full. */
export function abbrevAmount(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}k`;
  return Math.round(v).toLocaleString("en-US");
}

export function meterValue(r: UnitTotals, mode: MeterMode): number {
  return mode === "damage"
    ? r.damageDone
    : mode === "healing"
      ? r.healingDone + r.absorbsDone
      : r.damageTaken;
}

export function meterRows(rows: UnitTotals[], mode: MeterMode): MeterRow[] {
  const sorted = [...rows].sort(
    (a, b) => meterValue(b, mode) - meterValue(a, mode),
  );
  const max = Math.max(1, ...sorted.map((r) => meterValue(r, mode)));
  return sorted.map((r) => {
    const value = meterValue(r, mode);
    return {
      unitId: r.unitId,
      name: r.name,
      classId: r.classId,
      teamId: r.teamId,
      value,
      widthPct: (value / max) * 100,
      label: abbrevAmount(value),
      /** The exact full value (kept for the row title, alongside the
       *  abbreviated label). */
      exactLabel: Math.round(value).toLocaleString("en-US"),
      color: classColor(r.classId),
    };
  });
}
