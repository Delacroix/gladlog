import {
  analyzePlayerCCAndTrinket,
  buildDeathOutcomeSummary,
  computeMissedExternalCounterfactuals,
  computeMitigationAudit,
  computeUnusedSelfCounterfactuals,
  detectPanicDefensives,
  extractMajorCooldowns,
  findCheaperDefensiveAlternatives,
  ICounterfactualHit,
  IMajorCooldownInfo,
  IMitigationAuditRow,
  SPELL_CATEGORIES,
} from "@gladlog/analysis";
import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import { displaySpellName } from "./spellDisplay";
import type { ReportSource } from "./types";

/** Look-back window before death (seconds). */
export const DEATH_RECAP_WINDOW_S = 10;

export interface DeathRecapEvent {
  /** Relative seconds (since combat start). */
  tS: number;
  kind: "dmg" | "heal" | "cc" | "def_used";
  spell: string;
  /** Raw spell id (#21 item1: feeds the inline icon; ChipIcon degrades on its
   * own when there is no table entry). */
  spellId?: string;
  amount?: number;
  srcName: string;
  hpBeforePct?: number;
  hpAfterPct?: number;
  /** kind="def_used" only (#10 T5): the same analysis verdict
   * (detectPanicDefensives, the same predicate as the defensive panic note in
   * keyMoments.ts) -- a major cooldown pressed with no visible enemy threat. */
  panic?: boolean;
}

export interface DeathRecap {
  unitId: string;
  unitName: string;
  /** Time of death, relative seconds. */
  deathS: number;
  /** Event stream over the DEATH_RECAP_WINDOW_S seconds before death
   * (ascending). */
  events: DeathRecapEvent[];
  /** Immunities/survival cooldowns that were available at time of death but
   * not pressed (analysis deathOutcome predicate). */
  availableImmunities: Array<{
    spellId: string;
    spellName: string;
    wasInCC: boolean;
    /** Same predicate as F166 (findCheaperDefensiveAlternatives): which
     * strictly cheaper (shorter cooldown) majors were also available and
     * unpressed at time of death -- lets the card append a "cheaper
     * alternative" hint. Empty array when there is no matching ledger row or
     * no cheaper option. */
    cheaperAlternatives: string[];
  }>;
  /** External survival cooldowns a teammate could have given but did not
   * (and whether that caster was under CC). */
  missedExternals: Array<{
    casterName: string;
    spellId: string;
    spellName: string;
    casterWasInCC: boolean;
  }>;
  /**
   * Mitigation audit (form A, #17b Task4): a row-by-row accounting of the
   * whitelisted mitigation that was **already active** on the victim inside
   * the death window. The numbers come straight from computeMitigationAudit
   * in Task1's counterfactual.ts -- the render layer does not re-derive how
   * much damage was absorbed.
   */
  mitigationAudit: IMitigationAuditRow[];
  /**
   * Counterfactuals (B / narrow gate merged, decisive only): teammate
   * externals that were available but not given, plus own cooldowns that were
   * available but not pressed. Only the "clearly would have survived" tier is
   * kept (honesty ethics: marginal/fatal stay silent).
   */
  counterfactuals: ICounterfactualHit[];
}

const DEF_TYPES = new Set(["immunities", "buffs_defensive"]);

/**
 * A recap of every death (backlog #6). All verdicts consume the analysis
 * predicates (buildDeathOutcomeSummary / analyzePlayerCCAndTrinket) -- the
 * render layer does not rebuild death judgements; that is the lesson from the
 * duplicate-predicate disease found in the audit.
 */
export function deriveDeathRecaps(source: ReportSource): DeathRecap[] {
  try {
    const legacy = toLegacySafe(source);
    const matchStartMs = legacy.startTime;
    // Cover deaths on both sides: our deaths = defensive review, enemy deaths
    // = kill-execution review.
    const players = Object.values(legacy.units).filter((u) => u.info);
    if (players.length === 0) return [];

    const combatLike = {
      startTime: legacy.startTime,
      endTime: legacy.endTime,
      // legacy.startInfo.zoneId is a required string (toLegacyMatch builds
      // IStartInfo unconditionally, see parser-compat/src/{types,convert}.ts)
      // -- no optional fallback is needed. The previous version widened it to
      // `{zoneId?: string} | undefined` and silenced the compiler with a
      // forced type assertion, which reproduces exactly the class of bug this
      // change fixes (once the check is silenced, the compiler can no longer
      // see that a nonexistent field is being read).
      startInfo: { zoneId: legacy.startInfo.zoneId },
    };
    const allUnits = Object.values(legacy.units);
    const ccSummaries = players.map((p) => {
      const opponents = players.filter((o) => o.reaction !== p.reaction);
      const oppIds = new Set(opponents.map((o) => o.id));
      const oppPets = allUnits.filter(
        (u) => u.ownerId && oppIds.has(u.ownerId),
      );
      return analyzePlayerCCAndTrinket(p, opponents, combatLike, oppPets);
    });
    // I-1 (reviewer finding): the teammate/missedExternals loop inside
    // buildDeathOutcomeSummary does no faction filtering (it trusts the caller
    // to pass a pure teammate pool -- the only other call site on the analysis
    // side, buildMatchContext.ts, does exactly that: friends and enemies
    // passed separately). This component used to pass the whole `players` pool
    // from both sides as friends, a usage unique to it (it needs to review
    // deaths on both sides), so a still-living enemy healer was treated as a
    // "teammate in the queue" and pushed into the victim's missedExternals --
    // the report would name an enemy as "the person who should have saved
    // you". Call it twice, split by the victim's faction, feeding each call
    // only its own faction pool, then merge the events: each call's internal
    // teammate loop can then only see its own team, with no change to
    // buildDeathOutcomeSummary itself.
    const friendlyPlayers = players.filter(
      (p) => p.reaction === CombatUnitReaction.Friendly,
    );
    const hostilePlayers = players.filter(
      (p) => p.reaction === CombatUnitReaction.Hostile,
    );
    const outcomeCombat = {
      startTime: legacy.startTime,
      zoneId: legacy.startInfo.zoneId,
    };
    const outcomeEvents = [
      ...buildDeathOutcomeSummary(outcomeCombat, friendlyPlayers, ccSummaries)
        .events,
      ...buildDeathOutcomeSummary(outcomeCombat, hostilePlayers, ccSummaries)
        .events,
    ];
    // Mitigation audit / counterfactuals (#17b Task4): victimCds/ccSummary are
    // aligned by unit.id with what was already computed above, not recomputed
    // -- legacy already carries startTime/endTime/units, so feed it straight
    // to Task1's three functions (the same usage as extractMajorCooldowns(u,
    // legacy) in keyMoments.ts).
    const cdsByUnit = new Map<string, IMajorCooldownInfo[]>(
      players.map((p) => [p.id, extractMajorCooldowns(p, legacy)]),
    );
    const ccSummaryByUnit = new Map(
      players.map((p, i) => [p.id, ccSummaries[i]!]),
    );
    // Panic usage (#10 T5): the gate predicate is the spec -- consume
    // analysis's detectPanicDefensives directly (the same verdict as the
    // defensive panic note in keyMoments.ts), calling it twice split by the
    // victim's faction (same reason as buildDeathOutcomeSummary above: the
    // function does no faction filtering internally, so friends/enemies must
    // each be fed their own faction pool).
    const panicsFriendly = detectPanicDefensives(
      friendlyPlayers,
      hostilePlayers,
      combatLike,
    );
    const panicsHostile = detectPanicDefensives(
      hostilePlayers,
      friendlyPlayers,
      combatLike,
    );
    const panicsFor = (reaction: CombatUnitReaction) =>
      reaction === CombatUnitReaction.Friendly ? panicsFriendly : panicsHostile;

    const nameOf = (id: string): string => legacy.units[id]?.name ?? "unknown";

    const recaps: DeathRecap[] = [];
    for (const unit of players) {
      for (const death of unit.deathRecords) {
        const deathS = (death.timestamp - matchStartMs) / 1000;
        const fromS = deathS - DEATH_RECAP_WINDOW_S;
        const events: DeathRecapEvent[] = [];

        const clampPct = (v: number) => Math.min(100, Math.max(0, v));
        /** HP before/after an event: the advanced sample at the same
         * timestamp = HP after it landed; the before value = the after value
         * walked back by this event's amount.
         * amountTowardBefore: +|amount| for dmg (HP was higher before),
         * -amount for heal (HP was lower before). */
        const hpRangeAt = (
          tsMs: number,
          amountTowardBefore: number,
        ): { hpBeforePct: number; hpAfterPct: number } | undefined => {
          const sample = unit.advancedActions.find(
            (a) => a.logLine?.timestamp === tsMs,
          );
          if (!sample || sample.advancedActorMaxHp <= 0) return undefined;
          const max = sample.advancedActorMaxHp;
          const hpAfterPct = clampPct(
            (sample.advancedActorCurrentHp / max) * 100,
          );
          const hpBeforePct = clampPct(
            hpAfterPct + (amountTowardBefore / max) * 100,
          );
          return { hpBeforePct, hpAfterPct };
        };

        // Damage taken (log sign convention: raw damage is negative ->
        // Math.abs)
        for (const d of unit.damageIn) {
          const tS = (d.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          events.push({
            tS,
            kind: "dmg",
            spell: displaySpellName(d.spellId ?? "", d.spellName ?? ""),
            spellId: d.spellId,
            amount: Math.abs(d.effectiveAmount),
            srcName: nameOf(d.srcUnitId),
            ...hpRangeAt(d.logLine.timestamp, Math.abs(d.effectiveAmount)),
          });
        }
        // Healing taken
        for (const h of unit.healIn) {
          const tS = (h.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          if (h.effectiveAmount <= 0) continue;
          events.push({
            tS,
            kind: "heal",
            spell: displaySpellName(h.spellId ?? "", h.spellName ?? ""),
            spellId: h.spellId,
            amount: h.effectiveAmount,
            srcName: nameOf(h.srcUnitId),
            ...hpRangeAt(h.logLine.timestamp, -h.effectiveAmount),
          });
        }
        // CC applied to the victim (curated cc category)
        for (const a of unit.auraEvents) {
          if (a.logLine.event !== LogEvent.SPELL_AURA_APPLIED) continue;
          if (SPELL_CATEGORIES[a.spellId ?? ""]?.type !== "cc") continue;
          const tS = (a.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          events.push({
            tS,
            kind: "cc",
            spell: displaySpellName(a.spellId ?? "", a.spellName ?? ""),
            spellId: a.spellId,
            srcName: nameOf(a.srcUnitId),
          });
        }
        // Defensives the victim pressed; panic usage (#10 T5) is aligned to
        // detectPanicDefensives' output by (spellId, caster name, ~second) --
        // the same verdict, not rebuilt here.
        const panics = panicsFor(unit.reaction);
        for (const c of unit.spellCastEvents) {
          if (c.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
          if (!DEF_TYPES.has(SPELL_CATEGORIES[c.spellId ?? ""]?.type ?? ""))
            continue;
          const tS = (c.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          const panic = panics.some(
            (p) =>
              p.spellId === c.spellId &&
              p.casterName === unit.name &&
              Math.abs(p.timeSeconds - tS) < 1,
          );
          events.push({
            tS,
            kind: "def_used",
            spell: displaySpellName(c.spellId ?? "", c.spellName ?? ""),
            spellId: c.spellId,
            srcName: unit.name,
            ...(panic ? { panic: true } : {}),
          });
        }
        events.sort((a, b) => a.tS - b.tS);

        // deathOutcome events are aligned by (name, second)
        const oc = outcomeEvents.find(
          (e) =>
            e.deadPlayer === unit.name && Math.abs(e.atSeconds - deathS) < 1,
        );

        // Mitigation audit / counterfactuals (#17b Task4): all three functions
        // are called once with the same deathS so the numbers are
        // single-source -- the card does not re-derive absorbed/saved damage,
        // it only consumes Task1's return values.
        const victimCds = cdsByUnit.get(unit.id) ?? [];
        const victimCcSummary = ccSummaryByUnit.get(unit.id);
        const mitigationAudit = computeMitigationAudit(
          unit,
          legacy,
          deathS,
        ).rows;
        const counterfactuals: ICounterfactualHit[] = [
          ...(victimCcSummary
            ? computeUnusedSelfCounterfactuals(
                unit,
                victimCds,
                victimCcSummary,
                legacy,
                deathS,
              )
            : []),
          ...computeMissedExternalCounterfactuals(
            oc?.missedExternals ?? [],
            unit,
            legacy,
            deathS,
          ),
        ];

        recaps.push({
          unitId: unit.id,
          unitName: unit.name,
          deathS,
          events,
          // Cheaper alternatives (#10 T5, same predicate as F166): align the
          // unpressed major to its row in the victimCds ledger by spellId and
          // feed that to findCheaperDefensiveAlternatives to find shorter-
          // cooldown options still available at time of death -- when the
          // ledger has no such row (not recorded / not a major) we silently
          // return an empty array rather than pretending an alternative
          // exists.
          availableImmunities: (oc?.availableImmunities ?? []).map((i) => {
            const cd = victimCds.find((c) => c.spellId === i.spellId);
            return {
              spellId: i.spellId,
              spellName: i.spellName,
              wasInCC: i.wasInCC,
              cheaperAlternatives: cd
                ? findCheaperDefensiveAlternatives(cd, victimCds, deathS, {})
                : [],
            };
          }),
          missedExternals: (oc?.missedExternals ?? []).map((m) => ({
            casterName: m.casterName,
            spellId: m.spellId,
            spellName: m.spellName,
            casterWasInCC: m.casterWasInCC,
          })),
          mitigationAudit,
          counterfactuals,
        });
      }
    }
    return recaps.sort((a, b) => a.deathS - b.deathS);
  } catch {
    return [];
  }
}
