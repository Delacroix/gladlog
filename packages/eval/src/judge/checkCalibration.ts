/* eslint-disable no-console */
/**
 * checkJudgeCalibration.ts
 *
 * Grades the LLM judge against the synthetic-defect suite built by
 * buildJudgeCalibrationSuite.ts. Ground truth is known because we injected the
 * defects ourselves — no human annotation involved.
 *
 * Exception: dimensions in DET_GATE_DIMENSIONS (sufficiency) are adjudicated by
 * the deterministic coverage gate, not judge scores — see the constant's doc.
 *
 * For judge-adjudicated dimensions, a perturbed case counts as *detected* only
 * when it clears a discriminant-validity bar, not mere sensitivity:
 *   (1) Sensitivity — the TARGETED dimension drops below the unmodified sibling
 *       (same source ordinal) by at least DELTA_FLOOR. The floor separates a
 *       real defect signal from judge noise / integer-rubric ties.
 *   (2) Specificity — every UNtargeted dimension stays within SPECIFICITY_TOL of
 *       the original. Without this, a degenerate judge that lowers *every*
 *       dimension whenever the text merely changed passes trivially while
 *       carrying zero dimension-specific signal.
 * A dimension backed by fewer than MIN_PAIRS scoreable pairs is INSUFFICIENT
 * (not PASS): the across-dimension conjunction must have real trials behind it.
 *
 * Reads:
 *   BASE_DIR/judge-calibration/calibration-manifest.json
 *   BASE_DIR/judge-calibration/scores/<caseId>.json   (standard 7-dim format)
 * Writes:
 *   BASE_DIR/judge-calibration/calibration-report.md
 *
 * Exit code 1 if any dimension's detection rate is below PASS_THRESHOLD
 * (default 0.8) or the dimension is INSUFFICIENT/NO DATA: a judge that cannot
 * discriminately see planted defects must not be trusted to grade real
 * prompt-builder changes.
 *
 * Tunables (opts or env): PASS_THRESHOLD, MIN_PAIRS (4), DELTA_FLOOR (1),
 * SPECIFICITY_TOL (1 — integer-rubric default; 0 only for continuous rubrics,
 * where 1-pt co-movement is signal rather than quantization noise).
 */

import fs from "fs-extra";
import path from "path";

import type { CoverageManifest } from "../quality/coverageManifest";
import { checkFriendlyDeaths } from "../quality/promptQualityCheck";

/**
 * sufficiency is adjudicated by the deterministic coverage gate; judge blind
 * scores no longer decide it.
 *
 * Basis (docs/BACKLOG.md 14.2 final draft, five independent measurements):
 * with every death line deleted from the prompt, the judge showed zero
 * reaction on 8 of 10 pairs (5→5, five times), detection rate 40% → 30% →
 * 20%, and three rounds of rubric changes did nothing — the judge can only see
 * what IS in the prompt, never what the builder left out; a structural blind
 * spot. `eval-ab.md` already prescribes deterministic metrics for this
 * dimension, so the calibration side is aligned here too: run
 * `checkFriendlyDeaths` directly on removed-deaths pairs (the same predicate
 * as the production gate) — original clean AND perturbed reporting a gap →
 * detected.
 */
const DET_GATE_DIMENSIONS = new Set(["sufficiency"]);

/**
 * Coupling by construction: untargeted dimensions that the **construction** of
 * a perturbation inevitably moves are exempted from the specificity check.
 *
 * This is not a loosening — it fixes a broken premise. The specificity check
 * implicitly assumes "perturbations are dimension-orthogonal": if the judge
 * also moves another dimension, it is reacting to "the text changed" rather
 * than to the specific defect. But `removed-deaths` deletes death lines from
 * the **prompt** while the response is **left untouched**: the response's
 * claims about that death genuinely are no longer supported by the prompt, so
 * accuracy SHOULD drop. The judge is doing the right thing and being punished
 * by the rule — the premise fails, the judge is not unqualified.
 *
 * Empirical basis (2026-07-20 full-corpus calibration, 1245-match corpus @
 * 92f96d2, 40-case suite seed 42): 9 of 11 misses were specificity, not
 * sensitivity; checking the leaking dimension case by case, 8 of 10 were the
 * same `accuracy 5→3`. That is what pushed sufficiency down to 20%, while its
 * true sensitivity is 3/5 = 60%.
 *
 * **The exemption must stay narrow — only for perturbations that delete
 * content.** The other six classes are deliberately excluded, one by one:
 *   - `shuffled-events` only reorders; the content is fully preserved and every
 *     claim remains verifiable → an accuracy drop means the judge gave up on
 *     verifying, not construction, so it must still count as a violation;
 *   - `duplicated-noise` / `severity-labels` only add, never remove, so
 *     verifiability is unaffected;
 *   - `fabricated-claim` / `wrong-outcome` / `trivia-focus` modify the
 *     response, so prompt-side dimensions are unaffected; wrong-outcome leaking
 *     into accuracy is inconsistent application of the rubric-independence rule
 *     (see eval-baseline.md) — a judge problem, not exempt.
 *
 * When adding a new perturbation class, first ask: "without changing the
 * judge, would this dimension inevitably move?" If the answer is no, keep it
 * out of this table — every entry weakens this gate's discriminating power.
 */
const COUPLED_BY_CONSTRUCTION: Record<string, readonly string[]> = {
  "removed-deaths": ["accuracy"],
  // causal-hardening injects a sentence that states the match outcome's causal
  // chain as settled fact ("the collapse was a direct result of … no other
  // factor contributed") — that sentence **is** exactly what outcomeAlignment
  // grades, so this dimension moving with it is the judge doing the right
  // thing. Verified case by case on 2026-07-23 (B1 mini suite, ord 239/299):
  // both judges' outcomeAlignment notes name the injected sentence itself
  // (that the conclusion doubles as the response's "official verdict" on the
  // outcome's causal chain, which drags outcomeAlignment down), rather than
  // reacting generically to "the text changed". The exemption covers this one
  // dimension only.
  "causal-hardening": ["outcomeAlignment"],
};

interface CalibrationCase {
  caseId: string;
  sourceOrdinal: number;
  matchId: string;
  perturbation: string;
  targetDimension: string | null;
  perturbationDetail: string;
}

interface ScoreFile {
  prompt: Record<string, number | string>;
  response: Record<string, number | string>;
}

/** Parse a raw score value to a number, or null if it is not a real number.
 * Guards the JS footgun Number("") === Number("  ") === 0: an empty or
 * whitespace-only string is an absent score, not a zero. */
function toScore(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  return !isNaN(num) ? num : null;
}

function dimensionScore(score: ScoreFile, dimension: string): number | null {
  return toScore(score.prompt?.[dimension] ?? score.response?.[dimension]);
}

/** Every dimension key that carries a numeric score in this file (prompt or
 * response side). Used to find the UNtargeted dimensions for the specificity
 * check. */
function scoredDimensions(score: ScoreFile): string[] {
  const keys = new Set<string>();
  for (const side of [score.prompt, score.response]) {
    if (!side) continue;
    for (const [k, v] of Object.entries(side)) {
      if (toScore(v) !== null) keys.add(k);
    }
  }
  return [...keys];
}

export async function checkCalibration(
  baseDir: string,
  opts?: {
    passThreshold?: number;
    scoresSubdir?: string;
    /** A dimension with fewer scoreable pairs than this is INSUFFICIENT, not
     * PASS — the conjunction across dimensions must have real trials behind it. */
    minPairs?: number;
    /** The targeted dimension must drop by at least this much to count as
     * detected (separates a real defect signal from judge noise / ties). */
    deltaFloor?: number;
    /** UNtargeted dimensions may move by at most this much; a case that also
     * moves orthogonal dimensions is a judge reacting to "text changed", not to
     * the specific defect — discriminant validity, not raw sensitivity. */
    specificityTol?: number;
  },
): Promise<{
  pass: boolean;
  failures: { caseId: string; dimension: string; reason: string }[];
}> {
  const suiteDir = path.join(baseDir, "judge-calibration");
  const passThreshold =
    opts?.passThreshold ?? Number(process.env.PASS_THRESHOLD ?? 0.8);
  const scoresSubdir = opts?.scoresSubdir ?? process.env.SCORES_DIR ?? "scores";
  const minPairs = opts?.minPairs ?? Number(process.env.MIN_PAIRS ?? 4);
  const deltaFloor = opts?.deltaFloor ?? Number(process.env.DELTA_FLOOR ?? 1);
  // Default 1, not 0: on an integer 1–5 rubric even a calibrated judge wobbles untargeted
  // dims by ±1 (empirical, 2026-07-14: a judge with strong sensitivity — 31/35 planted
  // defects detected — scored 1/40 at TOL=0 purely on 1-pt co-movement). TOL=0 measures
  // integer-quantization noise, not discriminant validity; keep 0 only for continuous rubrics.
  const specificityTol =
    opts?.specificityTol ?? Number(process.env.SPECIFICITY_TOL ?? 1);

  const manifestPath = path.join(suiteDir, "calibration-manifest.json");
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(
      `No calibration manifest at ${manifestPath} — run buildCalibrationSuite first.`,
    );
  }
  const manifest = (await fs.readJson(manifestPath)) as {
    seed: number;
    cases: CalibrationCase[];
  };

  const scores = new Map<string, ScoreFile>();
  let missingScores = 0;
  for (const c of manifest.cases) {
    const scorePath = path.join(suiteDir, scoresSubdir, `${c.caseId}.json`);
    if (await fs.pathExists(scorePath)) {
      try {
        scores.set(c.caseId, (await fs.readJson(scorePath)) as ScoreFile);
      } catch (err) {
        console.error(
          `Error parsing JSON in score file ${scorePath}: ${err instanceof Error ? err.message : err}`,
        );
        missingScores++;
      }
    } else {
      missingScores++;
    }
  }
  if (missingScores > 0) {
    console.warn(
      `WARNING: ${missingScores}/${manifest.cases.length} cases have no score file yet.`,
    );
  }

  const coverageRatio =
    manifest.cases.length > 0
      ? (manifest.cases.length - missingScores) / manifest.cases.length
      : 0;
  const MIN_COVERAGE = 0.8;
  if (coverageRatio < MIN_COVERAGE && !process.env.BYPASS_COVERAGE) {
    console.error(
      `FAIL: Insufficient score coverage. Scored ${manifest.cases.length - missingScores}/${manifest.cases.length} cases (${(coverageRatio * 100).toFixed(1)}%). Minimum required is ${(MIN_COVERAGE * 100).toFixed(0)}%. Set BYPASS_COVERAGE=true to ignore.`,
    );
    process.exit(1);
  }

  const originals = new Map<number, CalibrationCase>();
  for (const c of manifest.cases)
    if (c.perturbation === "none") originals.set(c.sourceOrdinal, c);

  /** Coverage gate: read a case's prompt and count the friendly deaths missing
   * from it, against the ground-truth manifest for that source ordinal.
   * Returns null = cannot adjudicate (manifest missing, or that match has no
   * friendly deaths, so the gate has no jurisdiction). */
  const gateMissingCount = async (
    caseId: string,
    sourceOrdinal: number,
  ): Promise<{ missing: number; total: number } | null> => {
    const manifestFile = path.join(
      baseDir,
      "manifests",
      `${String(sourceOrdinal).padStart(3, "0")}.json`,
    );
    if (!(await fs.pathExists(manifestFile))) {
      console.warn(
        `WARNING: no coverage manifest at ${manifestFile} — sufficiency det-gate cannot run for ordinal ${sourceOrdinal}. Rebuild the corpus (buildCorpus writes manifests/NNN.json).`,
      );
      return null;
    }
    const coverage = (await fs.readJson(manifestFile)) as CoverageManifest;
    const total = coverage.deaths.filter(
      (d) => d.reaction === "friendly",
    ).length;
    // No friendly deaths → removed-deaths only deleted enemy lines, so the
    // gate has no jurisdiction here.
    if (total === 0) return null;
    const promptText = await fs.readFile(
      path.join(suiteDir, "cases", caseId, "prompt.txt"),
      "utf8",
    );
    const result = checkFriendlyDeaths(promptText.split("\n"), coverage);
    return { missing: result.missing.length, total };
  };

  interface PairResult {
    caseId: string;
    perturbation: string;
    dimension: string;
    sourceOrdinal: number;
    originalScore: number | null;
    perturbedScore: number | null;
    detected: boolean | null; // null = unscoreable
    /** Why an otherwise-lowered case was still not counted, for the report. */
    missReason: "floor" | "specificity" | "det-gate" | null;
    maxUntargetedDrift: number | null;
    /** Name of the untargeted dimension that drifted the most — named in the
     * report so nobody has to diff score files by hand. */
    driftDimension: string | null;
    detail: string;
  }
  const pairs: PairResult[] = [];

  for (const c of manifest.cases) {
    if (c.perturbation === "none" || !c.targetDimension) continue;
    const original = originals.get(c.sourceOrdinal);
    const originalScore = original ? scores.get(original.caseId) : undefined;
    const perturbedScore = scores.get(c.caseId);
    const orig = originalScore
      ? dimensionScore(originalScore, c.targetDimension)
      : null;
    const pert = perturbedScore
      ? dimensionScore(perturbedScore, c.targetDimension)
      : null;

    if (DET_GATE_DIMENSIONS.has(c.targetDimension)) {
      // Adjudicated by the deterministic coverage gate: the original must be
      // clean and the perturbed one must report a gap. Judge blind scores
      // (orig/pert) are still recorded, for display only — they have no say
      // here (eval-ab.md).
      const origGate = original
        ? await gateMissingCount(original.caseId, c.sourceOrdinal)
        : null;
      const pertGate = await gateMissingCount(c.caseId, c.sourceOrdinal);
      const scoreable = origGate !== null && pertGate !== null;
      const detected = scoreable
        ? origGate.missing === 0 && pertGate.missing > 0
        : null;
      pairs.push({
        caseId: c.caseId,
        perturbation: c.perturbation,
        dimension: c.targetDimension,
        sourceOrdinal: c.sourceOrdinal,
        originalScore: orig,
        perturbedScore: pert,
        detected,
        missReason: detected === false ? "det-gate" : null,
        maxUntargetedDrift: null,
        driftDimension: null,
        detail: scoreable
          ? `${c.perturbationDetail} | det-gate: original missing ${origGate.missing}/${origGate.total}, perturbed missing ${pertGate.missing}/${pertGate.total}`
          : `${c.perturbationDetail} | det-gate unscoreable (no manifest or no friendly deaths)`,
      });
      continue;
    }

    let detected: boolean | null = null;
    let missReason: "floor" | "specificity" | null = null;
    let maxUntargetedDrift: number | null = null;
    let driftDimension: string | null = null;

    if (orig !== null && pert !== null && originalScore && perturbedScore) {
      // (1) Sensitivity: the targeted dimension must drop by at least the floor.
      const targetedDrop = orig - pert;
      const sensitive = targetedDrop >= deltaFloor;

      // (2) Specificity: the UNtargeted dimensions must stay within tolerance.
      // A judge that also moves orthogonal dimensions is reacting to "the text
      // changed", not to the planted defect — so it earns no credit here. The
      // control (none) case defines which dimensions must be present; if the
      // perturbed case OMITS one, we cannot confirm it stayed put — that
      // incompleteness is itself a specificity violation, not a free pass.
      const untargeted = new Set<string>(scoredDimensions(originalScore));
      untargeted.delete(c.targetDimension);
      const exempt = new Set<string>(
        COUPLED_BY_CONSTRUCTION[c.perturbation] ?? [],
      );
      let drift = 0;
      let specificityViolated = false;
      for (const d of untargeted) {
        if (exempt.has(d)) continue; // coupled by construction — see COUPLED_BY_CONSTRUCTION
        // Dimensions adjudicated by the deterministic gate (sufficiency) take
        // no part in the specificity check: their judge blind scores carry no
        // authority any more, so their wobble must not drag other dimensions
        // into "undetected". det3 measured it as the biggest leak source — of
        // the 6 specificity misses across six dimensions, 4 had sufficiency as
        // the drifting dimension (judge-variance-v3 §7ter). Enabled 2026-07-22
        // once the premise held (the coverage gate adjudicates that dimension
        // independently).
        if (DET_GATE_DIMENSIONS.has(d)) continue;
        const od = dimensionScore(originalScore, d);
        const pd = dimensionScore(perturbedScore, d);
        if (od === null) continue; // not part of the control baseline
        if (pd === null) {
          specificityViolated = true; // untargeted dim dropped from the output
          continue;
        }
        const delta = Math.abs(od - pd);
        if (delta > drift) {
          drift = delta;
          driftDimension = d;
        }
        if (delta > specificityTol) specificityViolated = true;
      }
      maxUntargetedDrift = drift;

      detected = sensitive && !specificityViolated;
      if (!detected) missReason = !sensitive ? "floor" : "specificity";
    }

    pairs.push({
      caseId: c.caseId,
      perturbation: c.perturbation,
      dimension: c.targetDimension,
      sourceOrdinal: c.sourceOrdinal,
      originalScore: orig,
      perturbedScore: pert,
      detected,
      missReason,
      maxUntargetedDrift,
      driftDimension,
      detail: c.perturbationDetail,
    });
  }

  const byDimension = new Map<string, PairResult[]>();
  for (const p of pairs) {
    const list = byDimension.get(p.dimension) ?? [];
    list.push(p);
    byDimension.set(p.dimension, list);
  }

  const lines: string[] = [];
  lines.push("# Judge Calibration Report");
  lines.push("");
  lines.push(
    `**Generated:** ${new Date().toISOString().slice(0, 10)} | **Seed:** ${manifest.seed} | **Pass threshold:** ${passThreshold} | **Min pairs:** ${minPairs} | **Delta floor:** ${deltaFloor} | **Specificity tol:** ${specificityTol}`,
  );
  lines.push("");
  lines.push(
    "A pair is *detected* only when the judge (a) scored the perturbed variant lower than the",
  );
  lines.push(
    `unmodified original on the targeted dimension by at least ${deltaFloor} (sensitivity), AND (b) kept every`,
  );
  lines.push(
    `other dimension within ${specificityTol} of the original (specificity). A dimension with fewer than`,
  );
  lines.push(
    `${minPairs} scoreable pairs is INSUFFICIENT: too few trials to certify. Undetected or insufficient`,
  );
  lines.push(
    "dimensions mean the judge's scores there carry no trustworthy signal.",
  );
  lines.push("");
  lines.push(
    "**sufficiency is adjudicated by the deterministic coverage gate** (checkFriendlyDeaths",
  );
  lines.push(
    "against the ground-truth manifest), not by judge blind scores — the judge structurally",
  );
  lines.push(
    "cannot see what the builder omitted (BACKLOG 14.2, five independent measurements).",
  );
  lines.push(
    "Judge scores for sufficiency pairs are shown for reference only.",
  );
  lines.push("");
  lines.push(
    "| Dimension | Perturbation | Pairs | Detected | Rate | Verdict |",
  );
  lines.push(
    "| --------- | ------------ | ----- | -------- | ---- | ------- |",
  );

  let anyFail = false;
  const dimIssues: { dimension: string; reason: string }[] = [];
  for (const [dimension, list] of [...byDimension.entries()].sort()) {
    const scoreable = list.filter((p) => p.detected !== null);
    const detected = scoreable.filter((p) => p.detected === true).length;
    const rate = scoreable.length > 0 ? detected / scoreable.length : 0;
    const verdict =
      scoreable.length === 0
        ? "NO DATA"
        : scoreable.length < minPairs
          ? "INSUFFICIENT"
          : rate >= passThreshold
            ? "PASS"
            : "FAIL";
    if (verdict !== "PASS") anyFail = true;
    if (verdict === "NO DATA" || verdict === "INSUFFICIENT")
      dimIssues.push({
        dimension,
        reason: `${verdict}: only ${scoreable.length} scoreable pair(s), need >= ${minPairs}`,
      });
    const perturbationLabel = DET_GATE_DIMENSIONS.has(dimension)
      ? `${list[0].perturbation} (det-gate)`
      : list[0].perturbation;
    lines.push(
      `| ${dimension} | ${perturbationLabel} | ${scoreable.length} | ${detected} | ${(rate * 100).toFixed(0)}% | ${verdict} |`,
    );
  }

  lines.push("");
  lines.push("## Pair Detail");
  lines.push("");
  lines.push(
    "| Dimension | Source | Original | Perturbed | maxΔother | 漂移维 | Detected | Injected defect |",
  );
  lines.push(
    "| --------- | ------ | -------- | --------- | --------- | -------- | --------------- |",
  );
  for (const p of pairs) {
    const detectedCell =
      p.detected === null
        ? "unscored"
        : p.detected
          ? "yes"
          : p.missReason === "specificity"
            ? "**NO (spec)**"
            : p.missReason === "det-gate"
              ? "**NO (det-gate)**"
              : "**NO**";
    lines.push(
      `| ${p.dimension} | ${String(p.sourceOrdinal).padStart(3, "0")} | ${p.originalScore ?? "—"} | ${p.perturbedScore ?? "—"} | ${p.maxUntargetedDrift ?? "—"} | ${p.driftDimension ?? "—"} | ${detectedCell} | ${p.detail} |`,
    );
  }
  lines.push("");
  lines.push(
    anyFail
      ? "**Verdict: FAIL — do not trust judge scores on the failing dimensions until the judge prompt/rubric is fixed and this suite passes.**"
      : "**Verdict: PASS — the judge detects all planted defect classes at or above threshold.**",
  );
  lines.push("");

  const reportPath = path.join(
    suiteDir,
    scoresSubdir === "scores"
      ? "calibration-report.md"
      : `calibration-report-${scoresSubdir}.md`,
  );
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  console.log(`\nReport written to ${reportPath}`);

  // Collect failures: undetected perturbed cases, plus dimensions with too few trials.
  const failures: { caseId: string; dimension: string; reason: string }[] = [];
  for (const p of pairs) {
    if (p.detected === false) {
      const why =
        p.missReason === "specificity"
          ? `also moved or dropped untargeted dimensions (maxΔother ${p.maxUntargetedDrift} on ${p.driftDimension ?? "?"}) — reacted to the change, not the defect`
          : p.missReason === "det-gate"
            ? `deterministic coverage gate did not flag the perturbed prompt (or flagged the original) — see pair detail`
            : `targeted score did not drop by >= ${deltaFloor}`;
      failures.push({
        caseId: p.caseId,
        dimension: p.dimension,
        reason: `Judge did not detect ${p.perturbation} (original ${p.originalScore}, perturbed ${p.perturbedScore}): ${why}`,
      });
    }
  }
  for (const issue of dimIssues) {
    failures.push({
      caseId: "",
      dimension: issue.dimension,
      reason: issue.reason,
    });
  }

  return { pass: !anyFail, failures };
}
