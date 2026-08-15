import { extractTalentModifiers } from "../../scripts/datagen/genTalentModifiers";
import { spellEffectData } from "../../src/data/spellEffectData";
import { CD_TALENT_MODIFIERS } from "../../src/utils/talentModifiers";

// Mirrors cooldowns.ts's own base-cooldown derivation
// (`effectData.cooldownSeconds ?? effectData.charges?.chargeCooldownSeconds ?? 0`,
// repeated at cooldowns.ts:899-902/955-958/982-985/1010-1013) and its
// MIN_CD_SECONDS=30 majorSpells-inclusion gate (cooldowns.ts:263,903) — a
// spell whose *base* cd is below that gate never reaches the talent-modifier
// step in production, so it must not be counted as a false invariant failure
// here either.
const MIN_CD_SECONDS = 30;
function effectiveBaseCooldown(spellId: string): number | undefined {
  const eff = spellEffectData[spellId];
  if (!eff) return undefined;
  return eff.cooldownSeconds ?? eff.charges?.chargeCooldownSeconds ?? 0;
}

// BACKLOG §29a: extractMajorCooldowns() produced negative cooldownSeconds for
// spellId 265187 (Summon Demonic Tyrant, base CD 60s) and 1719 (Recklessness,
// base CD 90s) on ~0.3% of sampled team-offensive-CD casts (5/1681, Task 5
// calibration, p1p2-calibration.md).
//
// Root cause: DB2 aura 107 (SPELL_AURA_ADD_FLAT_MODIFIER) and 108
// (SPELL_AURA_ADD_PCT_MODIFIER) are *generic* "apply a SpellMod" auras — which
// spell property they touch (cooldown, cast time, one numbered effect's raw
// value, buff duration, ...) is selected by EffectMiscValue_0 acting as a
// SpellModOp code. Only SPELLMOD_COOLDOWN (11) legitimately reduces a cooldown
// timer. The generator classified *every* 107/108 hit as `reduce_cd`
// regardless of MiscValue_0, so:
//   - Master Summoner (1240189, real DB2 row, build 12.1.0.69273): aura 107,
//     EffectBasePointsF=-500, MiscValue_0=10 (SPELLMOD_CASTING_TIME) — this is
//     "reduces Summon Demonic Tyrant's cast time by 0.5s" (confirmed via
//     wowhead tooltip), not a 500-second cooldown cut. Misclassified as
//     reduce_cd -500 → 500 after Math.abs, driving 60 - 500 = -440.
//   - Reckless Abandon (396749, real DB2 row): aura 107,
//     EffectBasePointsF=500, MiscValue_0=23 (SPELLMOD_EFFECT3) — modifies
//     Recklessness's rage-generation effect value, not its cooldown.
//     Misclassified as reduce_cd 500 → 90 - 500 = -410.
// Fix: gate aura 107/108 classification on `MiscValue_0 === SPELLMOD_COOLDOWN`
// (genTalentModifiers.ts). effect 148 (EFFECT_MOD_COOLDOWN, non-aura) and aura
// 453 (SPELL_AURA_CHARGE_RECOVERY_MOD, dedicated) are untouched — they are not
// the generic ADD_x_MODIFIER indirection and do not carry this ambiguity.
describe("extractTalentModifiers — generic SpellMod aura (107/108) must gate on SPELLMOD_COOLDOWN (BACKLOG §29a)", () => {
  const spellNameRows = [
    { ID: "1240189", Name_lang: "Master Summoner" },
    { ID: "396749", Name_lang: "Reckless Abandon" },
    { ID: "265187", Name_lang: "Summon Demonic Tyrant" },
    { ID: "1719", Name_lang: "Recklessness" },
  ];

  it("Master Summoner (aura 107, MiscValue_0=10 CASTING_TIME) does NOT register as reduce_cd on Summon Demonic Tyrant", () => {
    // Real row (SpellEffect ID 1238364, build 12.1.0.69273).
    const spellEffectRows = [
      {
        SpellID: "1240189",
        Effect: "6", // EFFECT_APPLY_AURA
        EffectAura: "107", // SPELL_AURA_ADD_FLAT_MODIFIER
        EffectBasePointsF: "-500",
        EffectMiscValue_0: "10", // SPELLMOD_CASTING_TIME, not SPELLMOD_COOLDOWN (11)
        EffectSpellClassMask_0: "0",
        EffectSpellClassMask_1: "1073741824",
        EffectSpellClassMask_2: "0",
        EffectSpellClassMask_3: "131072",
      },
    ];
    // Summon Demonic Tyrant shares the classmask bits Master Summoner targets
    // (that's how one talent's cast-time cut legitimately reaches both Summon
    // Felguard and Summon Demonic Tyrant in-game).
    const spellClassOptionsRows = [
      {
        SpellID: "265187",
        SpellClassSet: "5", // Warlock family
        SpellClassMask_0: "0",
        SpellClassMask_1: "1073741824",
        SpellClassMask_2: "0",
        SpellClassMask_3: "131072",
      },
    ];

    const result = extractTalentModifiers(
      spellEffectRows,
      spellClassOptionsRows,
      [],
      spellNameRows,
      new Set(["265187"]),
    );

    expect(result["265187"] ?? []).toEqual([]);
  });

  it("Reckless Abandon (aura 107, MiscValue_0=23 EFFECT3) does NOT register as reduce_cd on Recklessness", () => {
    // Real row (SpellEffect ID 1038325, build 12.1.0.69273).
    const spellEffectRows = [
      {
        SpellID: "396749",
        Effect: "6",
        EffectAura: "107",
        EffectBasePointsF: "500",
        EffectMiscValue_0: "23", // SPELLMOD_EFFECT3, not SPELLMOD_COOLDOWN (11)
        EffectSpellClassMask_0: "0",
        EffectSpellClassMask_1: "16",
        EffectSpellClassMask_2: "0",
        EffectSpellClassMask_3: "0",
      },
    ];
    const spellClassOptionsRows = [
      {
        SpellID: "1719",
        SpellClassSet: "4", // Warrior family
        SpellClassMask_0: "0",
        SpellClassMask_1: "16",
        SpellClassMask_2: "0",
        SpellClassMask_3: "0",
      },
    ];

    const result = extractTalentModifiers(
      spellEffectRows,
      spellClassOptionsRows,
      [],
      spellNameRows,
      new Set(["1719"]),
    );

    expect(result["1719"] ?? []).toEqual([]);
  });

  it("a genuine SPELLMOD_COOLDOWN (11) hit on the same generic aura still registers as reduce_cd (fix is a gate, not a removal)", () => {
    const spellEffectRows = [
      {
        SpellID: "1240189",
        Effect: "6",
        EffectAura: "107",
        EffectBasePointsF: "-5000", // ms; converts to -5s after the >500 heuristic
        EffectMiscValue_0: "11", // SPELLMOD_COOLDOWN
        EffectSpellClassMask_0: "0",
        EffectSpellClassMask_1: "1073741824",
        EffectSpellClassMask_2: "0",
        EffectSpellClassMask_3: "131072",
      },
    ];
    const spellClassOptionsRows = [
      {
        SpellID: "265187",
        SpellClassSet: "5",
        SpellClassMask_0: "0",
        SpellClassMask_1: "1073741824",
        SpellClassMask_2: "0",
        SpellClassMask_3: "131072",
      },
    ];

    const result = extractTalentModifiers(
      spellEffectRows,
      spellClassOptionsRows,
      [],
      spellNameRows,
      new Set(["265187"]),
    );

    expect(result["265187"]).toEqual([
      { talentSpellId: "1240189", effect: "reduce_cd", value: 5 },
    ]);
  });
});

// Invariant, run against the real generated+curated production data (not a
// synthetic fixture): no tracked major-CD spell's cooldownSeconds should be
// able to go negative, at either extreme — (a) every one of its reduce_cd
// modifiers stacked simultaneously (the actual cooldowns.ts loop applies all
// matching modifiers unconditionally, cooldowns.ts:1019-1029), or (b) its
// single largest individual modifier alone. This is full coverage over the
// current CD_TALENT_MODIFIERS table (118 tracked spellIds as of build
// 12.1.0.69273), not a sample — the table is small enough to check exhaustively.
describe("CD_TALENT_MODIFIERS invariant — no tracked major CD can go negative at either extreme", () => {
  const spellIdsWithReduceCd = Object.entries(CD_TALENT_MODIFIERS)
    .filter(([, mods]) => mods.some((m) => m.effect === "reduce_cd"))
    .map(([spellId]) => spellId);

  it("sanity: the table actually has reduce_cd entries to check (regression guard against an empty table silently passing everything)", () => {
    expect(spellIdsWithReduceCd.length).toBeGreaterThan(0);
  });

  it.each(spellIdsWithReduceCd)(
    "%s: base cooldown minus every stacked reduce_cd modifier stays >= 0",
    (spellId) => {
      const base = effectiveBaseCooldown(spellId);
      if (base === undefined || base < MIN_CD_SECONDS) return; // never reaches majorSpells in production
      const reduceMods = CD_TALENT_MODIFIERS[spellId].filter(
        (m) => m.effect === "reduce_cd",
      );
      const totalReduce = reduceMods.reduce((sum, m) => sum + m.value, 0);
      expect(base - totalReduce).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(spellIdsWithReduceCd)(
    "%s: base cooldown minus its single largest reduce_cd modifier stays >= 0",
    (spellId) => {
      const base = effectiveBaseCooldown(spellId);
      if (base === undefined || base < MIN_CD_SECONDS) return;
      const reduceMods = CD_TALENT_MODIFIERS[spellId].filter(
        (m) => m.effect === "reduce_cd",
      );
      const maxSingle = Math.max(...reduceMods.map((m) => m.value));
      expect(base - maxSingle).toBeGreaterThanOrEqual(0);
    },
  );
});
