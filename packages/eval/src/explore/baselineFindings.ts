/**
 * Baseline findings → review cards: reads the product's persisted AI
 * analysis cache off disk (plain JSON, no `@gladlog/desktop` import — see the
 * plan's global constraint) and converts its `Finding[]` into the review
 * workbench's card shape (`ReviewCard` minus `cardId`/prescreen verdicts,
 * which a later task assigns).
 *
 * Envelope parsing intentionally re-implements the tiny subset of
 * `packages/desktop/src/shared/analysisSlots.ts`'s `toSlottedDoc`/
 * `resolveActiveSlot` logic this module needs (v2: `slots[lastSlotKey].result`;
 * v1/legacy: `.result` directly) rather than importing it — eval never
 * imports `@gladlog/desktop`, and this is envelope bookkeeping, not a
 * CLAUDE.md shared-predicate fact (HP/distance/LoS/time), so re-deriving it
 * here is not the kind of duplication that rule forbids.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CandidateEvent,
  extractCandidateFindings,
  type Finding,
  toRenderSecond,
} from "@gladlog/analysis";
import type { ICombatUnit } from "@gladlog/parser-compat";

import type { EvidenceRef, ReviewCard } from "./reviewTypes";
import type { LegacyRound } from "./storeAccess";

/** Minimal shape this module cares about from a persisted analysis result —
 * real docs carry more (`dropped`, `hadNarration`, …), only `findings`
 * matters here. */
interface StoredAnalysisResult {
  findings?: unknown;
}

/**
 * Reads `<matchesDir>/<matchId>/analysis-v2.<lang>.json` (falling back
 * `lang` → the other language → the bare, unsuffixed legacy filename — same
 * candidate order `analysisCache.ts`'s existing `aggregate()`/`notebook()`
 * scans use), unwraps whichever envelope version is on disk, and returns its
 * findings. Returns `null` when no candidate file exists, is unreadable JSON,
 * or has no recognizable envelope/`findings` array — callers treat "no
 * baseline analysis yet" and "corrupt cache" the same way.
 */
export function readActiveAnalysisResult(
  matchesDir: string,
  matchId: string,
  lang: "zh" | "en" = "zh",
): { findings: Finding[] } | null {
  const base = join(matchesDir, matchId);
  const other = lang === "zh" ? "en" : "zh";
  const candidates = [
    `analysis-v2.${lang}.json`,
    `analysis-v2.${other}.json`,
    "analysis-v2.json",
  ];

  for (const file of candidates) {
    const path = join(base, file);
    if (!existsSync(path)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (raw == null || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    let result: unknown;
    if (
      obj.schemaVersion === 2 &&
      obj.slots &&
      typeof obj.lastSlotKey === "string"
    ) {
      const slots = obj.slots as Record<string, { result?: unknown }>;
      result = slots[obj.lastSlotKey]?.result;
    } else if ("result" in obj) {
      result = obj.result;
    }

    const findings = (result as StoredAnalysisResult | undefined)?.findings;
    if (Array.isArray(findings)) {
      return { findings: findings as Finding[] };
    }
  }
  return null;
}

/** Builds one baseline evidence line's `flow` window and rendered text off a
 * matched `CandidateEvent` — a machine-readable `key=value` dump of its
 * `facts` (the same style `deepDive.ts`'s prompt listing uses for
 * `PackItem`s), since no candidate already renders to natural-language prose
 * anywhere in the repo. */
function candidateEvidence(c: CandidateEvent): EvidenceRef {
  const tt = toRenderSecond(c.t);
  const factsStr = Object.entries(c.facts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const line =
    `${c.type} ${c.unitNames.join(",")}` + (factsStr ? ` {${factsStr}}` : "");
  return { cmd: `flow --from ${tt - 5} --to ${tt + 5}`, line };
}

/**
 * Converts one match's persisted `Finding[]` into baseline review cards
 * (everything but `cardId`, which the session assembler assigns, and
 * prescreen `verdict`s, which Task 5 assigns — `evidence` here is still bare
 * `EvidenceRef[]`).
 *
 * - `claim` = `${title} — ${explanation}`, with `deepDive.text` (when
 *   present) appended as a further paragraph.
 * - `anchorT`/`unitNames` prefer `deepDive.chips` (`min(chips[].t)`, the
 *   union of their `unitNames`); when there are no chips, candidate events
 *   are reconstructed the same way `packages/eval/scripts/deepDiveScan.ts`
 *   does (`extractCandidateFindings(legacy, owner?.id)`, owner resolution
 *   included) and the finding's `eventIds` are matched against them — the
 *   minimum `t` among matches becomes `anchorT` — floored onto the render
 *   grid via `toRenderSecond` per CLAUDE.md's shared-predicate rule, same as
 *   `candidateEvidence`'s `tt` below — their union of `unitNames` becomes
 *   `unitNames`. With neither chips nor a candidate match, `anchorT` is `0`
 *   and `unitNames` is `[]`.
 * - `evidence` is always built from whichever candidate events matched
 *   `eventIds` (independent of which source won the anchor), one
 *   `{ cmd: "flow --from <t-5> --to <t+5>", line }` entry per match (`t`
 *   there is also `toRenderSecond`-floored, so a reviewer re-running the
 *   `cmd` lands on the same window the evidence line was built from). These
 *   are deterministic derivations of the stored finding, not fresh model
 *   claims — the caller marks them `"verified"` outright rather than running
 *   them through the deep-dive prescreen (Task 5 short-circuits on
 *   `source === "baseline"`).
 */
export function baselineToCards(
  findings: Finding[],
  legacy: LegacyRound,
  owner: ICombatUnit | undefined,
): Array<
  Omit<ReviewCard, "cardId" | "evidence"> & { evidence: EvidenceRef[] }
> {
  let candidates: CandidateEvent[] | undefined;
  const getCandidates = (): CandidateEvent[] => {
    if (candidates === undefined) {
      try {
        candidates = extractCandidateFindings(legacy, owner?.id);
      } catch {
        candidates = [];
      }
    }
    return candidates;
  };

  return findings.map((f) => {
    let claim = `${f.title} — ${f.explanation}`;
    if (f.deepDive?.text) claim += `\n\n${f.deepDive.text}`;

    const chips = f.deepDive?.chips ?? [];
    const matched = getCandidates().filter((c) => f.eventIds.includes(c.id));

    let anchorT = 0;
    let unitNames: string[] = [];
    if (chips.length > 0) {
      anchorT = Math.min(...chips.map((c) => c.t));
      unitNames = [...new Set(chips.flatMap((c) => c.unitNames))];
    } else if (matched.length > 0) {
      anchorT = toRenderSecond(Math.min(...matched.map((c) => c.t)));
      unitNames = [...new Set(matched.flatMap((c) => c.unitNames))];
    }

    const evidence = matched.map(candidateEvidence);

    return {
      source: "baseline" as const,
      claim,
      anchorT,
      unitNames,
      evidence,
    };
  });
}
