import {
  DMG_SPIKE_THRESHOLD,
  computeHealerExposureEvents,
  computePressureWindows,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

export interface PressureBand {
  fromS: number;
  toS: number;
  targetName: string;
  totalDamage: number;
  /** 取整秒窗口时长(≥1)算出的 k DPS,与 [DMG SPIKE] 行同口径。 */
  dpsK: number;
}
export interface ExposureMark {
  tS: number;
  label: "Critical" | "Exposed" | "Pressured"; // Safe 不出泳道
  /** hover 文案(中文,derive 拼好):威胁数/饰品状态/LoS 掩体距离。 */
  title: string;
}

/** 承压泳道 derive(#4):spike 门/窗参与 [DMG SPIKE] prompt 行同谓词
 * (DMG_SPIKE_THRESHOLD + computePressureWindows 默认参),prompt 有的段
 * 泳道必有。exposure 经 computeHealerExposureEvents 单入口,无坐标优雅缺席。 */
export function derivePressureLanes(source: ReportSource): {
  spikes: PressureBand[];
  exposures: ExposureMark[];
} {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    if (friends.length === 0) return { spikes: [], exposures: [] };

    const spikes: PressureBand[] = computePressureWindows(friends, legacy)
      .filter((pw) => pw.totalDamage >= DMG_SPIKE_THRESHOLD)
      .map((pw) => {
        const windowSec = Math.round(pw.toSeconds - pw.fromSeconds);
        return {
          fromS: pw.fromSeconds,
          toS: pw.toSeconds,
          targetName: pw.targetName,
          totalDamage: pw.totalDamage,
          // 同口径:emitDmgSpikeEntries 的 dpsK 公式(B20 防 Infinity)
          dpsK: Math.round(pw.totalDamage / Math.max(1, windowSec) / 1000),
        };
      });

    // 不变量:泳道 exposure = prompt 非 Safe [HEALER EXPOSURE] 行(prompt 渲染含
    // Safe,泳道滤掉)——见 pressureLanes.test.ts 的 parity 测试。
    const exposures: ExposureMark[] = computeHealerExposureEvents(legacy)
      .filter((e) => e.exposureLabel !== "Safe")
      .map((e) => {
        const exposed = e.threats.filter((t) => !t.losBlocked).length;
        const trinket =
          e.trinketState === "available"
            ? "饰品在手"
            : e.trinketState === "passive"
              ? "被动饰品"
              : "饰品转 CD";
        const los =
          e.losBreak && e.losBreak.repositionYards <= 30
            ? `;LoS 掩体 ~${e.losBreak.repositionYards} 码`
            : "";
        return {
          tS: e.atSeconds,
          label: e.exposureLabel as ExposureMark["label"],
          title: `治疗暴露(${e.exposureLabel})· ${exposed} 威胁在 LoS · ${trinket}${los}`,
        };
      });

    return { spikes, exposures };
  } catch {
    return { spikes: [], exposures: [] };
  }
}
