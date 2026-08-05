/* eslint-disable no-console */
/**
 * promptQualityCheck.ts
 *
 * Deterministic prompt-quality checks against the ground-truth coverage
 * manifests written by buildHealerPromptCorpus.ts. This replaces the LLM judge
 * for the mechanically checkable half of the rubric:
 *
 *   - sufficiency (coverage): every friendly death, and the bulk of CC /
 *     interrupt / dispel / trinket events present in the raw log, must be
 *     visible in the prompt text. The judge cannot see what the builder
 *     dropped — this check can, because the manifest is built from raw parser
 *     events, not from the prompt builder.
 *   - noise: measured duplicate-line ratios and known spam patterns.
 *   - labelBias: severity-lexicon hits with line numbers.
 *
 * It reports MEASURED METRICS only — never 1–5 rubric scores (see the Eval
 * Integrity section of AGENTS.md). The LLM judge stays responsible for the
 * dimensions that need judgment (outcomeAlignment, focusCalibration, …) and
 * reads this tool's output instead of guessing sufficiency/noise on its own.
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:promptQualityCheck
 *   BASE_DIR=packages/tools/local-batch/healer-eval/ab-test/treatment \
 *     npm run -w @wowarenalogs/tools start:promptQualityCheck
 *   STRICT=1 …   # exit 1 if any friendly death is missing from its prompt
 *
 * Expects under BASE_DIR: prompts/, manifests/, index.json.
 */

import fs from "fs-extra";
import path from "path";

import type { IndexEntry } from "../corpus/buildCorpus";
import { CoverageManifest } from "./coverageManifest";

/** The single predicate for "a death-related line". The calibration's
 * removed-deaths perturbation and the sufficiency coverage gate here must use
 * the same regex — the moment the lines the perturbation deletes and the lines
 * the gate looks for drift apart, the calibration is measuring two different
 * things (a gate predicate IS the spec). */
export const DEATH_KEYWORDS = /death|died|dies|killed|\[DEATH\]/i;
const RES_READY_SPAM = /\[RES\] rdy:/;
const BIAS_LEXICON = [
  "[CRITICAL]",
  "[SPIKE]",
  "disastrous",
  "catastrophic",
  "critical failure",
  "fatal mistake",
  "terrible",
  "inexcusable",
  "panicked",
  "huge mistake",
];

// The row shape of index.json is defined by buildCorpus (which writes that
// file); here we only consume it.

interface CoverageResult {
  present: number;
  total: number;
  missing: string[];
}

export interface MatchQuality {
  ordinal: number;
  matchId: string;
  spec: string;
  coverage: {
    friendlyDeaths: CoverageResult;
    ccSpells: CoverageResult;
    interruptSpells: CoverageResult;
    dispels: CoverageResult;
    trinketCasts: CoverageResult;
  };
  noise: {
    totalLines: number;
    approxTokens: number;
    exactDuplicateRatio: number;
    templateDuplicateRatio: number;
    resReadySpamLines: number;
  };
  labelBias: {
    hits: { term: string; count: number; sampleLines: number[] }[];
    totalHits: number;
  };
  hardFailures: string[];
}

interface NamedEvent {
  spellId: string | null;
  spellName: string | null;
  spellNameEn: string | null;
}

/** An event counts as covered if EITHER its logged (localized) name or its
 * canonical English name appears in the prompt — non-EN logs carry localized
 * names while the builder renders English from static data. */
export function checkSpells(
  promptText: string,
  events: NamedEvent[],
): CoverageResult {
  const distinct = new Map<string, string[]>();
  for (const e of events) {
    const candidates = [e.spellName, e.spellNameEn].filter(
      (n): n is string => !!n && n.length > 0,
    );
    if (candidates.length === 0) continue;
    distinct.set(e.spellId ?? candidates[0], candidates);
  }
  const missing: string[] = [];
  for (const [, candidates] of distinct) {
    if (!candidates.some((name) => promptText.includes(name))) {
      missing.push(candidates[candidates.length - 1]);
    }
  }
  return {
    present: distinct.size - missing.length,
    total: distinct.size,
    missing,
  };
}

/** Prompts never print the trinket spell name ("Gladiator's Medallion") — uses
 * are rendered as annotations like "trinketed", "trinket broke this CC", or a
 * "[TRINKET]" marker (status lines like "trinket: ON CD" are not uses). Count
 * use-annotation lines against the manifest's cast count. */
const TRINKET_USE =
  /trinketed|trinket broke|\[(ENEMY )?TRINKET\]|trinket:\s*used/i;

export function checkTrinkets(
  promptLines: string[],
  manifest: CoverageManifest,
): CoverageResult {
  const total = manifest.counts.trinketCasts;
  const mentions = promptLines.filter((l) => TRINKET_USE.test(l)).length;
  const present = Math.min(mentions, total);
  const missing =
    total > present
      ? [`${total - present} of ${total} trinket casts have no use annotation`]
      : [];
  return { present, total, missing };
}

export function checkFriendlyDeaths(
  promptLines: string[],
  manifest: CoverageManifest,
): CoverageResult {
  const friendlyDeaths = manifest.deaths.filter(
    (d) => d.reaction === "friendly",
  );
  const specByName = new Map(manifest.players.map((p) => [p.name, p.spec]));
  const missing: string[] = [];
  for (const death of friendlyDeaths) {
    // Prompts may reference the dead unit by short name ("Looß" from
    // "Looß-Tichondrius-US") or by unit-id + spec label ("1 (Discipline
    // Priest — friendly)") — accept either on a death-keyword line.
    const shortName = death.unitName.split("-")[0];
    const spec = specByName.get(death.unitName);
    const mentioned = promptLines.some(
      (line) =>
        DEATH_KEYWORDS.test(line) &&
        (line.includes(shortName) || (!!spec && line.includes(spec))),
    );
    if (!mentioned) missing.push(`${death.unitName} @ ${death.tRelSec}s`);
  }
  return {
    present: friendlyDeaths.length - missing.length,
    total: friendlyDeaths.length,
    missing,
  };
}

/**
 * Percentile tokens within one line, e.g.
 * `Marksmanship Hunter (n=87): p50 214k | p90 65k`. The number may carry a unit
 * suffix (k/m/s/%); tokens on the same line are only compared when their units
 * match.
 */
const PERCENTILE_TOKEN = /\bp(\d{1,2})\s+(-?\d+(?:\.\d+)?)(k|m|s|%)?/gi;

/**
 * Hard invariant: the percentile sequence within one line must be **monotonically
 * non-decreasing** (p50 ≤ p75 ≤ p90 ≤ p95).
 *
 * In the 2026-07-20 50-match eval, 11 matches showed inverted baselines
 * (`p50 214k | p90 65k`). Root cause: NaN entering the benchmarks sample pool,
 * after which `sort((a,b)=>a-b)` silently left the array unsorted. That class of
 * bug still emits "numbers that look fine" — only the ordering is wrong, which
 * is extremely hard for both the model and a human to spot, while this
 * deterministic check catches every instance without relying on any model
 * judgment.
 *
 * Per "a gate predicate IS the spec": this **re-parses the rendered prompt
 * text** rather than reading the analysis's internal objects. The criterion is
 * anchored on the exact characters the model actually reads.
 */
export function checkPercentileMonotonicity(lines: string[]): string[] {
  const violations: string[] = [];
  lines.forEach((line, i) => {
    const byUnit = new Map<string, { pct: number; value: number }[]>();
    for (const m of line.matchAll(PERCENTILE_TOKEN)) {
      const unit = (m[3] ?? "").toLowerCase();
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit)!.push({ pct: Number(m[1]), value: Number(m[2]) });
    }
    for (const [unit, tokens] of byUnit) {
      if (tokens.length < 2) continue;
      const seq = [...tokens].sort((a, b) => a.pct - b.pct);
      for (let k = 1; k < seq.length; k++) {
        if (seq[k].value < seq[k - 1].value) {
          violations.push(
            `line ${i + 1}: p${seq[k - 1].pct} ${seq[k - 1].value}${unit} > p${seq[k].pct} ${seq[k].value}${unit} — 百分位倒置: ${line.trim()}`,
          );
          break;
        }
      }
    }
  });
  return violations;
}

// "0:27–0:37  [DMG SPIKE]   2(SHunter) (Survival Hunter): 0.88M in 10s (…) (79% -> 29% HP, …)"
const SPIKE_HP =
  /^(\d+):(\d+)–(?:\d+):(?:\d+)\s+\[DMG SPIKE\]\s+(\S+)\s+\([^)]*\):.*?\((\d+)%\s*->\s*(\d+)%\s*HP/;
// "0:15  [YOU] [CD]   Holy Word: Chastise → 6(RPaladin) (68% HP)" — the
// class-C inline HP form
const INLINE_HP = /^(\d+):(\d+)\s+.*?→\s*(\S+)\s*\((\d+)%\s*HP/;
// "0:21  [STATE]   friends 1(HPriest):99 2(SHunter):76 / enemies 4(AWarrior):90"
const STATE_LINE = /^(\d+):(\d+)\s+\[STATE\]\s+(.*)$/;
/** Benign sampling jitter allowed, in percentage points. Anything above this is
 *  treated as two render paths contradicting each other. */
const HP_AGREEMENT_TOLERANCE_PP = 3;

/**
 * Hard invariant: for the same rendered second and the same unit, the HP claimed
 * by `[DMG SPIKE]` must agree with `[STATE]`.
 *
 * Measured on 2026-07-20: before the fix, 26/50 matches carried 33
 * contradictions (median 7pp, max 25pp). Root cause: STATE sampled on whole
 * seconds while DMG SPIKE sampled on fractional seconds, yet both rendered into
 * the same displayed second. Note the wrong turn taken earlier: the "unify the
 * sampling radius" fix moved not a single number — the radius only controls
 * accept/reject, it does not change which sample is picked. The criterion must
 * be anchored on the **rendered text** for the real effect to be measurable.
 */
export function checkSameSecondHpConsistency(lines: string[]): string[] {
  const stateAt = new Map<number, Map<string, number>>();
  for (const line of lines) {
    const m = line.match(STATE_LINE);
    if (!m) continue;
    const units = new Map<string, number>();
    for (const u of m[3].matchAll(/(\S+?):(\d+)\b/g))
      units.set(u[1], Number(u[2]));
    stateAt.set(Number(m[1]) * 60 + Number(m[2]), units);
  }

  const violations: string[] = [];
  lines.forEach((line, i) => {
    // [DMG SPIKE]'s "X% -> Y% HP" (class A) and the inline "→ target (X% HP)"
    // (class C) are two rendered forms of the same invariant and share one
    // criterion.
    const isSpike = line.includes("[DMG SPIKE]");
    const m = isSpike ? line.match(SPIKE_HP) : line.match(INLINE_HP);
    if (!m) return;
    const t = Number(m[1]) * 60 + Number(m[2]);
    const stateHp = stateAt.get(t)?.get(m[3]);
    if (stateHp === undefined) return;
    const claimed = Number(m[4]);
    const delta = Math.abs(stateHp - claimed);
    if (delta > HP_AGREEMENT_TOLERANCE_PP) {
      violations.push(
        `line ${i + 1}: ${m[1]}:${m[2]} ${m[3]} — ${isSpike ? "[DMG SPIKE]" : "行内嵌"} 报 ${claimed}% 而同秒 [STATE] 报 ${stateHp}%(Δ${delta}pp)`,
      );
    }
  });
  return violations;
}

// "2:57–3:15 (19s)" — window endpoints + labelled duration
const WINDOW_SPAN = /(\d+):(\d+)–(\d+):(\d+)\s*\((\d+)s\)/g;

/**
 * Hard invariant: a window's labelled duration must equal the difference of its
 * displayed endpoints.
 *
 * Classes E/G of the 2026-07-20 eval, "window duration doesn't add up":
 * `2:57–3:15 (19s)` — subtracting the displayed timestamps gives 18s while the
 * label says 19s (the label was taken from the un-rounded raw value). The
 * rendered text must be self-consistent, or the same token can be read as two
 * different numbers.
 */
export function checkWindowSpanConsistency(lines: string[]): string[] {
  const violations: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(WINDOW_SPAN)) {
      const from = Number(m[1]) * 60 + Number(m[2]);
      const to = Number(m[3]) * 60 + Number(m[4]);
      const labelled = Number(m[5]);
      if (to - from !== labelled) {
        violations.push(
          `line ${i + 1}: ${m[1]}:${m[2]}–${m[3]}:${m[4]} 相减为 ${to - from}s,却标注 (${labelled}s)`,
        );
      }
    }
  });
  return violations;
}

// "  [1:53] X died — Y had Ironbark available, caster was free"
// "  [2:21] Frost Mage (N) — had Ice Block available, was not CC'd"
const MISSED_OPTION = /^\s*\[(\d+):(\d+)\].*?\bhad ([A-Za-z' :]+?) available/;
// "      [RES] rdy:…  cd:Ironbark(48s),Stampeding Roar(91s),2:Icebound Fortitude(42s)  enemy:…"
// Teammate entries carry an "N:" prefix and charge entries a "[1/2]" suffix;
// both must be stripped.
const RES_CD_BLOCK = /\[RES\].*?\bcd:(\S(?:.*?))(?:\s{2,}|$)/;
/** Ledger entry: optional "N:" ownership prefix (captured) + spell name. No
 *  prefix = it belongs to the log owner. */
const CD_ENTRY = /(?:^|,)\s*(?:(\d+):)?([A-Za-z' :]+?)\s*\(/g;
/** Timestamped line: "1:53  [DEATH] …" */
const LEADING_TIME = /^(\d+):(\d+)\s/;
/** Roster line: '  <unit id="2" name="Ëxørçïsm-Tichondrius-US" spec="…" role="…">' */
const ROSTER_UNIT = /<unit\s+id="(\d+)"\s+name="([^"]+)"/;
/** The two sentence forms of the claimant — names contain non-ASCII characters
 *  and apostrophes (Øxý, Kel'Thuzad), so do not use ASCII character classes. */
const OWNER_DIED_FORM = /\bdied\s*—\s*(\S+)\s+had\b/;
const OWNER_SELF_FORM = /\(([^)]+)\)\s*—\s*had\b/;

/** Roster: character name → numeric id, plus the log owner's id (prefix-less
 *  ledger entries belong to them). */
function parseRoster(lines: string[]): {
  idByName: Map<string, string>;
  ownerId: string | null;
} {
  const idByName = new Map<string, string>();
  let ownerId: string | null = null;
  for (const line of lines) {
    const m = line.match(ROSTER_UNIT);
    if (!m) continue;
    idByName.set(m[2], m[1]);
    if (/role="log owner"/.test(line)) ownerId = m[1];
  }
  return { idByName, ownerId };
}

/**
 * Hard invariant: a cooldown that `DEATHS WITH MISSED OPTIONS` claims was
 * "available" must not simultaneously appear in the `cd:` (on-cooldown) list of
 * the `[RES]` ledger for the same instant.
 *
 * Measured on 2026-07-20 (ord 041): a death at 1:53 where the ledger said
 * `cd:Ironbark(7s)` while MISSED OPTIONS said "had Ironbark available". Root
 * cause: two independently maintained cooldown values for the same spell —
 * `deathOutcomeAnalysis`'s private table said 45s vs the main path's parsed 65s
 * (see the root-cause comment in that file). Fixed by a shared parser; this gate
 * prevents a regression.
 *
 * **The check must carry ownership** (correction from the 2026-07-20 full-corpus
 * audit): the `N:` prefix on a ledger entry says whose spell it is, and an early
 * implementation stripped it and compared by spell name alone — so in a mirror
 * comp (two Paladins on one team) player A's Divine Shield being on cooldown
 * would flag "player B has Divine Shield available" as a contradiction. 6 of the
 * 9 reports over the full corpus came from exactly this (67% false positives).
 * The missed-option line carries a character name while the ledger carries a
 * numeric id; the two are aligned through the roster. When ownership cannot be
 * determined, **report nothing** — a gate that cannot hold its ground is worse
 * than no gate.
 */
export function checkCooldownLedgerConsistency(lines: string[]): string[] {
  const { idByName, ownerId } = parseRoster(lines);

  // The set of on-cooldown spells (with ownership) for each [RES] line, located
  // by the nearest timestamped line above it.
  const onCooldownAt: { atSeconds: number; owned: Set<string> }[] = [];
  let currentSeconds: number | null = null;
  for (const line of lines) {
    const t = line.match(LEADING_TIME);
    if (t) currentSeconds = Number(t[1]) * 60 + Number(t[2]);
    const res = line.match(RES_CD_BLOCK);
    if (!res || currentSeconds === null) continue;
    const owned = new Set<string>();
    for (const e of res[1].matchAll(CD_ENTRY)) {
      // No prefix = the log owner's own cooldown
      const who = e[1] ?? ownerId;
      // Roster missing and entry has no prefix → ownership unknown, excluded
      if (!who) continue;
      owned.add(`${who}|${e[2].trim()}`);
    }
    onCooldownAt.push({ atSeconds: currentSeconds, owned });
  }

  const violations: string[] = [];
  lines.forEach((line, i) => {
    const m = line.match(MISSED_OPTION);
    if (!m) return;
    const claimant =
      line.match(OWNER_DIED_FORM)?.[1] ?? line.match(OWNER_SELF_FORM)?.[1];
    const claimantId = claimant ? idByName.get(claimant) : undefined;
    if (!claimantId) return; // whose spell it is cannot be determined → no report
    const at = Number(m[1]) * 60 + Number(m[2]);
    const spell = m[3].trim();
    // The nearest ledger entry at or before this instant
    let nearest: (typeof onCooldownAt)[number] | undefined;
    for (const entry of onCooldownAt) {
      if (entry.atSeconds > at) continue;
      if (!nearest || entry.atSeconds > nearest.atSeconds) nearest = entry;
    }
    if (nearest?.owned.has(`${claimantId}|${spell}`)) {
      violations.push(
        `line ${i + 1}: ${m[1]}:${m[2]} 声称 ${claimant} 的 "${spell}" available,但同时刻 [RES] 台账把它列在 cd: 中`,
      );
    }
  });
  return violations;
}

// "  - key=p1 kind=hp-snap facts={t0=10, t1=20, unit=Foo, role=owner, hpStart=80}"
// buildDeepDivePrompt's exact item-line rendering (deepDive.ts): `key=`/`kind=`
// are unquoted tokens, `facts={...}` is a `, `-joined `k=v` list. Values never
// contain a literal ", " themselves — enumerated lists (cd-ledger's ready/onCd)
// join with the Chinese enumeration comma "、" for exactly this reason — so
// splitting the facts block on ", " is safe.
const SNAPSHOT_ITEM_LINE =
  /^\s*-\s*key=(\S+)\s+kind=(\S+)\s+facts=\{(.*)\}\s*$/;

interface SnapshotItem {
  key: string;
  kind: string;
  facts: Record<string, string>;
}

function parseFactsBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const token of raw.split(", ")) {
    const eq = token.indexOf("=");
    if (eq < 0) continue;
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function parseSnapshotItems(lines: string[]): SnapshotItem[] {
  const items: SnapshotItem[] = [];
  for (const line of lines) {
    const m = line.match(SNAPSHOT_ITEM_LINE);
    if (!m) continue;
    items.push({ key: m[1], kind: m[2], facts: parseFactsBlock(m[3]) });
  }
  return items;
}

/**
 * Hard invariant (moment deep-dive, SDD 2026-08-05 Task 3): a moment snapshot
 * (`kind=hp-snap` / `kind=cd-ledger`) must not contradict the event-driven
 * items sharing the same deep-dive prompt.
 *
 *  - HP agreement: `kind=hp-snap`'s `hpStart`@`t0` / `hpEnd`@`t1` and any
 *    `kind=hp`'s `hp`@`t` are two independently-collected readings of the same
 *    (rendered second, role, unit) fact — same invariant as
 *    `checkSameSecondHpConsistency`, same shared tolerance
 *    (`HP_AGREEMENT_TOLERANCE_PP`; the brief for this check explicitly forbids
 *    re-writing that "3" as a new literal). Keyed on `t|role|unit`, not just
 *    `t|unit` (2026-08-05 final-review I-4 fix): `unit` is the realm-stripped
 *    short name, so a mirror comp can have the same short name on both teams;
 *    `role` (owner/teammate/enemy) separates them. As a further guard, if the
 *    SAME kind reports two different HP values for one `t|role|unit` key —
 *    itself only possible when "unit" is secretly two different real players
 *    — that key is flagged ambiguous and skipped entirely rather than
 *    compared cross-kind (a name collision is textually indistinguishable
 *    from a real inconsistency once the realm suffix is stripped, so this
 *    check declines to guess).
 *  - Cooldown agreement: `kind=cd-ledger`'s `ready` list for a unit must not
 *    be contradicted by a `kind=immunity-available` (checked against `unit`)
 *    or `kind=external-available` (checked against `holder` — the party
 *    claimed to have had the spell ready, not the dying player) claiming that
 *    same unit's spell was available — those two kinds and the ledger both
 *    ultimately read off `cdAvailableAt` (see momentSnapshot.ts /
 *    deathOutcomeAnalysis.ts), so a mismatch means the two collection passes
 *    disagree about the same cooldown state. Compared only when both facts
 *    blocks render the same whole second (2026-08-05 final-review I-3 fix):
 *    cd-ledger samples at the snapshot window's midpoint while
 *    immunity/external-available are judged at the death/event instant, up to
 *    ~10s apart, during which the spell can genuinely change cooldown state —
 *    a unit with no cd-ledger reading at that exact second is skipped rather
 *    than compared against a ready-set sampled at a different time.
 *
 * Returns `[]` when the prompt carries no item lines at all — pre-Task-1/2
 * prompts have no `key=`/`kind=`/`facts=` lines to match, so this is a
 * structural no-op on them, not a special case.
 */
export function checkSnapshotFactsConsistency(promptText: string): string[] {
  const items = parseSnapshotItems(promptText.split("\n"));
  const violations: string[] = [];

  // --- HP agreement between kind=hp-snap and kind=hp ---
  // Keyed on `t|role|unit`, not just `t|unit` (I-4 fix, 2026-08-05 final
  // review): `unit` is the realm-stripped short name (`sn()`), so a mirror
  // comp with the same short name on both sides (one owner/teammate, one
  // enemy) would otherwise collide into one bucket and read as a same-unit
  // HP contradiction when it's really two different real players. `role`
  // (owner/teammate/enemy) is already carried on every hp/hp-snap facts
  // block, so folding it into the key costs nothing and fully separates the
  // cross-team case.
  interface HpPoint {
    t: number;
    role: string;
    unit: string;
    hp: number;
    kind: "hp" | "hp-snap";
    source: string;
  }
  const hpPoints: HpPoint[] = [];
  for (const it of items) {
    if (it.kind === "hp") {
      const t = Number(it.facts.t);
      const hp = Number(it.facts.hp);
      const role = it.facts.role;
      if (it.facts.unit && role && Number.isFinite(t) && Number.isFinite(hp)) {
        hpPoints.push({
          t,
          role,
          unit: it.facts.unit,
          hp,
          kind: "hp",
          source: `${it.key}(hp)`,
        });
      }
    } else if (it.kind === "hp-snap") {
      const unit = it.facts.unit;
      const role = it.facts.role;
      if (!unit || !role) continue;
      const t0 = Number(it.facts.t0);
      const t1 = Number(it.facts.t1);
      if (it.facts.hpStart !== undefined && Number.isFinite(t0)) {
        const hpStart = Number(it.facts.hpStart);
        if (Number.isFinite(hpStart))
          hpPoints.push({
            t: t0,
            role,
            unit,
            hp: hpStart,
            kind: "hp-snap",
            source: `${it.key}(hpStart)`,
          });
      }
      if (it.facts.hpEnd !== undefined && Number.isFinite(t1)) {
        const hpEnd = Number(it.facts.hpEnd);
        if (Number.isFinite(hpEnd))
          hpPoints.push({
            t: t1,
            role,
            unit,
            hp: hpEnd,
            kind: "hp-snap",
            source: `${it.key}(hpEnd)`,
          });
      }
    }
  }
  const byInstant = new Map<string, HpPoint[]>();
  for (const p of hpPoints) {
    const k = `${p.t}|${p.role}|${p.unit}`;
    if (!byInstant.has(k)) byInstant.set(k, []);
    byInstant.get(k)!.push(p);
  }
  for (const pts of byInstant.values()) {
    // Same-name-collision self-check (I-4): if the SAME kind reports more
    // than one distinct HP value for this exact (t, role, unit) key, that is
    // a textually-detectable sign that "unit" is actually two different real
    // players sharing a short name (the collector reads one real unit
    // deterministically, so two disagreeing same-kind readings can't both be
    // genuine re-samples of one player). Treat the whole key as ambiguous
    // and skip the cross-kind comparison entirely rather than report a
    // false contradiction.
    const byKind = new Map<string, Set<number>>();
    for (const p of pts) {
      const set = byKind.get(p.kind) ?? new Set<number>();
      set.add(p.hp);
      byKind.set(p.kind, set);
    }
    const ambiguous = [...byKind.values()].some((set) => set.size > 1);
    if (ambiguous) continue;

    for (let i = 1; i < pts.length; i++) {
      const delta = Math.abs(pts[i].hp - pts[0].hp);
      if (delta > HP_AGREEMENT_TOLERANCE_PP) {
        violations.push(
          `${pts[0].source} 与 ${pts[i].source} 同秒(${pts[0].t}s)同单位(${pts[0].unit})HP 不一致:${pts[0].hp}% vs ${pts[i].hp}%(Δ${delta}pp)`,
        );
      }
    }
  }

  // --- cd-ledger ready list vs immunity-available / external-available ---
  // Keyed on `floor(t)|unit` (I-3 fix, 2026-08-05 final review): cd-ledger is
  // sampled at the snapshot window's midpoint while immunity/external-available
  // are judged at the death/event instant — those can be ~10s apart, during
  // which the spell can genuinely go on/off cooldown, so comparing across
  // different rendered seconds is comparing two different truths. Only
  // compare when both facts blocks render the same whole second; a unit with
  // no cd-ledger reading at that exact second is skipped rather than compared
  // against a ready-set sampled at some other time.
  const readyByUnitAtSecond = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.kind !== "cd-ledger" || !it.facts.unit || it.facts.t === undefined)
      continue;
    const t = Math.floor(Number(it.facts.t));
    if (!Number.isFinite(t)) continue;
    const ready = (it.facts.ready ?? "")
      .split("、")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "无");
    const key = `${t}|${it.facts.unit}`;
    const set = readyByUnitAtSecond.get(key) ?? new Set<string>();
    for (const r of ready) set.add(r);
    readyByUnitAtSecond.set(key, set);
  }
  for (const it of items) {
    if (it.kind === "immunity-available") {
      const unit = it.facts.unit;
      const spell = it.facts.spell;
      const t =
        unit && it.facts.t !== undefined ? Math.floor(Number(it.facts.t)) : NaN;
      if (!unit || !spell || !Number.isFinite(t)) continue;
      const ready = readyByUnitAtSecond.get(`${t}|${unit}`);
      if (ready && !ready.has(spell)) {
        violations.push(
          `${it.key} kind=immunity-available 声称 ${unit} 的 "${spell}" 可用,但同秒(${t}s)cd-ledger 未把它列入 ${unit} 的 ready 中`,
        );
      }
    } else if (it.kind === "external-available") {
      const holder = it.facts.holder;
      const spell = it.facts.spell;
      const t =
        holder && it.facts.t !== undefined
          ? Math.floor(Number(it.facts.t))
          : NaN;
      if (!holder || !spell || !Number.isFinite(t)) continue;
      const ready = readyByUnitAtSecond.get(`${t}|${holder}`);
      if (ready && !ready.has(spell)) {
        violations.push(
          `${it.key} kind=external-available 声称 ${holder} 的 "${spell}" 可用,但同秒(${t}s)cd-ledger 未把它列入 ${holder} 的 ready 中`,
        );
      }
    }
  }

  return violations;
}

export function duplicateRatio(
  lines: string[],
  normalize: (line: string) => string,
): number {
  const nonEmpty = lines.map(normalize).filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const line of nonEmpty) counts.set(line, (counts.get(line) ?? 0) + 1);
  let duplicated = 0;
  for (const count of counts.values()) if (count > 1) duplicated += count - 1;
  return Math.round((duplicated / nonEmpty.length) * 1000) / 1000;
}

export function checkMatch(
  entry: IndexEntry,
  promptText: string,
  manifest: CoverageManifest,
): MatchQuality {
  const lines = promptText.split("\n");

  const friendlyDeaths = checkFriendlyDeaths(lines, manifest);
  const coverage = {
    friendlyDeaths,
    ccSpells: checkSpells(promptText, manifest.ccApplied),
    interruptSpells: checkSpells(promptText, manifest.interrupts),
    dispels: checkSpells(promptText, manifest.dispels),
    trinketCasts: checkTrinkets(lines, manifest),
  };

  const labelHits = BIAS_LEXICON.map((term) => {
    const needle = term.toLowerCase();
    const sampleLines: number[] = [];
    let count = 0;
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(needle)) {
        count++;
        if (sampleLines.length < 5) sampleLines.push(i + 1);
      }
    });
    return { term, count, sampleLines };
  }).filter((h) => h.count > 0);

  const hardFailures: string[] = [];
  if (friendlyDeaths.missing.length > 0) {
    hardFailures.push(
      `friendly death(s) absent from prompt: ${friendlyDeaths.missing.join(", ")}`,
    );
  }
  hardFailures.push(...checkPercentileMonotonicity(lines));
  hardFailures.push(...checkSameSecondHpConsistency(lines));
  hardFailures.push(...checkWindowSpanConsistency(lines));
  hardFailures.push(...checkCooldownLedgerConsistency(lines));
  hardFailures.push(...checkSnapshotFactsConsistency(promptText));

  return {
    ordinal: entry.ordinal,
    matchId: entry.matchId,
    spec: entry.spec,
    coverage,
    noise: {
      totalLines: lines.length,
      approxTokens: Math.round(promptText.length / 4),
      exactDuplicateRatio: duplicateRatio(lines, (l) => l),
      templateDuplicateRatio: duplicateRatio(lines, (l) =>
        l.replace(/\d+(\.\d+)?/g, "#"),
      ),
      resReadySpamLines: lines.filter((l) => RES_READY_SPAM.test(l)).length,
    },
    labelBias: {
      hits: labelHits,
      totalHits: labelHits.reduce((sum, h) => sum + h.count, 0),
    },
    hardFailures,
  };
}

function coveragePct(r: CoverageResult): string {
  if (r.total === 0) return "  n/a";
  return `${String(Math.round((r.present / r.total) * 100)).padStart(4)}%`;
}

export async function main(): Promise<void> {
  const baseDir = process.env.BASE_DIR ?? "";
  const strict = process.env.STRICT === "1";

  if (!baseDir) {
    console.error(
      "BASE_DIR environment variable is not set. Please set BASE_DIR or use --run with GLADLOG_EVAL_HOME.",
    );
    process.exit(1);
  }

  const indexFile = path.join(baseDir, "index.json");
  if (!(await fs.pathExists(indexFile))) {
    console.error(`No index.json under ${baseDir} — build a corpus first.`);
    process.exit(1);
  }
  const entries = (await fs.readJson(indexFile)) as IndexEntry[];
  const manifestsDir = path.join(baseDir, "manifests");
  if (!(await fs.pathExists(manifestsDir))) {
    console.error(
      `No manifests/ under ${baseDir}. Rebuild the corpus (the builder now writes manifests/NNN.json).`,
    );
    process.exit(1);
  }

  const results: MatchQuality[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const ordinalStr = String(entry.ordinal).padStart(3, "0");
    const promptPath = path.join(baseDir, entry.file);
    const manifestPath = path.join(manifestsDir, `${ordinalStr}.json`);
    if (
      !(await fs.pathExists(promptPath)) ||
      !(await fs.pathExists(manifestPath))
    ) {
      console.warn(`  ${ordinalStr}: prompt or manifest missing, skipping`);
      skipped++;
      continue;
    }
    const promptText = await fs.readFile(promptPath, "utf8");
    const manifest = (await fs.readJson(manifestPath)) as CoverageManifest;
    results.push(checkMatch(entry, promptText, manifest));
  }

  const reportPath = path.join(baseDir, "quality-report.json");
  await fs.writeJson(
    reportPath,
    {
      generatedAt: new Date().toISOString(),
      baseDir,
      skipped,
      results,
    },
    {
      spaces: 2,
    },
  );

  console.log(
    `\nPrompt quality check — ${results.length} match(es), ${skipped} skipped`,
  );
  console.log(
    "ord  deaths   cc    kicks  disp  trink  dupEx  dupTmpl  resSpam  biasHits",
  );
  for (const r of results) {
    console.log(
      [
        String(r.ordinal).padStart(3, "0"),
        coveragePct(r.coverage.friendlyDeaths),
        coveragePct(r.coverage.ccSpells),
        coveragePct(r.coverage.interruptSpells),
        coveragePct(r.coverage.dispels),
        coveragePct(r.coverage.trinketCasts),
        r.noise.exactDuplicateRatio.toFixed(3).padStart(6),
        r.noise.templateDuplicateRatio.toFixed(3).padStart(7),
        String(r.noise.resReadySpamLines).padStart(7),
        String(r.labelBias.totalHits).padStart(8),
      ].join("  "),
    );
  }

  const failures = results.filter((r) => r.hardFailures.length > 0);
  if (failures.length > 0) {
    console.log(`\nHARD FAILURES (${failures.length} match(es)):`);
    for (const f of failures) {
      for (const msg of f.hardFailures)
        console.log(
          `  ${String(f.ordinal).padStart(3, "0")} ${f.matchId}: ${msg}`,
        );
    }
  } else {
    console.log("\nNo hard failures (all friendly deaths present in prompts).");
  }
  console.log(`\nFull report: ${reportPath}`);

  if (strict && failures.length > 0) process.exit(1);
}
