import { classColor } from "../data/gameConstants";
import type { UnitTotals } from "./summary";

// "stats" 是第四种榜单模式(统计表),不走 meterRows 数值路径。
export type MeterMode = "damage" | "healing" | "taken" | "stats";

export interface MeterRow {
  unitId: string;
  name: string;
  classId: number;
  teamId: number;
  value: number;
  widthPct: number;
  label: string;
  /** 精确全值(toLocaleString);缩写 label 的 title 兜底。 */
  exactLabel: string;
  color: string;
}

/** 榜单数值分级缩写(P2-2):≥1e6 → x.xxM,≥1e5 → xxxk,其余全值。 */
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
      /** 精确全值(行 title 保留,与缩写 label 并存)。 */
      exactLabel: Math.round(value).toLocaleString("en-US"),
      color: classColor(r.classId),
    };
  });
}
