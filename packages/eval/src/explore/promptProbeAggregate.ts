/**
 * 消融探针结果的聚合 —— 单源。
 *
 * `scripts/promptAblationProbe.ts`(单 run 报告)与 `scripts/promptProbeCompare.ts`
 * (跨模型对照)必须用同一套「噪声底 + 每变体对每基线取平均 + z」口径;这正是
 * CLAUDE.md 共享谓词规则的形状 —— 两个消费者、一个事实(「这一类行的效应是多少」)。
 */
import { jaccard } from "./promptLineTypes";

export interface ProbeRow {
  match: string;
  variant: string;
  answer: string;
  moments: string[];
  topics: string[];
  chars: number;
}

export interface TypeAgg {
  n: number;
  meanJaccard: number;
  meanLost: number;
  meanCharDelta: number;
  /** 与噪声底之差 / 合成标准误。≤−2 视为显著。 */
  z: number;
}

export interface RunAgg {
  floorMean: number;
  floorSd: number;
  floorN: number;
  perType: Map<string, TypeAgg>;
  validSamples: number;
}

export function aggregateProbeRows(rows: ProbeRow[]): RunAgg {
  const ok = (r: ProbeRow | undefined) =>
    r !== undefined && !r.answer.startsWith("__ERROR__");
  const byMatch = new Map<string, Map<string, ProbeRow>>();
  let valid = 0;
  for (const r of rows) {
    if (!ok(r)) continue;
    valid++;
    if (!byMatch.has(r.match)) byMatch.set(r.match, new Map());
    byMatch.get(r.match)!.set(r.variant, r);
  }
  const controlJ: number[] = [];
  interface Acc {
    n: number;
    j: number;
    lost: number;
    cd: number;
  }
  const acc = new Map<string, Acc>();
  for (const [, variants] of byMatch) {
    const bases = [...variants.entries()]
      .filter(([v]) => v.startsWith("baseline"))
      .map(([, r]) => r);
    if (bases.length === 0) continue;
    for (let i = 0; i < bases.length; i++)
      for (let j = i + 1; j < bases.length; j++)
        controlJ.push(
          jaccard(new Set(bases[i].topics), new Set(bases[j].topics)),
        );
    for (const [v, r] of variants) {
      if (v.startsWith("baseline")) continue;
      const rm = new Set(r.topics);
      let js = 0;
      let ls = 0;
      let cs = 0;
      for (const b of bases) {
        const bm = new Set(b.topics);
        js += jaccard(bm, rm);
        ls += [...bm].filter((x) => !rm.has(x)).length / Math.max(1, bm.size);
        cs += (r.chars - b.chars) / Math.max(1, b.chars);
      }
      const a = acc.get(v) ?? { n: 0, j: 0, lost: 0, cd: 0 };
      a.n++;
      a.j += js / bases.length;
      a.lost += ls / bases.length;
      a.cd += cs / bases.length;
      acc.set(v, a);
    }
  }
  const mean = (a: number[]) =>
    a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const floorMean = mean(controlJ);
  const floorSd = Math.sqrt(mean(controlJ.map((x) => (x - floorMean) ** 2)));
  const floorSe = floorSd / Math.sqrt(Math.max(1, controlJ.length));
  const perType = new Map<string, TypeAgg>();
  for (const [v, a] of acc) {
    const m = a.j / a.n;
    const se = Math.sqrt(floorSe ** 2 + (floorSd / Math.sqrt(a.n)) ** 2);
    perType.set(v, {
      n: a.n,
      meanJaccard: m,
      meanLost: a.lost / a.n,
      meanCharDelta: a.cd / a.n,
      z: se > 0 ? (m - floorMean) / se : 0,
    });
  }
  return {
    floorMean,
    floorSd,
    floorN: controlJ.length,
    perType,
    validSamples: valid,
  };
}

/** Spearman 秩相关 —— 两个模型对同一批类型的「依赖度排序」是否一致。 */
export function spearman(
  a: Map<string, number>,
  b: Map<string, number>,
): { rho: number; n: number } {
  const keys = [...a.keys()].filter((k) => b.has(k));
  const n = keys.length;
  if (n < 3) return { rho: NaN, n };
  const rank = (m: Map<string, number>) => {
    const sorted = [...keys].sort((x, y) => m.get(x)! - m.get(y)!);
    const r = new Map<string, number>();
    sorted.forEach((k, i) => r.set(k, i + 1));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  let d2 = 0;
  for (const k of keys) d2 += (ra.get(k)! - rb.get(k)!) ** 2;
  return { rho: 1 - (6 * d2) / (n * (n * n - 1)), n };
}
