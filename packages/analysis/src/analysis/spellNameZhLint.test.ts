import { describe, expect, it } from "vitest";

import {
  ensureSpellNames,
  getSpellNamesSnapshot,
} from "../data/spellEffectData";
import { SPELL_NAME_ZH_LINT_STOPWORDS } from "../data/spellNameZhLintStopwords";
import { SPELL_NAME_ZH_TO_EN } from "../data/spellNameZhLintTable";
import { SPELL_NAMES_ZH_GENERATED } from "../data/spellNamesZh";
import { repairSpellNameZh, spellNameZhLint } from "./spellNameZhLint";

describe("spellNameZhLint (flags official-zh-localization spell names in EN-required output)", () => {
  // Verbatim corpus-confirmed violations — ds-sim-2026-07-31/responses (220
  // production DeepSeek responses) + agy-sim-2026-07-31 (300) + the b824e72
  // residual A/B (肾击). Each is a real sentence where the model correctly
  // used the EN name elsewhere and slipped into zh for the flagged instance —
  // the smoking-gun "same-response inconsistency" pattern documented in
  // scan200.md and spellNameZhLintTable.ts.
  it("flags corpus-confirmed violations (scan200.md + b824e72 residual set)", () => {
    expect(
      spellNameZhLint(
        "第二次爆发（1:14–1:26）是教科书级别：Pillar of Frost + Empower Rune Weapon + 盗贼Deathmark + 肾击控制治疗 = 击杀。",
      ),
    ).toEqual([{ zhName: "肾击", enName: "Kidney Shot" }]);
    expect(
      spellNameZhLint("血有 Barkskin + 熊形态，完全能撑过那 1 秒。"),
    ).toEqual([{ zhName: "熊形态", enName: "Bear Form" }]);
    expect(
      spellNameZhLint(
        "这两个死亡至少可以被 Ironbark（给队友）+ 迅捷治愈 + 野性成长延缓。",
      ),
    ).toEqual(
      expect.arrayContaining([
        { zhName: "迅捷治愈", enName: "Swiftmend" },
        { zhName: "野性成长", enName: "Wild Growth" },
      ]),
    );
    expect(
      spellNameZhLint(
        "**Blessing of Sacrifice**：1:06 和 2:09，牺牲祝福分别挂了 12 秒和 9 秒。",
      ),
    ).toEqual([{ zhName: "牺牲祝福", enName: "Blessing of Sacrifice" }]);
    expect(
      spellNameZhLint(
        "你可以在0:17-0:18开Bestial Wrath配合焦油陷阱/冰冻陷阱拖延",
      ),
    ).toEqual(
      expect.arrayContaining([
        { zhName: "焦油陷阱", enName: "Tar Trap" },
        { zhName: "冰冻陷阱", enName: "Freezing Trap" },
      ]),
    );
  });

  it("returns empty for clean English-name text", () => {
    expect(
      spellNameZhLint(
        "0:35 Divine Hymn on cooldown, 1:14 Pillar of Frost + Empower Rune Weapon burst.",
      ),
    ).toEqual([]);
  });

  // Verbatim false-positive snippets found while stress-testing a naive
  // mechanical (length + unique-EN-mapping) filter against the same 561-file
  // production corpus — see spellNameZhLintTable.ts's "为什么不用机械长度
  // 过滤" note. These generic tactical/idiomatic phrases coincide with a
  // real (but here uncited) ability's official translation; none of the
  // curated table's entries should ever match them.
  it("does not flag generic Chinese tactical vocabulary / idioms (denylist-shaped false positives)", () => {
    const fpSentences = [
      "你整场在 DK 和 DH 之间反复横跳，从来没有集中火力。",
      "## 战斗分析报告",
      "此时你的 PvP 饰品在CD（还剩68秒）",
      "过早 — 你当时被晕，但血量80%，不是危急时刻",
      "先用 Holy Word: Serenity + 快速治疗稳住 FDruid",
      "你可以驱散魔法，Affliction Warlock队友也能驱。",
      "0:16 敌开 Avatar 时应考虑风筝或防御姿态",
      "在这生死攸关的时刻，你在干什么？",
      "**局势逆转**：0:18 至 0:25 期间，敌方接连开启了双 Power Infusion",
      "为你们后续的致命一击创造了干净的环境。",
      "不要让对方白嫖法术反射。",
      "### 3. 解除诅咒与进攻驱散 (辅助职责严重失职)",
    ];
    for (const s of fpSentences) expect(spellNameZhLint(s)).toEqual([]);
  });

  // Product policy explicitly allows "EnglishName（中文注解）" as a reader
  // gloss (b824e72 A/B: "Guardian Spirit（守护之魂）" ruled compliant) — only
  // the bare zh name (no adjacent English) is the actual violation.
  it("does not flag the allowed 'EnglishName（zh gloss）' annotation form", () => {
    expect(
      spellNameZhLint("Guardian Spirit（守护之魂）在 1:52 再次救下 Feral。"),
    ).toEqual([]);
    expect(
      spellNameZhLint(
        "术士身上有 Unending Resolve（不灭决心），并且覆盖了你爆发期长达 8 秒的时间！",
      ),
    ).toEqual([]);
  });

  it("still flags a bare occurrence even when a DIFFERENT glossed occurrence of the same name exists", () => {
    const text =
      "Guardian Spirit（守护之魂）救了一次，但第二次你没能再用守护之魂续命。";
    expect(spellNameZhLint(text)).toEqual([
      { zhName: "守护之魂", enName: "Guardian Spirit" },
    ]);
  });

  it("auto-repair replaces the bare zh name with EN and leaves the rest of the sentence untouched", () => {
    const before =
      "第二次爆发（1:14–1:26）是教科书级别：Pillar of Frost + Empower Rune Weapon + 盗贼Deathmark + 肾击控制治疗 = 击杀。";
    const { text, repairs } = repairSpellNameZh(before);
    expect(text).toBe(
      "第二次爆发（1:14–1:26）是教科书级别：Pillar of Frost + Empower Rune Weapon + 盗贼Deathmark + Kidney Shot控制治疗 = 击杀。",
    );
    expect(repairs).toEqual([{ zhName: "肾击", enName: "Kidney Shot" }]);
    // Idempotent + fully clean after repair.
    expect(spellNameZhLint(text)).toEqual([]);
  });

  it("auto-repair does not touch an already-glossed 'EN（zh）' occurrence", () => {
    const before = "Unending Resolve（不灭决心）覆盖了你的爆发期。";
    const { text, repairs } = repairSpellNameZh(before);
    expect(text).toBe(before);
    expect(repairs).toEqual([]);
  });

  // Regression (2026-07-31 reviewer-found gap): the original gloss guard was
  // a single strict regex requiring the zh name within 4 WHITESPACE chars of
  // the opening paren. A "中文：" (or half-width "中文: ", or "即") prefix
  // inside the parens defeated it, so repair silently corrupted the gloss —
  // "Guardian Spirit（中文：守护之魂）" → "Guardian Spirit（中文：Guardian
  // Spirit）", destroying the annotation. Fixed by treating the zh name as
  // glossed whenever the EN name appears within a bounded lookback window
  // AND there's an (unclosed) bracket between them — see spellNameZhLint.ts's
  // isGlossedOccurrence. These fixtures must survive repair byte-for-byte.
  it("does not corrupt an 'EN（prefix：zh）' gloss with a prefix inside the parens (regression)", () => {
    const variants = [
      "Guardian Spirit（中文：守护之魂）在 1:52 再次救下 Feral。",
      "Guardian Spirit (中文: 守护之魂) 在 1:52 再次救下 Feral。",
      "Guardian Spirit（即守护之魂）在 1:52 再次救下 Feral。",
      "Guardian Spirit（详见（中文：守护之魂）注释）在 1:52 再次救下 Feral。",
    ];
    for (const before of variants) {
      const { text, repairs } = repairSpellNameZh(before);
      expect(text, before).toBe(before);
      expect(repairs, before).toEqual([]);
      expect(spellNameZhLint(before), before).toEqual([]);
    }
  });

  it("auto-repair fixes only the bare occurrence when a glossed one is also present", () => {
    const before =
      "Guardian Spirit（守护之魂）救了一次，但第二次你没能再用守护之魂续命。";
    const { text, repairs } = repairSpellNameZh(before);
    expect(text).toBe(
      "Guardian Spirit（守护之魂）救了一次，但第二次你没能再用Guardian Spirit续命。",
    );
    expect(repairs).toEqual([
      { zhName: "守护之魂", enName: "Guardian Spirit" },
    ]);
  });

  it("multiple distinct hits in one text are all repaired", () => {
    const before =
      "三个进攻CD（Mighty Bash / Stampeding Roar / 自然迅捷吹风）全部未用，团队能赢是因为DK的凋零缠绕+天灾打击压死了Ret Paladin。";
    const { text, repairs } = repairSpellNameZh(before);
    expect(text).toContain("Nature's Swiftness吹风");
    expect(text).toContain("Death Coil+Scourge Strike");
    expect(repairs.map((r) => r.zhName).sort()).toEqual(
      ["凋零缠绕", "天灾打击", "自然迅捷"].sort(),
    );
  });

  // Guards against a future PR silently widening the curated table with a
  // mechanically-derived name that was already proven generic-shaped.
  it("table and stopword denylist never overlap", () => {
    for (const zh of Object.keys(SPELL_NAME_ZH_TO_EN)) {
      expect(SPELL_NAME_ZH_LINT_STOPWORDS.has(zh)).toBe(false);
    }
  });

  // Anti-rot: every curated zh→en pair must resolve to a REAL spell id in
  // both the production zh table (spellNamesZhGenerated) and the production
  // EN table (spellNames.json via spellEffectData) — catches a future datagen
  // refresh silently renaming/removing a spell this table depends on.
  it("every curated entry resolves to a real id with matching zh AND en names in the production tables", async () => {
    await ensureSpellNames();
    const enNames = getSpellNamesSnapshot();
    for (const [zh, en] of Object.entries(SPELL_NAME_ZH_TO_EN)) {
      const matchingIds = Object.entries(SPELL_NAMES_ZH_GENERATED).filter(
        ([, z]) => z === zh,
      );
      expect(
        matchingIds.length,
        `no id in spellNamesZhGenerated has zh name "${zh}"`,
      ).toBeGreaterThan(0);
      const hasMatchingEn = matchingIds.some(([id]) => enNames[id] === en);
      expect(
        hasMatchingEn,
        `no id with zh name "${zh}" resolves to en name "${en}" in spellNames.json`,
      ).toBe(true);
    }
  });
});
