/**
 * zh 官方本地化技能名 → EN 技能名(spellNameZhLint.ts 的检测/修复用查表)。
 *
 * 背景:DeepSeek 生产模拟(220 场,`ds-sim-2026-07-31/scan200.md`)发现 AI
 * 教练文本偶发把技能名译成官方中文本地化名(如"肾击"代替"Kidney Shot"),
 * 违反系统提示"技能名保持英文"的产品契约,且破坏 #15 内联图标扫描器(只认
 * 英文名 token)。修强系统提示后(commit b824e72)14/14 → 3/14 残留,证明这是
 * 概率性模型行为、不是可被 prompt 消灭的确定性 bug——需要一道确定性门规。
 *
 * 收录判据(REVIEWABLE):零候选不是"全量 spellNamesZhGenerated 表机械过滤",
 * 而是**逐条真实生产语料验证过的正向清单**——原因见下方"为什么不用机械
 * 长度过滤"。每条都满足:
 *   (a) 在真实 DeepSeek 生产语料(ds-sim-2026-07-31 220 场 + agy-sim-2026-07-31
 *       300 场 + win16-sim-2026-07-31 41 场,共 561 场)中被观测到裸中文形式
 *       出现(未紧跟"EN（zh）"这一产品允许的行内注解形态——见 spellNameZhLint.ts
 *       的 isGlossed 守卫);
 *   (b) 人工逐条读取上下文确认是**技能引用**(通常同句/同段落里紧邻其他
 *       正确保留英文的技能名,构成"同一响应内前后不一致"的确凿证据),不是
 *       泛化动词/名词短语;
 *   (c) 该 id 落在 spellNamesZhGenerated(生产 zh 表,宇宙=图标集∩真翻译)里,
 *       即产品实际会展示/引用的技能。
 *
 * 为什么不用机械长度过滤(≥4 字符 + 唯一 EN 映射 + observedSpellIdsGenerated
 * 限定):试过。候选宇宙 1720 条,但把这套机械表跑对同一 561 场真实语料后,
 * 命中的 37 个不同 zh 名里有 13 个(35%)是假阳性——常见战术/口语短语恰好与
 * 某个冷门技能的官方译名撞车(集中火力/战斗分析/PvP饰品/危急时刻/快速治疗/
 * 驱散魔法/防御姿态/生死攸关/剑在人在/局势逆转/致命一击/法术反射/解除诅咒,
 * 完整清单与理由见 spellNameZhLintStopwords.ts)。命中之外未被语料触发的
 * 1683 条完全没有验证,不能假设它们没有同样问题。误收的代价是自动修复会把
 * 一句正常中文教练建议里的普通词替换成英文单词、读起来很怪——precision 优先
 * 于 recall,所以只收"真被观测到过"的条目,而不是"理论上可能是技能名"的
 * 全量表。新条目只能来自新语料证据,不能凭长度/唯一性猜。
 *
 * 2 个例外(长度 <4 甚至 <3 字符,正常情况下会被"生僻词才用长名字"的直觉
 * 排除,但语料里是最高频、最确凿的违规,必须显式收录):
 *   - "肾击"(Kidney Shot 缩写形式,2 字符):561 场语料里唯一在 mitigation
 *     后仍零星滑回中文的技能名(commit b824e72 记录),ds-sim 语料里 7/220
 *     场直接命中,全部是"肾击某目标"的动词式技能引用,无一是泛化词组。
 *   - "熊形态"(Bear Form,3 字符):agy-sim+ds-sim 共 4 场命中,全部紧邻
 *     "Barkskin"/"Ironbark"等正确保留英文的技能名同句出现。
 */
export const SPELL_NAME_ZH_TO_EN: Readonly<Record<string, string>> = {
  肾击: "Kidney Shot",
  熊形态: "Bear Form",
  迅捷治愈: "Swiftmend",
  冰冻陷阱: "Freezing Trap",
  铁木树皮: "Ironbark",
  神圣震击: "Holy Shock",
  守护之魂: "Guardian Spirit",
  生存本能: "Survival Instincts",
  保护祝福: "Blessing of Protection",
  制裁之锤: "Hammer of Justice",
  精神鞭笞: "Mind Flay",
  焦油陷阱: "Tar Trap",
  野性成长: "Wild Growth",
  自然迅捷: "Nature's Swiftness",
  十字军打击: "Crusader Strike",
  凋零缠绕: "Death Coil",
  天灾打击: "Scourge Strike",
  自由祝福: "Blessing of Freedom",
  牺牲祝福: "Blessing of Sacrifice",
  牺牲咆哮: "Roar of Sacrifice",
  大地之盾: "Earth Shield",
  风领主之击: "Strike of the Windlord",
  终极苦修: "Ultimate Penitence",
  光环掌握: "Aura Mastery",
  能量灌注: "Power Infusion",
};
