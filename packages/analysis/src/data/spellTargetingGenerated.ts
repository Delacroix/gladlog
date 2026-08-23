/**
 * Generated at: 2026-08-23T02:59:08.863Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellEffect.ImplicitTarget_0/_1 (DifficultyID 0), dummy
 *   effects ignored unless they are all the spell has, one
 *   EffectTriggerSpell hop followed. See scripts/datagen/genSpellTargeting.ts
 *   for the rule, the traps it encodes and the two-directional
 *   ground-truth assertion.
 * true  = at least one effect reaches a FRIENDLY unit other than the caster
 * false = the spell only ever affects the caster (and/or enemies)
 * absent = no official effect row; consumers must fall back, never assume
 * ids: 5367 (530 reach others)
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
let loaded: Record<string, boolean> = {};
const load = import("./spellTargetingGenerated.json").then((m) => {
  loaded = (m.default ?? m) as unknown as Record<string, boolean>;
});

export const ensureSpellTargeting = (): Promise<void> => load;

export function SPELL_REACHES_OTHERS_GENERATED(): Record<string, boolean> {
  return loaded;
}
