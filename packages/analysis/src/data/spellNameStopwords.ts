/**
 * 英文技能名倒排索引(spellNameLookup.ts 的 englishNameIndex())停用词表。
 *
 * 背景:DB2 法术名宇宙(spellNames.json,41 万条)里混着大量单个常见英文单词
 * ——多是过时/内部/covenant 一次性效果,从未在真实语料里被真正当作"这场用了
 * 这个技能"来观测(不在 OBSERVED_SPELL_IDS 里)。#15 内联富文本
 * (inlineRich.tsx)扫描 AI 正文时按最长匹配抓取这些名字,抓到后走
 * `ctx.match.ids.find(本场用过) ?? ctx.deps.observed.find(语料观测过) ?? e.ids[0]`
 * 兜底(inlineRich.tsx:135-138)——当同名多个 id 全部"本场未用 + 从未观测"时
 * (即本表的收录判据),兜底退到"数值最小的 id",与语义无关,图标随机且经常是
 * 占位图标(如 "Stun" 撞车 id 56 → 通用锤子图标 inv_mace_02)。AI 正文里这类
 * 常见词高频出现(如 "full Stun"),于是把普通英语单词包成了错误技能图标——
 * 这是 2026-07 全量审计的 Critical 发现。
 *
 * "Death" 类此前在 f79e90c(#15 生产缺陷修复,超短占位名过滤)里被显式推迟,
 * 承诺"spec 预留停用词表出口,真在生产语料报出来再加"——但从未真正实现,
 * 本文件补上这个承诺过的机制。
 *
 * 收录判据(REVIEWABLE,非"常见词"三个字就够——例如 "Charge" 也是常见词,
 * 但它是真实的、语料里天天出现的战士技能,理应保留图标,绝不能进本表):
 *
 *   只有当一个名字满足以下两条之一,才够格进本表:
 *     (a) 该名字下所有候选 id 都不在 OBSERVED_SPELL_IDS 里(语料从未观测到
 *         这个 id 被真正施放/命中过)——意味着索引里这个名字的图标映射纯属
 *         DB2 数值巧合,从未被证明"对";或
 *     (b) 该名字虽然有 id 落在 OBSERVED_SPELL_IDS 里,但审计实证那是占位/
 *         次要效果(如 "Death"=id 327095,图标 spell_necro_deathlyecho,是
 *         Shadowlands 军团意志/盟约的边角效果,不是任何职业教学向技能,语料
 *         里出现也只是背景噪音,并非 AI 会援引的"这个技能")。
 *
 *   批次一实际构成:
 *     1. 审计直接实证的真实撞车(判据 b):Stun、Death。
 *     2. 判据 (a) 的机械扫描 —— 对 spellIconsGenerated 名表跑脚本:名字=单个
 *        大写开头英文词、长度≥3(与 englishNameIndex 已有过滤对齐)、
 *        google-10000-english 频率表排名 <1000(足够"寻常"、大概率会出现在
 *        AI 教练正文里)、且该名下所有 id 均不在 OBSERVED_SPELL_IDS——命中
 *        32 个词(Search/Web/Message/Book/Special/Open/Return/Food/Select/
 *        Start/Air/Yes/Test/Play/Memory/Sell/Experience/Release/Analysis/
 *        Learning/Run/Net/Radio/Gold/Land/Style/Document/Reading/Cover/
 *        Submit/Engineering/Speed)。脚本同时验证了反例:"Charge"/"War"/
 *        "Ready"/"Opportunity"/"Warning" 因命中 OBSERVED_SPELL_IDS 被自动
 *        排除,未进候选表——判据本身能挡住 "Charge" 这类真实技能,不用靠
 *        人工记忆。
 *     3. 判据 (a) 但通用频率表排名 ≥1000、人工加判(领域频率 > 通用语料
 *        频率:这些词在竞技场教练叙事里比日常英语常见得多,且同样是零观测
 *        id、图标映射同样是巧合):Target(切目标)、Move(走位)、
 *        Focus(集火/焦点目标)、Break(打断视线/破 CC 常用短语)、
 *        Jump(跳柱子)、Pet(宠物职业天天提)、Block(格挡类叙事)、
 *        Shot("那一箭"类描述)、Impact("造成很大影响")。
 *
 *   批次一故意保守:漏收(以后再报出来再补,像 Death 的先例)代价是偶尔漏
 *   一个图标,便宜;错收会让某个真实技能的图标消失,比"多包一个错图标"更
 *   难被人工注意到,所以本批只收有把握的。新增前先跑同一脚本复核,别凭感觉
 *   加词。
 */
export const SPELL_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  // 审计实证撞车(判据 b)
  "Stun",
  "Death",
  // 机械扫描:零观测 id + 通用频率前 1000(判据 a)
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
  // 零观测 id + 竞技场教练叙事领域高频(判据 a,人工加判)
  "Target",
  "Move",
  "Focus",
  "Break",
  "Jump",
  "Pet",
  "Block",
  "Shot",
  "Impact",
]);
