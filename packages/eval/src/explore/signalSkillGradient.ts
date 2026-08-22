/**
 * Skill-gradient validation for coaching signals (the corpus experiment behind
 * `scripts/signalSkillGradientScan.ts`).
 *
 * **The question.** Every calibration this project has run measured occurrence
 * rate, model behaviour, or determinism — never whether an accusation is
 * *correct* (docs/coaching-grounding-audit.md §B). The one correctness proxy
 * used so far is within-round win/loss discrimination, and that axis is
 * circular by construction: a stronger opponent causes both more crowd control
 * landing on you and more losses, so a signal can look discriminating while
 * describing nothing you did wrong (`candidateDiagnostics.ts` says so in its
 * own header).
 *
 * **The design.** Use an external ground truth the round's own events cannot
 * cause: the players' rating, which the PvP log archive records per match. A
 * genuinely teachable mistake should get *rarer per opportunity* as rating
 * rises — 2400 players are, by definition, the ones who make fewer of them. So
 * for each signal type we compute
 *
 *     conversion = rounds that triggered ÷ rounds that had the opportunity
 *
 * inside each rating bucket, and look at the gradient across buckets:
 *   - **negative** (high rating converts less) → consistent with a real mistake
 *   - **flat** → the signal describes normal play, not an error
 *   - **positive** (high rating does it MORE) → we are probably scolding good play
 *
 * This can still only falsify: a negative gradient is consistent with a real
 * mistake but does not prove causation, and rating correlates with everything
 * (comp, spec distribution, dampening). It is nonetheless the first axis in
 * this project that is not derived from the same events the signal fires on.
 *
 * **Opportunity denominators.** Normalising by *rounds* would reproduce the
 * exact failure the 2026-08-19 lesson names (`opportunity-normalized-
 * discrimination`): higher-rated games throw more CC, so a per-round rate rises
 * with skill even when per-opportunity behaviour improves. Each signal family
 * therefore gets an exposure count drawn from the round's own events; a family
 * with no honest denominator is reported as `rounds` and flagged, never
 * silently normalised by the wrong thing.
 */

/** Rating buckets. Boundaries match the feed's own server-side tiers so a
 * bucket is a population the archive can actually be re-sampled at. */
export const RATING_BUCKETS = [
  { key: "<1600", min: 0, max: 1599 },
  { key: "1600-1999", min: 1600, max: 1999 },
  { key: "2000-2399", min: 2000, max: 2399 },
  { key: "2400+", min: 2400, max: Infinity },
] as const;

export type RatingBucket = (typeof RATING_BUCKETS)[number]["key"];

export function bucketOf(rating: number | null | undefined): RatingBucket | null {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return null;
  return RATING_BUCKETS.find((b) => rating >= b.min && rating <= b.max)!.key;
}

/**
 * Which exposure count is the honest denominator for each signal family.
 * `rounds` means "no defensible opportunity count exists yet" — those rows are
 * reported but marked, never compared across buckets as if normalised.
 */
export const DENOMINATOR_OF: Record<string, keyof RoundExposure> = {
  "cc-locked": "ccOnOwner",
  "cc-avoidable": "ccOnOwner",
  "wasted-trinket": "ccOnOwner",
  "attempt-into-trinket": "enemyCcOnTeam",
  "missed-cleanse": "cleansableOnTeam",
  "missed-purge": "enemyBuffsPurgeable",
  "death-setup": "friendlyDeaths",
  "external-unused": "friendlyDeaths",
  "death-unused-defensive": "friendlyDeaths",
  "kick-eaten": "ownerHardCasts",
  "cd-hoarded": "rounds",
  "cd-spent-idle": "rounds",
  "unsynced-burst": "rounds",
  "slow-defensive-response": "friendlyDamageSpikes",
  "md-cyclone-window": "rounds",
};

/** Per-round exposure counts — plain event tallies, no analysis re-entry. */
export interface RoundExposure {
  rounds: 1;
  ccOnOwner: number;
  enemyCcOnTeam: number;
  cleansableOnTeam: number;
  enemyBuffsPurgeable: number;
  friendlyDeaths: number;
  ownerHardCasts: number;
  friendlyDamageSpikes: number;
}

export interface RoundRecord {
  matchId: string;
  seq: number | null;
  bracket: string;
  startTime: number;
  rating: number | null;
  bucket: RatingBucket | null;
  win: boolean | null;
  ownerSpec: string;
  durationS: number;
  /** signal type → did it fire at least once this round */
  fired: string[];
  exposure: RoundExposure;
}

export interface GradientRow {
  type: string;
  denominator: string;
  /** bucket → { triggered, exposed, rate } */
  byBucket: Record<string, { triggered: number; exposed: number; rate: number | null }>;
  /** rate(top populated bucket) − rate(bottom populated bucket), in points */
  gradientPp: number | null;
  totalTriggered: number;
  totalExposed: number;
}

/** Wilson 95% interval — small buckets are the norm here, so a normal
 * approximation would produce impossible bounds and overstate certainty. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** Aggregate per-round records into one gradient row per signal type. */
export function aggregateGradient(records: RoundRecord[]): GradientRow[] {
  const types = new Set<string>();
  for (const r of records) for (const t of r.fired) types.add(t);
  for (const t of Object.keys(DENOMINATOR_OF)) types.add(t);

  const rows: GradientRow[] = [];
  for (const type of [...types].sort()) {
    const denomKey = DENOMINATOR_OF[type] ?? "rounds";
    const byBucket: GradientRow["byBucket"] = {};
    let totalTriggered = 0;
    let totalExposed = 0;
    for (const b of RATING_BUCKETS) {
      let triggered = 0;
      let exposed = 0;
      for (const r of records) {
        if (r.bucket !== b.key) continue;
        // A round with zero opportunities is not evidence either way: it is
        // excluded from BOTH numerator and denominator (this is the whole
        // point of opportunity normalisation).
        const e = denomKey === "rounds" ? 1 : r.exposure[denomKey];
        if (!e) continue;
        exposed++;
        if (r.fired.includes(type)) triggered++;
      }
      byBucket[b.key] = { triggered, exposed, rate: exposed ? triggered / exposed : null };
      totalTriggered += triggered;
      totalExposed += exposed;
    }
    const populated = RATING_BUCKETS.map((b) => byBucket[b.key]!).filter(
      (v) => v.exposed >= MIN_BUCKET_N,
    );
    const gradientPp =
      populated.length >= 2
        ? (populated[populated.length - 1]!.rate! - populated[0]!.rate!) * 100
        : null;
    rows.push({ type, denominator: denomKey, byBucket, gradientPp, totalTriggered, totalExposed });
  }
  return rows;
}

/** A bucket below this many exposed rounds is not used as a gradient endpoint. */
export const MIN_BUCKET_N = 100;

export function formatGradientReport(rows: GradientRow[], meta: string): string {
  const out: string[] = ["# Signal skill-gradient scan", "", meta, ""];
  out.push("Reading: negative gradient = higher-rated players make it LESS per opportunity (consistent with a real mistake).");
  out.push("`rounds` denominator = no honest opportunity count yet; not comparable across buckets. Buckets below " + MIN_BUCKET_N + " exposed rounds are not used as endpoints.");
  out.push("");
  out.push("| signal | denominator | " + RATING_BUCKETS.map((b) => b.key).join(" | ") + " | gradient pp | n exposed |");
  out.push("|---|---|" + RATING_BUCKETS.map(() => "---:").join("|") + "|---:|---:|");
  for (const r of [...rows].sort((a, b) => (a.gradientPp ?? 0) - (b.gradientPp ?? 0))) {
    const cells = RATING_BUCKETS.map((b) => {
      const v = r.byBucket[b.key]!;
      if (!v.exposed) return "—";
      const ci = wilson95(v.triggered, v.exposed)!;
      return `${(v.rate! * 100).toFixed(1)}% [${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}] n=${v.exposed}`;
    });
    out.push(
      `| ${r.type} | ${r.denominator}${r.denominator === "rounds" ? " ⚠" : ""} | ${cells.join(" | ")} | ${r.gradientPp == null ? "—" : r.gradientPp.toFixed(1)} | ${r.totalExposed} |`,
    );
  }
  return out.join("\n") + "\n";
}
