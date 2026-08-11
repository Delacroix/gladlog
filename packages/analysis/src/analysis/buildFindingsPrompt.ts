import { LEGACY_TOPIC_TYPES } from "./candidateFindings";
import { FINDING_CATEGORIES } from "./findingCategories";
import type { CandidateEvent } from "./types";

/** The category enum rendered into the prompt (the same constant the audit
 * normalizes against -- single-source predicate). */
const CATEGORY_UNION = FINDING_CATEGORIES.map((c) => `"${c}"`).join("|");

/** Rendered into the selection-rule sentence below and shared with
 * auditFindings.ts's deterministic cap on the very same set — single-source
 * (CLAUDE.md shared-predicate rule), see LEGACY_TOPIC_TYPES's doc comment in
 * candidateFindings.ts. */
const LEGACY_TYPES_LIST = [...LEGACY_TOPIC_TYPES]
  .map((t) => `"${t}"`)
  .join(", ");

const DPS_LEGENDS: Record<string, string> = {
  "unconverted-burst": `- "unconverted-burst": your offensive cooldowns (facts.spell) put facts.damageM M damage on facts.target but it did NOT convert — target survived with HP facts.hpStart% → facts.hpEnd% (facts.defensive names a damage reduction that was up, if any; facts.allyAligned says whether an ally offensive CD overlapped). Coach setup: pair the burst with CC on the healer, align with ally CDs, or pick a target without a defensive ready.`,
  "burst-into-immunity": `- "burst-into-immunity": you opened offensive cooldowns (facts.spell) while the target had a full immunity running (facts.immunity, active facts.overlap seconds of the burst). Coach burst timing or a target swap.`,
  "burst-into-mitigation": `- "burst-into-mitigation": you opened offensive cooldowns (facts.spell) into facts.target while they had facts.mitSpell (facts.mitPct% damage reduction) running, and facts.betterTarget was a softer target available at that same moment. State only that the mitigation was up and the alternative existed — do NOT assert the burst therefore failed or that swapping would certainly have gotten a kill. Coach target selection at the moment of opening.`,
  "off-target-in-window": `- "off-target-in-window": during a kill window on facts.target, only facts.onTargetPct percent of your damage landed on that target (facts.offTarget absorbed the most). Coach target discipline.`,
  "juked-kick": `- "juked-kick": your interrupt (facts.kick) was baited out by a fake cast (facts.fake) — the enemy cancelled and you kicked air. Coach kick patience/holding for the real cast.`,
  "dr-clipped-cc": `- "dr-clipped-cc": your CC (facts.spell) landed on facts.target at facts.dr diminishing returns (only facts.duration seconds). Coach CC sequencing with your team.`,
};

/** Conditional legends common to every owner perspective (emitted only when
 * the menu contains that type; without it the prompt bytes are unchanged). */
const CHAIN_LEGENDS: Record<string, string> = {
  "missed-cleanse": `- "missed-cleanse": a high-value enemy CC (facts.cc, facts.priority) sat on ally facts.target for facts.duration seconds without a friendly dispel while a cleanse was available; the target ate facts.postCcDamageK k damage right after it landed. Coach dispel priority/awareness. When facts.ownerCanDispel is present ("no"): the log owner's own class CANNOT remove this debuff type (facts.eligibleDispellers names the teammates who can, by spec) — phrase the finding only as a call-out/communication suggestion ("call for a dispel"/"ask X to cleanse it"), NEVER as "you should have dispelled it" or "use your cleanse/purify" — the owner has no such ability for this debuff type.`,
  "missed-purge": `- "missed-purge": enemy facts.enemy kept a high-value buff (facts.buff, facts.priority) running facts.duration seconds without being purged while a purge was available (facts.inKillWindow says it overlapped your team's kill window). Coach offensive dispel usage.`,
  "cc-locked": `- "cc-locked": you sat in hard CC (facts.cc from facts.source) for facts.duration seconds taking facts.damageTakenK k damage. facts.trinketState matters: "available_unused" = trinket was in hand the whole time (coach trinket decision); "on_cooldown" = coach positioning/spacing so the chain could not start. Do not coach "use your trinket" when trinketState is on_cooldown.`,
  "kick-eaten": `- "kick-eaten": your hardcast (facts.interrupted) was interrupted by facts.source's facts.kick, locking the school for facts.lockout seconds. Coach fake-casting / juking the kick.`,
  "death-setup": `- "death-setup": a precursor moment tied to a later friendly death at facts.deathT (facts.kind: "healer-locked" = the healer was CC'd through the kill window; "trinket-early" = the victim's trinket was spent at facts.t and still down when they died in CC; "defensive-early" = a major defensive was spent early per the timing audit and unavailable at death). For a chain finding, anchor on the death-setup event id(s) ALONE — their facts already carry both {{t}} (the setup moment) and {{deathT}} (the death); do NOT also reference the death event id, whose own t differs and would make {{t}} ambiguous. Describe the sequence neutrally — "at {{t}}s X happened; at {{deathT}}s the death followed" — and suggest what to do differently at the setup moment. The no-causation hard rule still applies: never write that the setup "led to"/"caused"/"resulted in" the death.`,
  "death-unused-defensive": `- "death-unused-defensive": the player died at facts.t while major defensive(s) facts.walls were OFF cooldown. facts.free explains why pressing was possible: "yes" = not in CC; "trinket_in_hand" = CC'd but trinket was available to break out first; "usable_in_cc" = the listed ability works while CC'd. Coach pressing defensives earlier when taking heavy damage; do not invent which damage killed them.`,
  "external-unused": `- "external-unused": teammate facts.victim died at facts.t while the player (facts.owner) had external defensive facts.external off cooldown and was free of CC for facts.freeGapS seconds in the final window. Coach external usage priorities; never claim the external would certainly have saved them.`,
  "wasted-trinket": `- "wasted-trinket": the player used their PvP trinket at facts.t in a neutral state (team minimum HP facts.teamMinHpPct%, healer free, no enemy offensive cooldowns active). Coach saving trinket for kill windows or breaking lethal CC.`,
  // Signal-expansion batch 1 (2026-08-06, BACKLOG #18 second batch, design:
  // docs/superpowers/specs/2026-08-07-signal-expansion-batch1-design.md).
  "healing-gap": `- "healing-gap": the healer produced no heals or casts for facts.durationS seconds (facts.freeS of that was free of CC — time they COULD have cast), while facts.pressured (facts.pressuredSpec) took real damage. Coach healing rotation/triage awareness during that stretch.`,
  "position-mistake": `- "position-mistake": the log owner's own movement (facts.kind). "stayed-in" = stood in a threat and took an HP drop (facts.hpStart% → facts.hpMin%, facts.enemy names the nearest threat when known); "missed-push" = drifted facts.dist yards from facts.enemy when pressure was needed; "cd-out-of-range" = fired facts.spell with no valid target in range. Coach the movement decision, not just cooldown usage.`,
  // No-causation guard (design doc, explicit): "sat available unused" is a
  // FACT about uptime; "and that's why you lost" is the banned inference —
  // do not let this legend, or a finding built from it, cross that line.
  "cc-held": `- "cc-held": the player's control cooldown facts.spell sat AVAILABLE and unused for facts.heldS continuous seconds (facts.t to facts.windowEndT) — this is an uptime fact, not a claim that pressing it would have changed the outcome. Coach whether that stretch had a target worth using it on, or note that holding it may have been the correct call — never assert it "cost" anything.`,
  // DEFENSIVE-001 (2026-08-07, BACKLOG #18 second batch, design:
  // docs/superpowers/specs/2026-08-07-defensive-001-design.md).
  // No-causation guard: "X was available before it landed" is a FACT about
  // the owner's kit at that instant; "using it would have saved you" is the
  // banned inference the wording below is written to avoid — the tool may
  // well have been better saved for later.
  "cc-avoidable": `- "cc-avoidable": the player ate hard CC facts.spell for facts.durationS seconds at full effect. Before it landed, facts.avoidableWith was available — can be used to avoid this kind of control. Coach reacting with one of these tools next time, or note that holding it for a bigger threat may have been the right call — never assert that using it would certainly have prevented what followed.`,
  // DEFENSIVE-003 (2026-08-11). No-causation guard: "the first defensive
  // response came late/never while a tool was off cooldown" is a FACT about
  // reaction timing; "responding faster would have prevented the damage" is
  // the banned inference — the wording below must not cross that line.
  "slow-defensive-response": `- "slow-defensive-response": the enemy opened offensive cooldown(s) facts.enemyCds at facts.t and real pressure followed (facts.damageK k team damage over facts.t–facts.windowEndT, facts.dmgRatio× the match-average rate) while the player had a defensive off cooldown and was not CC'd. facts.reacted="none" means no defensive, external, trinket, mobility, or CC response came inside that window; otherwise facts.delayS is the seconds until the first response (facts.reactSpell). Coach recognizing the enemy opener and answering sooner — a wall, an external, a reposition, or CC on the attacker — or note that holding may have been deliberate; never assert a faster response would certainly have changed what followed.`,
};

function legendLines(
  map: Record<string, string>,
  candidates: CandidateEvent[],
): string[] {
  const present = new Set(candidates.map((c) => c.type));
  return Object.entries(map)
    .filter(([type]) => present.has(type))
    .map(([, line]) => line);
}

// ACCURACY NOTE (2026-07-15 A/B evidence): the HARD RULES below — event-id
// menu, placeholder-only numbers, causation ban — are this prompt's version
// of the responder ACCURACY DISCIPLINE that a blind A/B measured at
// accuracy +0.71 [0.43, 1.00] (p=0.004, 42/42 claims verified) for the
// free-text eval coach. Do not weaken these constraints without an A/B.
export function buildFindingsPrompt(
  candidates: CandidateEvent[],
  richContext: string,
  specName: string,
): string {
  const menu = candidates
    .map((c) => {
      // Events with a time-specific fact show it; whole-round observations
      // (e.g. cd-waste) have no `t` fact — showing "t=0s" would tempt the model
      // to write {{t}}, which then resolves to nothing and gets discarded.
      const when =
        c.facts.t !== undefined ? `t=${c.facts.t}s` : `t=whole-round`;
      return (
        `  - id=${c.id} type=${c.type} ${when} units=${c.unitNames.join("/")}` +
        ` facts={${Object.entries(c.facts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}}`
      );
    })
    .join("\n");
  return [
    `You are a World of Warcraft arena coach reviewing a ${specName}'s match. Produce 4-8 coaching findings as JSON — as many as the event menu genuinely supports; never fabricate, but prefer covering MORE distinct menu events over polishing few. Spread coverage across the whole match: when the menu has early/mid-game events (missed-cleanse, missed-purge, cc-locked, kick-eaten, bursts, kicks, targeting), do not spend every finding on the final seconds, and cover at least two non-death event types when present. At most 2 findings may be anchored solely on death events; when a death has "death-setup" events, pair them into one chain finding instead of adding another death-only item. Prioritize covering DIFFERENT event types over repeating the same one: of ${LEGACY_TYPES_LIST}, at most 2 findings TOTAL (combined across all four, not 2 each) may draw from that group even when the menu offers more of them — spend your remaining picks on other types instead.`,
    ``,
    `Match context (for reasoning about the arc — do NOT cite anything not in the event menu):`,
    richContext,
    ``,
    `Event menu (the ONLY things that provably happened — every finding must reference these ids):`,
    menu || "  (none)",
    ``,
    `Event legend:`,
    `- "death": a player died. facts.side=friendly means it was one of YOUR team's deaths (a loss to coach around); facts.side=enemy means your team scored the kill (reinforce what worked).`,
    `- "cd-waste": a major defensive cooldown the player never pressed the entire match (facts.spell names it). This is a whole-round observation with no timestamp.`,
    // Legends for DPS-owner event types are emitted only when the menu
    // contains that type -- a healer menu has none of them, so the healer
    // prompt stays byte-identical (D2).
    ...legendLines(CHAIN_LEGENDS, candidates),
    ...legendLines(DPS_LEGENDS, candidates),
    ``,
    `HARD RULES:`,
    `- Reference only event ids from the menu (in "eventIds"). Never invent an event.`,
    `- Write NO digits at all in "explanation". Every number must be a {{key}} placeholder drawn from the referenced events' facts (e.g. {{t}}). For counts or durations you have no placeholder for, use words ("twice", "briefly", "early", "a few globals") — never a raw number. An explanation containing any bare digit will be discarded.
- When ONE finding cites MULTIPLE events, indexed placeholders are always available, numbered by your eventIds order: {{t1}} = first event's t, {{t2}} = second event's, {{duration2}}, {{cc1}}, ... Use them whenever the events share a fact key — a bare {{t}} across events with DIFFERING t values is ambiguous and gets the finding discarded.`,
    `- Do NOT assert causation. No "because … you lost", "cost you the game", "that's why", "led to the loss". State observations and suggestions only.`,
    ``,
    `Example explanation: "You went down at {{t}}s; consider holding the trinket for the first swap and using your wall a beat earlier." (numbers only via placeholders; no causation)`,
    ``,
    `Output ONLY a JSON array: [{ "eventIds": string[], "severity": "high"|"med"|"low", "category": ${CATEGORY_UNION}, "title": string, "explanation": string }]`,
    `"category" must be EXACTLY one of those slugs (lowercase, English) regardless of the reply language — it is a stable aggregation key, not display text.`,
  ].join("\n");
}
