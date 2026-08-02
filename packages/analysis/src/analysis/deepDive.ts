import { CombatUnitReaction } from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../utils/dispelAnalysis";
import { analyzePlayerCCAndTrinket } from "../utils/ccTrinketAnalysis";
import { buildDeathOutcomeSummary } from "../utils/deathOutcomeAnalysis";
import {
  annotateDefensiveTimings,
  DEFENSIVE_TAGS,
  extractMajorCooldowns,
  fmtTime,
  isHealerSpec,
  isMeleeSpec,
  type IMajorCooldownInfo,
} from "../utils/cooldowns";
import { reconstructEnemyCDTimeline } from "../utils/enemyCDs";
import {
  analyzeBurstLedger,
  type IBurstLedgerEntry,
} from "../utils/burstLedger";
import {
  analyzeOutgoingCCChains,
  type IOutgoingCCChain,
} from "../utils/drAnalysis";
import { getHpPercentAtTime } from "../utils/killWindowTargetSelection";
import {
  computeOwnerPositionEvents,
  POSITION_MISTAKES,
  stayedInHadRealCost,
} from "../utils/positionAnalysis";
import { causalLint } from "./causalLint";
import { fmtFactNum as fmt } from "./factFormat";
import { repairSpellNameZh } from "./spellNameZhLint";
import {
  claimChecker,
  extractPlaceholderKeys,
  interpolate,
} from "../compare/claimChecker";
import type { CandidateEvent, Finding } from "./types";

/** Deep-dive round (automatic follow-up): max findings to deepen per match (highest severity first). */
export const DEEP_DIVE_MAX = 2;
/** Evidence-pack window: seconds before/after the finding's anchor moment. */
export const PACK_BEFORE_S = 30;
export const PACK_AFTER_S = 10;
/** Evidence-pack item cap (truncated in time order to keep the prompt from bloating). */
const PACK_MAX_ITEMS = 14;

/** Short name (realm stripped): used for names inside facts — realms often contain
 * digits (Area52) and would trip the bare-number audit if written into prose;
 * chips' unitNames keep the full name for replay lookup. */
const sn = (name: string) => name.split("-")[0] ?? name;

export interface PackItem {
  /** Placeholder namespace (p1, p2, …): narrative references it as {{p1.t}}. */
  key: string;
  kind:
    | "cc"
    | "defensive"
    | "enemy-cd"
    | "hp"
    | "dispel"
    | "external-available"
    | "immunity-available"
    | "position"
    | "target-hp"
    | "enemy-defensive"
    | "immunity"
    | "our-cc"
    | "our-cd"
    | "off-target"
    | "dr-clip";
  /** Relative seconds (chip jump anchor). */
  t: number;
  /** Chip text. */
  label: string;
  unitNames: string[];
  /**
   * Spell id (string). Display only: the UI looks up SPELL_ICONS_GENERATED
   * for the icon. Same nature as CandidateEvent.spellId — never enters the
   * prompt or facts, not subject to gate audits. Items with no single spell
   * (HP, off-target, DR clip) legitimately leave it empty.
   */
  spellId?: string;
  facts: Record<string, string>;
}

/** Offensive kind set (single source): the offensive subset of `PackItem.kind`.
 * The prompt legend gate and any future "is this an offensive item" check read
 * from here — don't re-list the string array elsewhere (it would drift from the union type). */
export const OFFENSIVE_KINDS = new Set<PackItem["kind"]>([
  "target-hp",
  "enemy-defensive",
  "immunity",
  "our-cc",
  "our-cd",
  "off-target",
  "dr-clip",
]);

export interface DeepDivePack {
  findingIndex: number;
  anchorFrom: number;
  anchorTo: number;
  items: PackItem[];
  /** All item facts, key = `${item.key}.${field}` (used by claimChecker). */
  facts: Record<string, string>;
}

/** User-selected window (#16): [fromS, toS] used as-is (clamped to [0, durS]),
 * without the finding-anchor-style -30/+10 padding — what the user framed is what they want to see. */
export interface WindowOverride {
  fromS: number;
  toS: number;
}

/**
 * Deep-dive evidence pack (deterministic expansion): around the time window
 * [minT-30, maxT+10] of the events the finding references, pull details the
 * first-round menu left out — CC taken / defensive casts / enemy offensive
 * CDs / HP trajectory / dispels — from existing predicates. All numbers go
 * into facts; the narrative may only reference them via placeholders
 * (predicate single-source: no new facts computed, only a different framing).
 */
export function buildDeepDivePack(
  combat: any,
  finding: Finding,
  findingIndex: number,
  candidates: CandidateEvent[],
  ownerName?: string,
  /** User-selected window (#16): use the override as-is (clamped to [0, durS]),
   * no -30/+10 padding — what the user framed is what they want to see; in
   * this mode finding.eventIds is not relied on. */
  windowOverride?: WindowOverride,
): DeepDivePack | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ts = (finding.eventIds ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is CandidateEvent => !!c && Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.t);
  if (!windowOverride && ts.length === 0) return null; // whole-match observations have no anchor — don't deep-dive
  const durS = ((combat?.endTime ?? 0) - (combat?.startTime ?? 0)) / 1000;
  const anchorFrom = windowOverride
    ? Math.max(0, windowOverride.fromS)
    : Math.max(0, Math.min(...ts) - PACK_BEFORE_S);
  const anchorTo = windowOverride
    ? Math.min(durS, windowOverride.toS)
    : Math.min(durS, Math.max(...ts) + PACK_AFTER_S);
  const inWin = (t: number) => t >= anchorFrom && t <= anchorTo;

  const units = Object.values(combat?.units ?? {}) as any[];
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return null;
  // role tag (fix 2): owner = the person being coached, coaching lands on them first; teammate/enemy are background only.
  const friendlyRole = (fullName: string) =>
    ownerName && fullName === ownerName ? "owner" : "teammate";
  const petsOf = (side: any[]) => {
    const ids = new Set(side.map((u) => u.id));
    return units.filter((u) => u.ownerId && ids.has(u.ownerId));
  };
  const enemyPets = petsOf(enemies);
  const friendlyPets = petsOf(friends);
  const ownerUnit = ownerName
    ? friends.find((u) => u.name === ownerName)
    : undefined;
  // Positioning analysis (fix 3) reuses the owner's CC/CD summaries, captured in passing in the loops — no recompute.
  let ownerCcSummary: ReturnType<typeof analyzePlayerCCAndTrinket> | undefined;
  let ownerCds: IMajorCooldownInfo[] | undefined;

  const raw: Omit<PackItem, "key">[] = [];

  // CC taken (friendly): CC instances + trinket state.
  // Keep every player's summary in passing — the "available but unused"
  // section's deathOutcome predicate below needs them (to decide whether the
  // external's holder was CC-locked during the death window); no recompute.
  const ccSummaries: ReturnType<typeof analyzePlayerCCAndTrinket>[] = [];
  for (const u of friends) {
    try {
      const s = analyzePlayerCCAndTrinket(u, enemies, combat, enemyPets);
      ccSummaries.push(s);
      if (u === ownerUnit) ownerCcSummary = s;
      for (const cc of s.ccInstances) {
        if (!inWin(cc.atSeconds)) continue;
        raw.push({
          kind: "cc",
          spellId: cc.spellId,
          t: cc.atSeconds,
          label: `${cc.spellName} → ${u.name.split("-")[0]}(${cc.durationSeconds.toFixed(1)}s)`,
          unitNames: [u.name],
          facts: {
            t: fmt(cc.atSeconds),
            spell: cc.spellName,
            unit: sn(u.name),
            role: friendlyRole(u.name),
            duration: cc.durationSeconds.toFixed(1),
            trinket: cc.trinketState,
          },
        });
      }
    } catch {
      /* this category absent */
    }
  }

  // Defensive casts (friendly, with timing audit labels)
  let enemyTl: ReturnType<typeof reconstructEnemyCDTimeline> | null = null;
  // Resolved cooldowns (same source as the [RES] ledger, talent modifiers
  // included) — fed to deathOutcome's availability check, injected the same
  // way as buildMatchContext, so two places never disagree about one cooldown.
  const resolvedCdByUnit = new Map<string, Map<string, number>>();
  for (const u of friends) {
    try {
      enemyTl = enemyTl ?? reconstructEnemyCDTimeline(enemies, combat);
      const cds = annotateDefensiveTimings(
        extractMajorCooldowns(u, combat),
        u,
        combat,
        enemyTl,
      );
      if (u === ownerUnit) ownerCds = cds;
      const bySpell = new Map<string, number>();
      for (const cd of cds) bySpell.set(cd.spellId, cd.cooldownSeconds);
      resolvedCdByUnit.set(u.id, bySpell);
      for (const cd of cds) {
        if (!DEFENSIVE_TAGS.has(cd.tag)) continue;
        for (const cast of cd.casts) {
          if (!inWin(cast.timeSeconds)) continue;
          raw.push({
            kind: "defensive",
            spellId: cd.spellId,
            t: cast.timeSeconds,
            label: `${cd.spellName}(${u.name.split("-")[0]})`,
            unitNames: [u.name],
            facts: {
              t: fmt(cast.timeSeconds),
              spell: cd.spellName,
              unit: sn(u.name),
              role: friendlyRole(u.name),
              ...(cast.timingLabel && cast.timingLabel !== "Unknown"
                ? { timing: cast.timingLabel }
                : {}),
            },
          });
        }
      }
    } catch {
      /* this category absent */
    }
  }

  // Enemy offensive CD casts
  try {
    enemyTl = enemyTl ?? reconstructEnemyCDTimeline(enemies, combat);
    for (const p of enemyTl.players) {
      for (const cd of p.offensiveCDs) {
        if (!inWin(cd.castTimeSeconds)) continue;
        raw.push({
          kind: "enemy-cd",
          spellId: cd.spellId,
          t: cd.castTimeSeconds,
          label: `敌 ${cd.spellName}(${p.playerName.split("-")[0]})`,
          unitNames: [p.playerName],
          facts: {
            t: fmt(cd.castTimeSeconds),
            spell: cd.spellName,
            player: sn(p.playerName),
            role: "enemy",
          },
        });
      }
    }
  } catch {
    /* this category absent */
  }

  // HP trajectory: checkpoints before the anchor for friendly units named by the finding (sampling discipline lives in the helper)
  const focus = friends.filter((u) =>
    (finding.eventIds ?? []).some((id) =>
      byId.get(id)?.unitNames.includes(u.name),
    ),
  );
  // Focus = the last anchor (death/climax moment). Do NOT write it as
  // anchorTo - PACK_AFTER_S: anchorTo has been clamped by durS, and whenever
  // the match ends <PACK_AFTER_S seconds after the anchor (in arena the
  // decisive death is precisely why the match ends — this is the norm, not an
  // edge case), back-computing lands earlier than the true anchor and the HP
  // checkpoints shift forward together with the truncation center (measured:
  // death at 100s / end at 105s → focusT 5s early, all three "HP before
  // death" checkpoints misaligned). The offensive path's focusT uses Math.min
  // (first anchor = the opener) — the two paths have genuinely different
  // semantics; don't force them together. With an override the user window
  // has no natural focus (the finding anchor may be an empty synthetic
  // finding), so the window midpoint is most neutral; check windowOverride
  // BEFORE deciding to compute Math.max(...ts) — with empty ts,
  // Math.max(...[]) is -Infinity.
  const focusT = windowOverride ? (anchorFrom + anchorTo) / 2 : Math.max(...ts);
  for (const u of focus) {
    try {
      // One item per checkpoint: t = real moment (placeholder), hp = health
      // (placeholder). Do not encode the 15/10/5 offsets into key names —
      // that lures the model into writing bare numbers like "15 seconds
      // before death" which the audit then drops (root cause found in the
      // 2026-07-19 discipline smoke test).
      for (const back of [15, 10, 5]) {
        const tPt = focusT - back;
        if (tPt < 0) continue;
        const pct = getHpPercentAtTime(u, tPt, combat.startTime);
        if (pct === null) continue;
        raw.push({
          kind: "hp",
          t: tPt,
          label: `${sn(u.name)} HP ${Math.round(pct)}%`,
          unitNames: [u.name],
          facts: {
            t: fmt(tPt),
            unit: sn(u.name),
            role: friendlyRole(u.name),
            hp: String(Math.round(pct)),
          },
        });
      }
    } catch {
      /* this category absent */
    }
  }

  // Dispels (all priorities)
  try {
    const ds = reconstructDispelSummary(
      friends,
      enemies,
      combat,
      friendlyPets,
      enemyPets,
    );
    for (const e of [...ds.allyCleanse, ...ds.ourPurges]) {
      if (!inWin(e.timeSeconds)) continue;
      raw.push({
        kind: "dispel",
        spellId: e.dispelSpellId,
        t: e.timeSeconds,
        label: `${e.dispelSpellName} 解 ${e.removedSpellName}`,
        unitNames: [e.sourceName, e.targetName],
        facts: {
          t: fmt(e.timeSeconds),
          spell: e.dispelSpellName,
          removed: e.removedSpellName,
          src: sn(e.sourceName),
          tgt: sn(e.targetName),
          role: friendlyRole(e.sourceName),
          priority: e.priority,
        },
      });
    }
  } catch {
    /* this category absent */
  }

  // Available-but-unused (death-anchored): deathOutcome's "should have been
  // given, wasn't" predicate — externals carry four false-positive guards
  // (holder died first / 40yd / LoS / CC-locked), same source as the prompt's
  // DEATHS WITH MISSED OPTIONS block. Previously the deep-dive pack only
  // collected defensives that WERE cast (cd.casts), which locked precisely
  // the most valuable layer of death coaching (Pain Suppression available but
  // not given / Blessing of Protection available but not pressed) out of the
  // follow-up round.
  try {
    const outcome = buildDeathOutcomeSummary(
      { startTime: combat.startTime ?? 0, zoneId: combat.startInfo?.zoneId },
      friends,
      ccSummaries,
      (unit, spellId) => resolvedCdByUnit.get(unit.id)?.get(spellId),
    );
    for (const ev of outcome.events) {
      if (!inWin(ev.atSeconds)) continue;
      for (const imm of ev.availableImmunities) {
        raw.push({
          kind: "immunity-available",
          spellId: imm.spellId,
          t: ev.atSeconds,
          label: `${imm.spellName} 可用未按(${sn(ev.deadPlayer)})`,
          unitNames: [ev.deadPlayer],
          facts: {
            t: fmt(ev.atSeconds),
            spell: imm.spellName,
            unit: sn(ev.deadPlayer),
            role: friendlyRole(ev.deadPlayer),
            inCc: imm.wasInCC ? "yes" : "no",
          },
        });
      }
      for (const ext of ev.missedExternals) {
        raw.push({
          kind: "external-available",
          spellId: ext.spellId,
          t: ev.atSeconds,
          label: `${ext.spellName} 可用未给(${sn(ext.casterName)}→${sn(ev.deadPlayer)})`,
          unitNames: [ext.casterName, ev.deadPlayer],
          facts: {
            t: fmt(ev.atSeconds),
            spell: ext.spellName,
            unit: sn(ev.deadPlayer),
            role: friendlyRole(ev.deadPlayer),
            holder: sn(ext.casterName),
            holderRole: friendlyRole(ext.casterName),
            holderCc: ext.casterWasInCC ? "yes" : "no",
          },
        });
      }
    }
  } catch {
    /* this category absent */
  }

  // Positioning mistakes (fix 3): the owner's STAYED_IN/MISSED_PUSH/CD_OUT_OF_RANGE
  // falling inside the window. Fills the "died to positioning" gap that resource
  // signals can't see (519-match survey: rogue saves 9/40, Havoc 4/9).
  if (ownerUnit && enemyTl) {
    try {
      const posEvents = computeOwnerPositionEvents({
        owner: ownerUnit,
        enemies,
        combat,
        burstWindows: enemyTl.alignedBurstWindows,
        ownerCooldowns: ownerCds ?? [],
        ownerCCSummary: ownerCcSummary,
        isHealer: isHealerSpec(ownerUnit.spec),
        ownerIsMelee: isMeleeSpec(ownerUnit.spec),
        friends,
      });
      for (const e of posEvents) {
        if (!POSITION_MISTAKES.has(e.type)) continue;
        if (!inWin(e.atSeconds)) continue;
        const f: Record<string, string> = {
          t: fmt(e.atSeconds),
          role: "owner",
          kind:
            e.type === "STAYED_IN"
              ? "stayed-in"
              : e.type === "MISSED_PUSH"
                ? "missed-push"
                : "cd-out-of-range",
        };
        if (e.nearestEnemyName) f.enemy = sn(e.nearestEnemyName);
        if (e.dangerLabel) f.threat = e.dangerLabel;
        if (e.type === "STAYED_IN") {
          // hpStart and hpMin come as a pair: the gate judges whether there was
          // a real cost from the start→minimum drop (stayedInHadRealCost), and
          // the model can use it to say "beaten from full HP down to X".
          if (e.ownerHpStartPct != null)
            f.hpStart = String(Math.round(e.ownerHpStartPct));
          if (e.ownerHpMinPct != null)
            f.hpMin = String(Math.round(e.ownerHpMinPct));
          if (e.ownerDefensiveAvailable !== undefined)
            f.defAvail = e.ownerDefensiveAvailable ? "yes" : "no";
        }
        if (e.type === "MISSED_PUSH" && e.startDistanceYards != null)
          f.dist = String(Math.round(e.startDistanceYards));
        if (e.type === "CD_OUT_OF_RANGE" && e.spellName) f.spell = e.spellName;
        const label =
          e.type === "STAYED_IN"
            ? `走位:停留承压`
            : e.type === "MISSED_PUSH"
              ? `走位:脱节`
              : `走位:${e.spellName ?? "大招"}空放`;
        raw.push({
          kind: "position",
          t: e.atSeconds,
          label,
          unitNames: [ownerUnit.name],
          facts: f,
        });
      }
    } catch {
      /* positioning analysis needs advanced logging/geometry; absent otherwise */
    }
  }

  // Truncate by "closeness to the focus moment", not pure time order: dense
  // small events early in the window must not push the key evidence near the
  // death/anchor out of the pack (agy review #4); after selection, re-sort by
  // time for the listing. focusT was declared in the HP section
  // (= last anchor, Math.max(...ts)).
  const items: PackItem[] = raw
    .sort((a, b) => Math.abs(a.t - focusT) - Math.abs(b.t - focusT))
    .slice(0, PACK_MAX_ITEMS)
    .sort((a, b) => a.t - b.t)
    .map((it, i) => ({ ...it, key: `p${i + 1}` }));
  if (items.length === 0) return null;
  // The coachable-signal gate (fix 1) is applied by the caller:
  // hasCoachableSignal(pack.items) → false means skip. The gate lives in the
  // caller, not here — separation of concerns (building the pack vs whether
  // it's worth deepening), and eval can measure before/after along the way.

  const facts: Record<string, string> = {};
  for (const it of items)
    for (const [k, v] of Object.entries(it.facts)) facts[`${it.key}.${k}`] = v;

  return { findingIndex, anchorFrom, anchorTo, items, facts };
}

export interface OffensiveMapInput {
  entries: IBurstLedgerEntry[];
  healerChains: IOutgoingCCChain[];
  candFacts: Record<string, string>[];
  candTypes: string[];
  ownerName?: string;
  inWin: (t: number) => boolean;
}

/** Offensive evidence → PackItem (pure): target HP / enemy defensives+immunities /
 * our CC on the enemy healer / cooldown alignment + type-specific items. */
export function offensivePackItems(
  inp: OffensiveMapInput,
): Omit<PackItem, "key">[] {
  const raw: Omit<PackItem, "key">[] = [];
  const ownerShort = inp.ownerName ? sn(inp.ownerName) : undefined;
  // Full-name comparison (agy review): short names collide cross-realm (same
  // name, different realm) and would misclassify a teammate as owner — same
  // as buildDeepDivePack's friendlyRole: role matches full names only,
  // display still uses short names.
  const role = (name: string) =>
    inp.ownerName && name === inp.ownerName ? "owner" : "teammate";

  for (const e of inp.entries) {
    if (!inp.inWin(e.fromSeconds) && !inp.inWin(e.toSeconds)) continue;
    const t = e.dominantTarget;
    if (t) {
      // Target HP: start (burst begin) + end (burst end), taken from the
      // ledger's already-computed values (predicate single-source).
      if (t.hpStartPct != null && inp.inWin(e.fromSeconds))
        raw.push({
          kind: "target-hp",
          t: e.fromSeconds,
          label: `${sn(t.unitName)} HP`,
          unitNames: [t.unitName],
          facts: {
            t: fmt(e.fromSeconds),
            hp: String(t.hpStartPct),
            unit: sn(t.unitName),
            role: "enemy-target",
          },
        });
      if (t.hpEndPct != null && inp.inWin(e.toSeconds))
        raw.push({
          kind: "target-hp",
          t: e.toSeconds,
          label: `${sn(t.unitName)} HP`,
          unitNames: [t.unitName],
          facts: {
            t: fmt(e.toSeconds),
            hp: String(t.hpEndPct),
            unit: sn(t.unitName),
            role: "enemy-target",
          },
        });
      // Window guard (agy review): these items are anchored at e.fromSeconds,
      // while the outer guard admits the whole entry when EITHER fromSeconds OR
      // toSeconds falls in the window. The extra inWin check stops an item from
      // being stamped with a time outside the window when fromSeconds is out of
      // range (the pack's anchorFrom/anchorTo is a range spelled out in the
      // prompt — item times must never fall outside it).
      if (inp.inWin(e.fromSeconds))
        for (const d of t.defensivesHit) {
          raw.push({
            kind: d.isImmunity ? "immunity" : "enemy-defensive",
            spellId: d.spellId,
            t: e.fromSeconds,
            label: `${d.spellName}(${sn(t.unitName)})`,
            unitNames: [t.unitName],
            facts: {
              t: fmt(e.fromSeconds),
              spell: d.spellName,
              unit: sn(t.unitName),
              role: "enemy",
              ...(d.isImmunity ? { overlap: d.overlapSeconds.toFixed(1) } : {}),
            },
          });
        }
    }
    // Our cooldown alignment (the owner's own spells + overlapping ally CDs)
    for (const s of e.spells)
      if (inp.inWin(s.castTimeSeconds))
        raw.push({
          kind: "our-cd",
          t: s.castTimeSeconds,
          label: `${s.spellName}`,
          unitNames: inp.ownerName ? [inp.ownerName] : [],
          facts: {
            t: fmt(s.castTimeSeconds),
            spell: s.spellName,
            unit: ownerShort ?? "owner",
            role: "owner",
          },
        });
    if (inp.inWin(e.fromSeconds))
      for (const a of e.allyCDsOverlapping)
        raw.push({
          kind: "our-cd",
          t: e.fromSeconds,
          label: `${a.spellName}(${sn(a.playerName)})`,
          unitNames: [a.playerName],
          facts: {
            t: fmt(e.fromSeconds),
            spell: a.spellName,
            unit: sn(a.playerName),
            role: role(a.playerName),
          },
        });
  }

  // Our CC chains on the enemy healer (inside the window)
  for (const chain of inp.healerChains)
    for (const app of chain.applications) {
      if (!inp.inWin(app.atSeconds)) continue;
      raw.push({
        kind: "our-cc",
        spellId: app.spellId,
        t: app.atSeconds,
        label: `${app.spellName} → ${sn(chain.targetName)}`,
        unitNames: [app.casterName],
        facts: {
          t: fmt(app.atSeconds),
          spell: app.spellName,
          unit: sn(chain.targetName),
          caster: sn(app.casterName),
          role: role(app.casterName),
        },
      });
    }

  // Type-specific items (carry over the candidate's own facts; short names)
  inp.candTypes.forEach((type, i) => {
    const cf = inp.candFacts[i] ?? {};
    const tt = Number(cf.t);
    if (type === "off-target-in-window")
      raw.push({
        kind: "off-target",
        t: Number.isFinite(tt) ? tt : 0,
        label: `脱靶`,
        unitNames: [],
        facts: {
          ...(cf.t ? { t: cf.t } : {}),
          role: "owner",
          ...(cf.onTargetPct ? { onTargetPct: cf.onTargetPct } : {}),
          ...(cf.offTarget ? { target: sn(cf.offTarget) } : {}),
        },
      });
    // juked-kick was demoted out of the offensive deep dive (Task 6 A/B: the
    // only one of the 5 types averaging <3.5, combined 2.9, and all four scores
    // of <=2 were it — "read the fake cast, don't kick blindly" is self-evident
    // generic advice, so deepening only bolts context onto it and yields no new
    // insight. It stays a first-round finding, it just isn't deepened). Hence no
    // juked items are produced here.
    if (type === "dr-clipped-cc")
      raw.push({
        kind: "dr-clip",
        t: Number.isFinite(tt) ? tt : 0,
        label: `踩 DR`,
        unitNames: [],
        facts: {
          ...(cf.t ? { t: cf.t } : {}),
          role: "owner",
          ...(cf.spell ? { spell: cf.spell } : {}),
          ...(cf.target ? { target: sn(cf.target) } : {}),
          ...(cf.dr ? { dr: cf.dr } : {}),
        },
      });
  });

  return raw;
}

export function buildOffensiveDeepDivePack(
  combat: any,
  finding: Finding,
  findingIndex: number,
  candidates: CandidateEvent[],
  ownerName?: string,
  /** User-selected window (#16): same as buildDeepDivePack — the override is
   * used as-is and finding.eventIds is not relied on. */
  windowOverride?: WindowOverride,
): DeepDivePack | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const cands = (finding.eventIds ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is CandidateEvent => !!c);
  const ts = cands
    .filter((c) => Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.t);
  if (!windowOverride && ts.length === 0) return null;
  const durS = ((combat?.endTime ?? 0) - (combat?.startTime ?? 0)) / 1000;
  const anchorFrom = windowOverride
    ? Math.max(0, windowOverride.fromS)
    : Math.max(0, Math.min(...ts) - PACK_BEFORE_S);
  const anchorTo = windowOverride
    ? Math.min(durS, windowOverride.toS)
    : Math.min(durS, Math.max(...ts) + PACK_AFTER_S);
  const inWin = (t: number) => t >= anchorFrom && t <= anchorTo;

  const units = Object.values(combat?.units ?? {}) as any[];
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return null;
  const owner = ownerName
    ? friends.find((u) => u.name === ownerName)
    : undefined;
  if (!owner) return null;

  let entries: IBurstLedgerEntry[] = [];
  let healerChains: IOutgoingCCChain[] = [];
  try {
    entries = analyzeBurstLedger(owner, friends, enemies, combat);
  } catch {
    /* no advanced logging */
  }
  try {
    const enemyHealers = new Set(
      enemies.filter((e) => isHealerSpec(e.spec)).map((e) => e.name),
    );
    healerChains = analyzeOutgoingCCChains(friends, enemies, combat).filter(
      (c) => enemyHealers.has(c.targetName),
    );
  } catch {
    /* absent */
  }

  const raw = offensivePackItems({
    entries,
    healerChains,
    candFacts: cands.map((c) => c.facts),
    candTypes: cands.map((c) => c.type),
    ownerName,
    inWin,
  });
  if (raw.length === 0) return null;

  // Truncate by closeness to the focus moment (same logic as the death pack).
  // With an override there is no natural focus (the "opener anchor" notion does
  // not apply), so take the window midpoint; windowOverride MUST be checked
  // first because ts may be empty.
  const focusT = windowOverride ? (anchorFrom + anchorTo) / 2 : Math.min(...ts);
  const items: PackItem[] = raw
    .sort((a, b) => Math.abs(a.t - focusT) - Math.abs(b.t - focusT))
    .slice(0, PACK_MAX_ITEMS)
    .sort((a, b) => a.t - b.t)
    .map((it, i) => ({ ...it, key: `p${i + 1}` }));

  const facts: Record<string, string> = {};
  for (const it of items)
    for (const [k, v] of Object.entries(it.facts)) facts[`${it.key}.${k}`] = v;
  return { findingIndex, anchorFrom, anchorTo, items, facts };
}

/**
 * Coachable signal (fix 1): does the pack contain >=1 "mistake our side could
 * control"? The predicate reads pack facts only, and shares its source with the
 * three death-setup types: defensive pressed early/late, trinket in hand but
 * unused while CC'd, low-priority dispel spent while an enemy major CD is up
 * (wasted GCD). No signal = a clean window, not worth a model round-trip.
 */
export function hasCoachableSignal(items: PackItem[]): boolean {
  const enemyCdInWin = items.some((i) => i.kind === "enemy-cd");
  return items.some((it) => {
    const f = it.facts;
    if (f.role === "enemy") return false; // only our own controllables
    if (
      it.kind === "defensive" &&
      (f.timing === "Early" || f.timing === "Late")
    )
      return true;
    // Only hard CC of >=3s counts as "should have trinketed and didn't": not
    // trinketing micro-CC / interrupts is the norm, not a mistake (measured
    // deterministically over 220 matches: with no duration gate,
    // available_unused fired 242 times — the gate was a no-op).
    if (
      it.kind === "cc" &&
      f.trinket === "available_unused" &&
      Number(f.duration) >= 3
    )
      return true;
    if (it.kind === "dispel" && f.priority === "Low" && enemyCdInWin)
      return true;
    // Available but unused (at a death): the external sat on the owner and the
    // owner was not CC-locked → directly coachable ("Pain Suppression available
    // but not given" is exactly the core healer-coaching scenario). An external
    // held by a teammate is background only and does not open the gate on its
    // own — a mistake the owner could not have covered isn't worth a model
    // round-trip.
    if (it.kind === "external-available")
      return f.holderRole === "owner" && f.holderCc !== "yes";
    // The owner's own immunity available-but-unpressed while not CC-locked →
    // coachable; a teammate's immunity is background only.
    if (it.kind === "immunity-available")
      return f.role === "owner" && f.inCc !== "yes";
    // Positioning mistakes: MISSED_PUSH / a whiffed cooldown are mistakes in
    // themselves and pass straight through; STAYED_IN only counts once a real
    // cost was paid — the predicate is shared with the context formatter's
    // "(no real cost)" label (weekly review P1#1: that place used to claim
    // "STAYED_IN already only fires when HP drops", while the source never
    // filtered by HP at all).
    if (it.kind === "position") {
      if (f.kind !== "stayed-in") return true;
      return stayedInHadRealCost(
        f.hpMin === undefined ? null : Number(f.hpMin),
        f.hpStart === undefined ? null : Number(f.hpStart),
      );
    }
    return false;
  });
}

/** Offensive deep dive: target bottom-out threshold (%); below it plus a
 * (non-immunity) defensive answering = "should have CC'd the healer / swapped". */
const OFFENSIVE_HP_THRESHOLD = 35;

/**
 * Offensive signal (the offensive deep-dive gate): non-death candidates are
 * already pre-curated as mistakes, so the gate is light — it only asks that an
 * offensive story be present. An immunity alone is coachable: dumping burst
 * into an immunity IS the mistake (track enemy immunities, don't force it), and
 * we do NOT also require the target to bottom out — the immunity is precisely
 * what stopped the HP drop, so demanding <=35% on top is self-contradictory
 * (measured over a 519-match scan: with the gates combined, only 10% of
 * burst-into-immunity passed, dropping the flagship offensive mistake). The
 * rest: the target was driven low AND a non-immunity defensive answered (CC the
 * healer / swap), or off-target / dr-clip, each a mistake on its own.
 * (juked-kick was demoted and does not enter the offensive deep dive — see the
 * comment in offensivePackItems and OFFENSIVE_CANDIDATE_TYPES.)
 */
export function hasOffensiveCoachableSignal(items: PackItem[]): boolean {
  if (items.some((i) => i.kind === "immunity")) return true;
  const targetBottomed = items.some(
    (i) =>
      i.kind === "target-hp" && Number(i.facts.hp) <= OFFENSIVE_HP_THRESHOLD,
  );
  const defensiveAnswered = items.some((i) => i.kind === "enemy-defensive");
  if (targetBottomed && defensiveAnswered) return true;
  return items.some((i) => i.kind === "off-target" || i.kind === "dr-clip");
}

// juked-kick removed (Task 6 A/B): the offensive deep dive keeps only the four
// types worth >=4.4; juked-kick deep dives scored combined 2.9 (the only one
// <3.5), so it is demoted to a first-round finding only and is not routed into
// the offensive deep dive (→ classify puts it under survival, and if the
// survival gate does not fire it simply isn't deepened).
const OFFENSIVE_CANDIDATE_TYPES = new Set([
  "unconverted-burst",
  "burst-into-immunity",
  "off-target-in-window",
  "dr-clipped-cc",
]);

/** Routing: the majority of the candidates a finding references decides the
 * route; ties go to survival (death coaching anchors more value). */
export function classifyFindingKind(
  finding: Finding,
  candidates: CandidateEvent[],
): "survival" | "offensive" {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let off = 0,
    surv = 0;
  for (const id of finding.eventIds ?? []) {
    const t = byId.get(id)?.type;
    if (!t) continue;
    if (OFFENSIVE_CANDIDATE_TYPES.has(t)) off++;
    else surv++;
  }
  return off > surv ? "offensive" : "survival";
}

/** Deep-dive prompt: one section per pack; the audit discipline is the same as
 * the first round (placeholders / no causation / cite the listing only). */
export function buildDeepDivePrompt(
  packs: DeepDivePack[],
  findings: Finding[],
  specName: string,
  ownerName?: string,
  mode: "deepen" | "window" = "deepen",
): string {
  const ownerShort = ownerName ? ownerName.split("-")[0] : "the log owner";
  const sections = packs.map((p) => {
    const f = findings[p.findingIndex]!;
    const listing = p.items
      .map(
        // units= is not printed: the names are already in facts
        // (unit/player/src/tgt), and a separate token lures the model into
        // writing {{pN.units}}, a placeholder that does not exist → the whole
        // entry gets dropped by claimChecker (measured in the 2026-07-19
        // deep-dive discipline smoke test: all 3/6 failures were the phantom
        // .units field).
        (it) =>
          `  - key=${it.key} kind=${it.kind} facts={${Object.entries(it.facts)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}}`,
      )
      .join("\n");
    return mode === "window"
      ? [
          `SELECTED WINDOW ${p.findingIndex}: ${f.title} — ${f.explanation}`,
          `EVIDENCE PACK ${p.findingIndex} (window ${fmt(p.anchorFrom)}s–${fmt(p.anchorTo)}s; the ONLY additional evidence you may reference):`,
          listing,
        ].join("\n")
      : [
          `FINDING ${p.findingIndex}: [${f.severity}] ${f.title} — ${f.explanation}`,
          `EVIDENCE PACK ${p.findingIndex} (window ${fmt(p.anchorFrom)}s–${fmt(p.anchorTo)}s; the ONLY additional evidence you may reference):`,
          listing,
        ].join("\n");
  });
  return [
    mode === "window"
      ? `You are a World of Warcraft arena coach reviewing a time window that ${ownerShort} (a ${specName}) manually selected from their own match replay. ${ownerShort} is curious whether anything in this window could have been played differently. Do NOT assume something went wrong — the window was selected out of curiosity, not because a mistake is known to be there. For the window, write ONE short paragraph (3-5 sentences) ONLY IF the evidence pack supports a specific, concrete observation about a decision ${ownerShort}'s team could have made differently. If nothing stands out, output an empty array [] — that is a good and expected answer.`
      : `You are a World of Warcraft arena coach deepening findings from ${ownerShort}'s (a ${specName}) match review. You are coaching ${ownerShort} — the person reviewing their own game. For a finding, write ONE short paragraph (3-5 sentences) ONLY IF you can name a specific decision ${ownerShort}'s team could have made differently, grounded in the evidence pack.`,
    ``,
    ...sections,
    ``,
    `HARD RULES:`,
    `- Coach ${ownerShort} (facts with role=owner). role=teammate / role=enemy items are context only — cite a teammate's mistake ONLY when ${ownerShort} could have covered it (peel/CC the attacker, give an external, swap targets).`,
    `- kind=position items are ${ownerShort}'s own movement: kind=stayed-in = stood in a threat and took avoidable damage (hpMin is where HP bottomed, defAvail says if a defensive was up); kind=missed-push = drifted out of range (dist yards) when pressure was needed; kind=cd-out-of-range = fired a cooldown (spell) with no valid target in range. Coach the movement decision, not just cooldown usage.`,
    ...(packs.some((p) =>
      p.items.some(
        (it) =>
          it.kind === "external-available" || it.kind === "immunity-available",
      ),
    )
      ? [
          `- kind=external-available = when unit died, a living teammate (holder) had the life-saving external (spell) OFF COOLDOWN and in range/LoS (holderCc says whether the holder was CC-locked through the death window); kind=immunity-available = the dying player's own immunity was sitting unused (inCc likewise). These are "available but not pressed" facts — coach the specific call: press it, call for it, or name what to trade instead. If holderCc/inCc is yes, do NOT blame the holder; coach around the lockout.`,
        ]
      : []),
    ...(packs.some((p) => p.items.some((it) => OFFENSIVE_KINDS.has(it.kind)))
      ? [
          `- Offensive items (non-death findings): kind=target-hp = the enemy target's HP (hp) at that moment; kind=enemy-defensive / kind=immunity = what answered ${ownerShort}'s burst on that target (immunity has overlap seconds); kind=our-cc = ${ownerShort}'s team CC landed on the enemy healer; kind=our-cd = ${ownerShort}'s team offensive cooldown; kind=off-target = damage went to the wrong target (onTargetPct); kind=dr-clip = a CC landed on wasted DR (dr). You had the kill set up — coach what to change to close it (swap to the exposed target, hold burst past the immunity, lock their healer first), not survival.`,
        ]
      : []),
    `- If, after reviewing a pack, you cannot name a specific ${ownerShort}-team decision that was clearly suboptimal, OMIT that finding from your output entirely. Do NOT manufacture generic advice ("use defensives better", "peel/reposition", "watch HP"). A clean window is a valid outcome — say nothing rather than pad.`,
    `- Prefer a firm verdict ("trinket the second stun, not the first") over hedging ("worth reconsidering whether...").`,
    `- Reference only pack items; list the keys you used in "citedKeys" (non-empty).`,
    `- Write NO digits in "deepDive". Every number must be a {{key.field}} placeholder from that finding's pack (e.g. {{p1.t}}, {{p2.duration}}). Words for counts ("twice", "briefly") are fine.`,
    `- Do NOT assert causation ("led to"/"caused"/"resulted in" a death/loss). Describe the sequence neutrally and coach what to do differently at these moments.`,
    ``,
    `Output ONLY a JSON array: [{ "findingIndex": number, "deepDive": string, "citedKeys": string[] }]`,
  ].join("\n");
}

export interface DeepDiveResult {
  findingIndex: number;
  /** Interpolated narrative text. */
  text: string;
  /** Cited evidence chips (replay jump anchors). */
  chips: Array<{
    t: number;
    label: string;
    unitNames: string[];
    /** Display only, for the UI's icon; passed through from PackItem.spellId. */
    spellId?: string;
  }>;
}

/**
 * Deep-dive audit: placeholders must resolve against that finding's pack facts
 * (claimChecker), no causal assertions (causalLint), and citedKeys must be a
 * non-empty subset of the pack. Any violation → drop that entry (the finding
 * silently keeps its first-round content).
 */
export function auditDeepDives(
  parsed: unknown,
  packs: DeepDivePack[],
): DeepDiveResult[] {
  if (!Array.isArray(parsed)) return [];
  const byIndex = new Map(packs.map((p) => [p.findingIndex, p]));
  const out: DeepDiveResult[] = [];
  for (const entry of parsed as Array<{
    findingIndex?: number;
    deepDive?: string;
    citedKeys?: string[];
  }>) {
    const pack =
      entry.findingIndex !== undefined ? byIndex.get(entry.findingIndex) : null;
    if (!pack || typeof entry.deepDive !== "string") continue;
    const valid = new Set(pack.items.map((i) => i.key));
    // The pack keys actually used in the text ({{pK.field}}) must all be valid;
    // chips take citedKeys ∪ usedKeys (agy review #6: a mismatch between the two
    // makes a chip jump to the wrong moment). The placeholder regex comes from
    // claimChecker as the single source — writing a local copy drifts from it
    // (weekly review new #1: the old /\{\{(p\d+)\.[^}]+\}\}/ did not tolerate the
    // spaces in `{{ p1.t }}`, while claimChecker did).
    const usedKeys = [
      ...new Set(
        extractPlaceholderKeys(entry.deepDive)
          .map((k) => k.split(".")[0]!)
          .filter((ns) => /^p\d+$/.test(ns)),
      ),
    ];
    if (!usedKeys.every((k) => valid.has(k))) continue;
    const keys = [...new Set([...(entry.citedKeys ?? []), ...usedKeys])];
    if (keys.length === 0 || !keys.every((k) => valid.has(k))) continue;
    if (!claimChecker(entry.deepDive, pack.facts).ok) continue;
    // Bare-number ban (mirrors auditFindings' strict layer: the shared checker
    // lets conversational integers through, but here the discipline matches the
    // first round — any digit outside a placeholder = fabricated or defiant)
    const prose = entry.deepDive
      .replace(/\{\{[^}]*\}\}/g, " ")
      .replace(/\b\d+v\d+\b/gi, " ");
    if (/\d/.test(prose)) continue;
    // zh spell-name auto-repair (mirrors auditFindings.ts's Layer 3): a
    // translated ability name is deterministically fixable 1:1, so repair
    // and keep the deep-dive rather than dropping it outright. Consumption
    // invariant: repair runs BEFORE causalLint (see spellNameZhLint.ts's
    // header comment) — causalLint below validates the REPAIRED text, the
    // same text that ends up in the deep-dive.
    const { text: repairedDeepDive, repairs } = repairSpellNameZh(
      entry.deepDive,
    );
    if (repairs.length > 0) {
      console.warn(
        `[spellNameZhLint] deepDive repaired ${repairs.map((r) => `${r.zhName}→${r.enName}`).join(", ")}`,
      );
    }
    if (causalLint(repairedDeepDive).length > 0) continue;
    const itemsByKey = new Map(pack.items.map((i) => [i.key, i]));
    out.push({
      findingIndex: pack.findingIndex,
      text: interpolate(repairedDeepDive, pack.facts),
      chips: keys
        .map((k) => itemsByKey.get(k)!)
        .sort((a, b) => a.t - b.t)
        .map((i) => ({
          t: i.t,
          label: i.label,
          unitNames: i.unitNames,
          spellId: i.spellId,
        })),
    });
  }
  return out;
}

/** Build a pack for a user-selected window (#16): collect survival evidence →
 * survival gate; if that fails, collect offensive evidence → offensive gate; if
 * neither passes → null (the caller shows "no coachable signal" and never calls
 * the model). The synthetic finding references the ids of ALL candidate events
 * inside the window (rather than empty eventIds) — the HP section's `focus`
 * (resolving unitNames via eventIds) and the offensive section's `cands`
 * (reading off-target / dr-clip specific facts via eventIds) both need those ids
 * to derive their items; passing empty eventIds would make both item classes
 * permanently absent and, with them, kill the off-target / dr-clip branches of
 * hasOffensiveCoachableSignal (found in fix round 1's review). The window itself
 * is still clamped by windowOverride, not bounded by candidates — this only
 * borrows finding.eventIds as an existing derivation path, with zero special
 * cases inside the collectors (predicate single-source: window mode = "a finding
 * that references every candidate event in the window" + an override window). */
export function buildWindowPack(
  combat: any,
  fromS: number,
  toS: number,
  candidates: CandidateEvent[],
  ownerName?: string,
): { pack: DeepDivePack; kind: "survival" | "offensive" } | null {
  const inWinIds = candidates
    .filter((c) => Number.isFinite(c.t) && c.t >= fromS && c.t <= toS)
    .map((c) => c.id);
  const synth: Finding = {
    eventIds: inWinIds,
    severity: "low",
    category: "window",
    title: "",
    explanation: "",
  };
  const win = { fromS, toS };
  const surv = buildDeepDivePack(combat, synth, 0, candidates, ownerName, win);
  if (surv && hasCoachableSignal(surv.items))
    return { pack: surv, kind: "survival" };
  const off = buildOffensiveDeepDivePack(
    combat,
    synth,
    0,
    candidates,
    ownerName,
    win,
  );
  if (off && hasOffensiveCoachableSignal(off.items))
    return { pack: off, kind: "offensive" };
  return null;
}

/**
 * PackItem.kind → Chinese summary word, exported from a single source (review
 * round fix: desktop's UncoveredHighlightsCard — BACKLOG #13 — used to keep its
 * own copy of this table with different wording).
 * Consumers: `buildWindowAnchorFinding` in this file, for the window evidence
 * summary (spliced into the prompt body sent to the model, see the window
 * analysis flow in `desktop/main/analysis.ts`), and desktop's uncovered-
 * highlights card signal summary.
 * No eval gate or test asserts on these literal Chinese words —
 * `deepDive.window.test.ts` only asserts that explanation contains no
 * judgement words ("problem" / "mistake"), and does not pin specific kind
 * wording — so unifying them here carries no "change it and break the audit"
 * risk.
 */
export const PACK_ITEM_KIND_ZH: Record<PackItem["kind"], string> = {
  cc: "受控",
  defensive: "防御施放",
  "enemy-cd": "敌方进攻 CD",
  hp: "HP 轨迹",
  dispel: "驱散",
  "external-available": "外置可用",
  "immunity-available": "免疫可用",
  position: "走位",
  "target-hp": "目标血线",
  "enemy-defensive": "敌方防御",
  immunity: "敌方免疫",
  "our-cc": "我方控制",
  "our-cd": "我方大招",
  "off-target": "脱靶",
  "dr-clip": "踩 DR",
};

/** Neutral anchor (one of #16's three compensating layers): title/explanation
 * are generated deterministically from pack statistics, with no built-in
 * "something went wrong" presumption; times are floored to the rendered second
 * (gate predicates ARE the spec, shared-predicate discipline: rendering goes
 * through the single source fmtTime, never a locally re-written rounding rule). */
export function buildWindowAnchorFinding(
  pack: DeepDivePack,
  fromS: number,
  toS: number,
  kind: "survival" | "offensive",
): Finding {
  const counts = new Map<string, number>();
  for (const it of pack.items)
    counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([k, n]) => `${PACK_ITEM_KIND_ZH[k as PackItem["kind"]] ?? k}×${n}`)
    .join("、");
  return {
    eventIds: [],
    severity: "low",
    category: kind === "offensive" ? "window-offensive" : "window",
    title: `用户选段 ${fmtTime(fromS)}–${fmtTime(toS)}`,
    explanation: `该窗口由用户手动选取。窗口内证据:${summary}。`,
  };
}
