import { SPELL_EFFECT_OVERRIDES } from "./spellEffectOverrides";
import { SPELL_EFFECTS_GENERATED } from "./spellEffectGenerated";

/*
 Interface and export for data mined from the WOW spells db itself
*/

export interface IMinedSpell {
  spellId: string;
  name: string;
  cooldownSeconds?: number;
  charges?: {
    charges?: number;
    chargeCooldownSeconds?: number;
  };
  durationSeconds?: number;
  /** Dispel type from SpellCategories.db2. null or undefined means the aura cannot be dispelled. */
  dispelType?: "Magic" | "Curse" | "Disease" | "Poison" | "Bleed" | null;
}

// 双层:生成基础层(DB2 原值)+ 策展覆盖层优先(PvP 修正等人工校准值恒赢)
export const spellEffectData = {
  ...SPELL_EFFECTS_GENERATED,
  ...SPELL_EFFECT_OVERRIDES,
} as Record<string, IMinedSpell>;

// 后台加载而非顶层 await:TLA 会让整个模块图(含 renderer 首屏)串行等
// 12MB 表加载完才求值 —— 而首屏(对局列表)根本不查法术名。模块求值即踢
// 加载、立即返回;加载完成前 getEnglishSpellName 走 fallback 链。
// 提示词路径不许降级:构建 prompt 前必须 await ensureSpellNames()
// (聚合入口见 data/ensure.ts)。
let spellNamesMap: Record<string, string> = {};
const spellNamesLoad = import("./spellNames.json").then((m) => {
  spellNamesMap = (m.default ?? m) as unknown as Record<string, string>;
});

export const ensureSpellNames = (): Promise<void> => spellNamesLoad;

export function getEnglishSpellName(
  spellId: string,
  fallback?: string | null,
): string {
  return (
    spellNamesMap[spellId] ??
    spellEffectData[spellId]?.name ??
    fallback ??
    spellId
  );
}
