import { deriveKeyMoments, type KeyMomentKind } from "./keyMoments";
import { deriveMistakes } from "./mistakes";
import type { ReportSource } from "./types";

/** 录像 tab 的统一时刻源(标记条 + 事件 feed 共用):
 * keyMoments(死亡/爆发带/防御/驱散/控制)+ 确定性失误 ⚠ + AI 深挖 chips。
 * tS 一律相对本场(shuffle 为本轮)秒;换算到视频秒由调用方做
 * (+ (source.startTime - startedAt)/1000)。 */
export interface VideoMoment {
  tS: number;
  /** burst-band 专用:区间终点。 */
  toS?: number;
  kind: KeyMomentKind | "mistake" | "ai";
  weight: "major" | "minor";
  label: string;
  unitNames: string[];
}

export interface AiChipLike {
  t: number;
  label: string;
  unitNames?: string[];
}

export function deriveVideoMoments(
  source: ReportSource,
  aiChips?: AiChipLike[],
): VideoMoment[] {
  const out: VideoMoment[] = [];
  try {
    for (const k of deriveKeyMoments(source)) {
      out.push({
        tS: k.t,
        toS: k.toT,
        kind: k.kind,
        weight: k.weight,
        label: k.detail ? `${k.title} · ${k.detail}` : k.title,
        unitNames: k.unitNames,
      });
    }
  } catch {
    /* 单路失败不拖垮 */
  }
  try {
    for (const mk of deriveMistakes(source)) {
      out.push({
        tS: mk.tS,
        kind: "mistake",
        weight: "major",
        label: `${mk.label} · ${mk.unitName.split("-")[0] ?? mk.unitName}`,
        unitNames: mk.seekNames,
      });
    }
  } catch {
    /* 同上 */
  }
  for (const c of aiChips ?? []) {
    if (!Number.isFinite(c?.t) || !c.label) continue;
    out.push({
      tS: c.t,
      kind: "ai",
      weight: "major",
      label: c.label,
      unitNames: c.unitNames ?? [],
    });
  }
  return out.sort((a, b) => a.tS - b.tS);
}
