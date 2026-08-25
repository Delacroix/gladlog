// packages/analysis/src/compare/corpusTypes.ts
export interface MetricDist {
  p10: number;
  p50: number;
  p90: number;
  n: number;
}
export interface BuildGroupDecl {
  keystoneNodeIds: number[];
  match: "any" | "all";
  groupPresent: string;
  groupAbsent: string;
}
/** #37 缺口一: one aggregated opener/chain entry; share = fraction of the
 * cell's records that matched. */
export interface RotationEntry {
  seq: string;
  share: number;
}
export interface RotationSummary {
  openers: RotationEntry[];
  sequences: RotationEntry[];
}

export interface ReferenceCell {
  spec: string;
  bracket: string;
  archetype: string;
  buildGroup: string;
  /** P2 opposing-comp dimension: the enemy comp signature
   * (enemyCompSignature); present on comp cells only. */
  enemyComp?: string;
  sampleN: number;
  insufficient: boolean;
  metrics: Record<string, MetricDist>;
  /** comp cell: match duration distribution (seconds). */
  durationS?: MetricDist;
  /** comp cell: spec counts for the first enemy killed (who gets killed
   * first). */
  firstKill?: Record<string, number>;
  exemplarCrises: string[][];
  /** #37 缺口一: how this cohort actually plays — aggregated from
   * extractRotations across the cell's records. Absent on corpora built
   * before 2026-08-25. */
  rotationSummary?: RotationSummary;
}

/** Enemy comp signature — the single predicate shared by the builder and the
 * renderer (spec names sorted and joined). */
export function enemyCompSignature(specNames: string[]): string {
  return [...specNames].filter(Boolean).sort().join(" + ");
}
export interface ReferenceCorpus {
  wowPatchVersion: string;
  builtAt: string;
  sourceFloor: number;
  buildGroups: Record<string, BuildGroupDecl>;
  cells: ReferenceCell[];
}
