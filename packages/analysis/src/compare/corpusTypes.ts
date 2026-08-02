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
