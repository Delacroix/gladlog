/**
 * 减伤裁定册 —— 「对面交了这个,你还该不该继续打」。
 *
 * 为什么需要它:官方 `MITIGATION_TABLE` 的 `pct` 度量的是「平砍减伤有多少」,
 * 而教练要回答的是「这波击杀还打不打得动」。2026-08-17 的全表问卷证明这两件事
 * 不是一回事 —— 裁定人在**同一个百分比档内给出了相反的裁定**(30% 档三个「无条件」
 * 三个「看情况」;10% 档一个「无条件」一个「从不」),任何单一 pct 阈值最好也
 * 只能对上 30 条里的 23 条(77%)。分歧方向一致:被判「无条件」的那些都带着
 * 百分比之外的额外机制(免死 / 招架 / 附带自愈 / 分摊+抬血)。
 *
 * 所以裁定本身就是事实,只能由人给,不能从 pct 推导。本表照
 * `curatedAbilityFacts.ts` 的纪律:每条带 `source` 与 `approved: "YYYY-MM-DD user"`,
 * 格式不合 CI 直接红(见 `test/mitigationVerdicts.test.ts`)。
 *
 * 与 `MITIGATION_TABLE` 的分工:那张表回答「减伤多少」(官方 DB2,用于伤害算术),
 * 本表回答「该不该继续打」(人工签字,用于教练判断)。两张表的键集必须一致 ——
 * 一致性测试会在有人给 `MITIGATION_TABLE` 加条目却忘了裁定时变红。这是审计
 * (docs/coaching-grounding-audit.md)指出的「九张手工表只有一张有漏项检测」
 * 的直接补救。
 */
import { MITIGATION_TABLE } from "./mitigationData";

export type MitigationVerdict =
  /** 打进去就是白打 —— 与击杀是否成立无关,无条件产出「浪费」。 */
  | "unconditional"
  /** 只有在击杀不成立时才算该转火;击杀成立时顶着它打本来就是正确操作。 */
  | "kill-live-gated"
  /** 不构成真实阻碍,永不产出「浪费」判断(但仍留在减伤表里供伤害算术)。 */
  | "never"
  /** 语料里没出现过、裁定人未遇到过 —— 记成有据可查的空缺,不猜,不出面。 */
  | "unresolved";

export interface IMitigationVerdict {
  /** 官方中文名(取自 spellNamesZhGenerated),便于人核对。 */
  zh: string;
  /** 签字当时 MITIGATION_TABLE 里的官方数值,仅供对照 —— 判据不从它推导。 */
  officialPct: number;
  verdict: MitigationVerdict;
  /** 裁定人给出的、超出 pct 的额外理由(仅在有话说时存在)。 */
  note?: string;
  source: string;
  /** 必须是 `YYYY-MM-DD user`,由 CI 校验。 */
  approved: string;
}

/**
 * 「这波击杀还成立吗」的血线 —— 低于它算成立。
 *
 * **这是本仓库第一个接到「结果」而不是「发生率」上的阈值。** 依据是 2026-08-17
 * 在本机 300 回合 / 900 个敌方单位上实测的击杀转化率(触线后 10s 内死亡):
 *
 * ```
 *   ≤50%  6.3%    ≤35% 16.6%    ≤25% 33.5%    ≤20% 44.4%    ≤15% 52.1%
 * ```
 *
 * 另一口径(每个敌方单位取该回合最低血线,看最终死没死)显示同一方向且更陡:
 * 被打到 25–35% 的 104 个单位**无一死亡**。而当时 `deepDive.ts` 的
 * `OFFENSIVE_HP_THRESHOLD = 35` 对应的转化率只有 16.6%。
 *
 * 抑制不进这条判据:按抑制 0–20 / 20–40 / ≥40 三档分组后曲线基本重合
 * (≤20% 一行分别是 44.4 / 46.6 / 41.7),因为阈值条件在「已经被打到这个血线」
 * 这个观测值上,抑制的作用已经体现在里面了,再乘一次是重复计数。
 *
 * 「敌方治疗被控」同样不进判据:分组后杀窗内奶被控过的转化率反而更低
 * (≤25% 时 23.8% vs 46.3%),疑为选择偏差(硬打不动才去控奶)。它不是
 * 可用的正向预测因子。
 *
 * 改这个值需要重跑上面那个测量,不能只改常量 —— 判据即规范。
 */
export const KILL_LIVE_HP_PCT = 20;

/** 裁定人签字日期(全表同一次问卷)。 */
export const MITIGATION_VERDICTS_SIGNED_ON = "2026-08-17";

export const MITIGATION_VERDICTS: Record<string, IMitigationVerdict> = {
  "1022": {
    zh: "保护祝福",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "642": {
    zh: "圣盾术",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "45438": {
    zh: "寒冰屏障",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "31224": {
    zh: "暗影斗篷",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "186265": {
    zh: "灵龟守护",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "204018": {
    zh: "破咒祝福",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "196555": {
    zh: "虚空行走",
    officialPct: 100,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "47585": {
    zh: "消散",
    officialPct: 75,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "357170": {
    zh: "时间膨胀",
    officialPct: 50,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "61336": {
    zh: "生存本能",
    officialPct: 50,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "86659": {
    zh: "远古列王守卫",
    officialPct: 50,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "108271": {
    zh: "星界转移",
    officialPct: 40,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "33206": {
    zh: "痛苦压制",
    officialPct: 40,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "871": {
    zh: "盾墙",
    officialPct: 40,
    verdict: "unresolved",
    note: "语料 0/400(防护战在竞技场基本不出现,是取样问题不是技能问题);裁定人未遇到过,保持 unresolved。",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;语料 0 次,裁定人未遇到过,不猜",
    approved: "2026-08-17 user",
  },
  "196718": {
    zh: "黑暗",
    officialPct: 40,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "264735": {
    zh: "优胜劣汰",
    officialPct: 30,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "48792": {
    zh: "冰封之韧",
    officialPct: 30,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "118038": {
    zh: "剑在人在",
    officialPct: 30,
    verdict: "unconditional",
    note: "招架型,对近战近乎免疫,远高于记录的 30%",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "31850": {
    zh: "炽热防御者",
    officialPct: 30,
    verdict: "unconditional",
    note: "免死机制,远高于记录的 30%",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "184364": {
    zh: "狂怒回复",
    officialPct: 30,
    verdict: "unconditional",
    note: "30% 外加大量自愈",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "363916": {
    zh: "黑曜鳞片",
    officialPct: 30,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "104773": {
    zh: "不灭决心",
    officialPct: 25,
    verdict: "unconditional",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "498": {
    zh: "圣佑术",
    officialPct: 20,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "115203": {
    zh: "壮胆酒",
    officialPct: 20,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "22812": {
    zh: "树皮术",
    officialPct: 20,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "62618": {
    zh: "真言术:障",
    officialPct: 20,
    verdict: "unresolved",
    note: "2026-08-17 复核更正:**它没有被移除**。扩到 400 回合后,在 178 个含戒律牧的回合 / 207 个戒律牧单位实例里观测到 2 次施放(对照:痛苦压制 393 次)—— 极其罕见,但存在。先前『0/300』是样本未覆盖。真正未解的是它记录的 20%:该值来自手工 override 声称观测到的 DR 光环 81782,而 81782 在语料里 0 次,数值本身未经验证。裁定人未遇到过,保持 unresolved。",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;语料 0 次,裁定人未遇到过,不猜",
    approved: "2026-08-17 user",
  },
  "102342": {
    zh: "铁木树皮",
    officialPct: 20,
    verdict: "unconditional",
    note: "外置;裁定人判定其实际强度高于同档自用技能",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "51052": {
    zh: "反魔法领域",
    officialPct: 15,
    verdict: "kill-live-gated",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;只有击杀不成立时才算该转火",
    approved: "2026-08-17 user",
  },
  "386208": {
    zh: "防御姿态",
    officialPct: 15,
    verdict: "never",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;不构成真实阻碍,永不产出「浪费」判断",
    approved: "2026-08-17 user",
  },
  "586": {
    zh: "渐隐术",
    officialPct: 10,
    verdict: "never",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;不构成真实阻碍,永不产出「浪费」判断",
    approved: "2026-08-17 user",
  },
  "98008": {
    zh: "灵魂链接图腾",
    officialPct: 10,
    verdict: "unconditional",
    note: "裁定人指出:机制是分摊伤害+抬血量,官方表记的 10% 不度量它的实际强度",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;打进去就是白打,与击杀是否成立无关",
    approved: "2026-08-17 user",
  },
  "107574": {
    zh: "天神下凡",
    officialPct: 3,
    verdict: "never",
    note: "进攻大招,3% 减伤是副作用",
    source: "2026-08-17 减伤裁定问卷(32 条全表),artifact 63e64c88;不构成真实阻碍,永不产出「浪费」判断",
    approved: "2026-08-17 user",
  },};

/** 键集一致性:每个官方减伤条目都必须有裁定(测试里断言,这里只导出便于复用)。 */
export const MITIGATION_VERDICT_IDS: ReadonlySet<string> = new Set(
  Object.keys(MITIGATION_VERDICTS),
);

/** 未裁定 / 从不出面的条目不参与任何「浪费」判断。 */
export function mitigationVerdictOf(spellId: string): MitigationVerdict | null {
  return MITIGATION_VERDICTS[spellId]?.verdict ?? null;
}

/** 防止 MITIGATION_TABLE 被 tree-shake 掉导致一致性测试假绿。 */
export const MITIGATION_TABLE_KEY_COUNT = Object.keys(MITIGATION_TABLE).length;
