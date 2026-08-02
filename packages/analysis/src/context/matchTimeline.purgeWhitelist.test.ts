import { describe, expect, it } from "vitest";

import { SPELL_CATEGORIES } from "../data/spellCategories";
import { spellEffectData } from "../data/spellEffectData";
import {
  HIGH_VALUE_PURGEABLE_BUFFS,
  PURGE_WHITELIST_DATA_BLOCKED,
} from "./matchTimeline";

/**
 * The gate predicate is the spec: the single fact "this enemy buff is
 * dispellable and worth reporting" is asserted separately by three lists --
 * (1) dispelType in spellEffectData (dispelAnalysis.getDispelType)
 * (2) type in SPELL_CATEGORIES (dispelAnalysis.getPriority; not listed ->
 *     Low -> discarded)
 * (3) HIGH_VALUE_PURGEABLE_BUFFS in matchTimeline (the emitter)
 *
 * The three evolved independently, and the result, measured on the full
 * corpus on 2026-07-21: 7 of the 9 whitelist entries could never be emitted,
 * and across 1245 matches only Power Infusion and Blessing of Protection were
 * ever seen. The corpus cannot tell the difference -- "never happened" and
 * "cannot be emitted" look exactly alike. Hence the assertion here.
 */

// Mirror of getPriority (it is a private function in dispelAnalysis.ts; a
// divergence between the two is exactly what this test is meant to catch)
const CRITICAL_TYPES = new Set(["cc", "immunities"]);
const HIGH_TYPES = new Set([
  "roots",
  "immunities_spells",
  "buffs_offensive",
  "debuffs_offensive",
  "buffs_defensive",
]);

function reachesEmitter(spellId: string): {
  ok: boolean;
  dispelType: string | null;
  category: string | null;
} {
  const dispelType = spellEffectData[spellId]?.dispelType ?? null;
  const category = SPELL_CATEGORIES[spellId]?.type ?? null;
  const priorityOk =
    category !== null &&
    (CRITICAL_TYPES.has(category) || HIGH_TYPES.has(category));
  return { ok: dispelType === "Magic" && priorityOk, dispelType, category };
}

describe("HIGH_VALUE_PURGEABLE_BUFFS 与上游目录一致", () => {
  it("每条白名单要么真能发出,要么登记在 DATA_BLOCKED 里", () => {
    const silentlyDead: string[] = [];
    for (const spellId of HIGH_VALUE_PURGEABLE_BUFFS) {
      const r = reachesEmitter(spellId);
      if (!r.ok && !PURGE_WHITELIST_DATA_BLOCKED.has(spellId)) {
        silentlyDead.push(
          `${spellId}: dispelType=${r.dispelType} category=${r.category}`,
        );
      }
    }
    expect(silentlyDead).toEqual([]);
  });

  it("DATA_BLOCKED 不留已经修好的条目", () => {
    // Once the data is filled in this fails, as a reminder to delete the id
    // from the exemption list -- an exemption must not settle into a
    // permanent whitelist.
    const nowWorking: string[] = [];
    for (const spellId of PURGE_WHITELIST_DATA_BLOCKED) {
      if (reachesEmitter(spellId).ok) nowWorking.push(spellId);
    }
    expect(nowWorking).toEqual([]);
  });

  it("DATA_BLOCKED 只收白名单内的 id", () => {
    const orphans = [...PURGE_WHITELIST_DATA_BLOCKED].filter(
      (id) => !HIGH_VALUE_PURGEABLE_BUFFS.has(id),
    );
    expect(orphans).toEqual([]);
  });

  it("圣骑士三祝福都能走到发射端(本次修复的回归锚)", () => {
    for (const spellId of ["1022", "1044", "6940"]) {
      expect(reachesEmitter(spellId).ok, `spell ${spellId}`).toBe(true);
    }
  });

  it("2026-07-22 拍板的七条离散主动 CD(八个 id)都能走到发射端", () => {
    for (const spellId of [
      "210256", // Blessing of Sanctuary
      "29166", // Innervate
      "212295", // Nether Ward
      "378441", // Time Stop
      "370553", // Tip the Scales
      "132158", // Nature's Swiftness
      "378081", // Nature's Swiftness (variant id)
      "79206", // Spiritwalker's Grace
    ]) {
      expect(reachesEmitter(spellId).ok, `spell ${spellId}`).toBe(true);
    }
  });
});
