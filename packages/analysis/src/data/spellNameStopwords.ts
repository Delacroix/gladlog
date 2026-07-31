/**
 * 英文技能名倒排索引(spellNameLookup.ts 的 englishNameIndex())停用词表。
 *
 * 背景:DB2 法术名宇宙里混着大量单个常见英文单词,撞车从未被语料真正观测过
 * 的罕见/占位法术 id;inlineRich.tsx:135-138 的兜底(本场用过 ?? 语料观测过 ??
 * 最小 id)在前两级全落空时会退到"数值最小的 id",与语义无关、图标常是占位图
 * (如 "Stun"→id 56→通用锤子 inv_mace_02)。AI 正文里这类常见词高频出现,于是
 * 把普通英语单词包成了错误技能图标。完整审计 provenance 见 commit 历史
 * (fix(analysis): 内联图标停用词表落地 及其复核轮),这里只留可执行判据。
 *
 * 收录判据(REVIEWABLE,非"常见词"三个字就够——"Charge" 也是常见词,但语料
 * 天天观测到,必须保留图标,不能进本表):
 *   (a) 该名字下所有候选 id 都不在 OBSERVED_SPELL_IDS 里;或
 *   (b) 有 id 落在 OBSERVED_SPELL_IDS,但审计实证那是占位/边角效果
 *       (如 "Death"=id 327095,Shadowlands 盟约边角效果,非教学向技能)。
 *
 * 新增前重跑同一脚本复核,别凭感觉加词;漏收(以后语料报出来再补)比错收
 * (让真实技能图标消失、且更难被发现)便宜,批次故意保守。
 */
export const SPELL_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  // 审计实证撞车(判据 b)
  "Stun",
  "Death",
  // 机械扫描:零观测 id + 通用频率(google-10000-english)前 1000(判据 a)
  "Search",
  "Web",
  "Message",
  "Book",
  "Special",
  "Open",
  "Return",
  "Food",
  "Select",
  "Start",
  "Air",
  "Yes",
  "Test",
  "Play",
  "Memory",
  "Sell",
  "Experience",
  "Release",
  "Analysis",
  "Learning",
  "Run",
  "Net",
  "Radio",
  "Gold",
  "Land",
  "Style",
  "Document",
  "Reading",
  "Cover",
  "Submit",
  "Engineering",
  "Speed",
  // 零观测 id + 竞技场教练叙事领域高频,通用频率表排名靠后但人工加判(判据 a)
  "Target",
  "Move",
  "Focus",
  "Break",
  "Jump",
  "Pet",
  "Block",
  "Shot",
  "Impact",
  // 复核轮加判(判据 a):Heal 47 个候选 id 零观测,healer 教练产品里"Heal"
  // 裸词是最高频复现路径之一;Push/Pull 各 1 个候选 id 同样零观测。
  // Damage/Kill/Cast/Range 已核实:当前 SPELL_ICONS_GENERATED(图标宇宙)里
  // 没有任何 id 用这些确切名字——不在 englishNameIndex 遍历的候选集合内,
  // 今天不构成风险,故不收录;若未来 datagen 重跑把它们带入图标宇宙,需
  // 重新跑同一脚本判定,不能想当然搬进来。
  "Heal",
  "Push",
  "Pull",
]);
