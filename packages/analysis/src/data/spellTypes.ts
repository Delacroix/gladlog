/**
 * Spell tag enum (originally defined in this repository).
 * Older code imported an identically named enum through the parser package;
 * the member names are an interoperability fact of our own utils, so they are
 * declared independently here without referencing any upstream expression.
 */
export enum SpellTag {
  Offensive = "Offensive",
  Defensive = "Defensive",
  Control = "Control",
  // 2026-08-22(GH #29 阶段 0):删掉了 `External = "External"`。它从来没有生产者
  // —— classSpells.ts 的 122 条 ability 一条都没带它,discoveryRules 的三条名字
  // 正则只产 D/O/C,extractMajorCooldowns 的两处运行时注入分别给 Defensive 和
  // Offensive。可它有 8 处消费分支,判据因此看着是三选一、实际只跑两条:GH #28
  // 那条「队友死亡处印出绝望祷言」的判据原文是
  // `isDyingPlayer || isExternal || isHealerSpec(...)`,中间那项永远 false,于是
  // 真正在跑的规则是「治疗的每一个防御 CD」——死分支不是无害的,它把规则伪装
  // 成了另一个样子。外放技能(苦修、庇护…)本来就按 Defensive 记,能不能作用到
  // 队友由 data/spellTargeting.ts 的官方 targeting 回答。
}
