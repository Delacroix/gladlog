/**
 * Generated at: 2026-08-23T03:00:11.243Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellEffect — aura 69 (absorb), Effect 10/136 + aura 8/20
 *   (healing, split self vs ally by ImplicitTarget), aura 118/259
 *   (healing received %), aura 31 (haste %). One EffectTriggerSpell hop,
 *   dummy rows ignored unless they are all the spell has.
 *   See scripts/datagen/genAbilityEffects.ts for the rules and controls.
 * Absent field = the official rows do not show that effect. Treat as
 *   "not known to do this", never as proof of absence for a spell whose
 *   implementation is a dummy row + server script.
 * ids: 2232 — absorb 109, heals self 119, heals others 264, healing-received 9, haste 70, hits enemy 1638, enemy AoE 566, deals damage 1166
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

// 动态载入(2026-08-22):静态 import 会把这份数据压进 renderer 主 chunk —— 三份
// 生成物一度把它从 3,130 kB 顶到 3,494 kB,firstPaint 预算随即三次里红两次。
// 与 spellNames/talentIdMap 同一约定:模块求值只发起载入,访问器在数据到位前
// 返回空 —— 三个消费谓词的失效方向都是「少出面」(reachesAlly→false 门更严、
// immunityCoversSpell→undefined 回退手工规则、isSurvivalWall→false 不出面),
// 不会造成假指控。**构建 prompt 的入口必须先 await ensureAnalysisData()**,
// 这三份已并入那个聚合入口(data/ensure.ts)。
let loaded: Record<string, AbilityEffectFacts> = {};
const load = import("./abilityEffectsGenerated.json").then((m) => {
  loaded = (m.default ?? m) as unknown as Record<string, AbilityEffectFacts>;
});

export const ensureAbilityEffects = (): Promise<void> => load;

export type AbilityEffectFacts = {
  absorbs?: true;
  healsSelf?: true;
  healsOthers?: true;
  healingReceivedPct?: number;
  hastePct?: number;
  hitsEnemy?: true;
  enemyAoE?: true;
  dealsDamage?: true;
};

export function ABILITY_EFFECTS_GENERATED(): Record<string, AbilityEffectFacts> {
  return loaded;
}
