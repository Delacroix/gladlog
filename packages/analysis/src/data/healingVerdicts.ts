/**
 * 治疗裁定册 —— 「爆发已经打在脸上,按这个技能算不算一个答案」。
 *
 * 为什么需要它:系统里**没有「加血大技能」这个归类**。2026-08-23 的普查(用户提问
 * 「我们没有给加血大技能有归类吗」直接触发)把「挂 Defensive 牌子 + 官方数据说它治疗」
 * 的技能全列出来,一共 12 个,而它们的归类是三套东西交叉推出来的:
 *
 *   1. `SpellTag` 三个值 —— 加血只能挂 Defensive,和盾墙同一个牌子;
 *   2. 减伤体系三态 —— 在减伤表 / 登记为无减伤 / 什么都没有。「登记为无减伤」是目前
 *      最接近「这是加血不是挡伤」的表达,但它只是个否定句,不说它是什么;
 *   3. 手工名单 —— `bigDefensiveSpellIds` / `externalDefensiveSpellIds` /
 *      `TEAM_HEAL_CD_IDS` / `THROUGHPUT_EMPOWER_DEFENSIVE_IDS`。
 *
 * 后果是实测出来的:**意气风发 109304、恶魔变形 187827、吸血鬼之血 55233 三套归类
 * 一个都没落上** —— 官方数据明确说它们治疗,而系统对它们只知道「有个 Defensive 牌子」。
 * 它们和盾墙的区别、和绝望祷言的相同之处,今天都表达不出来。
 *
 * ## 这一册回答的是哪一维
 *
 * 「够不够得着队友」已经官方化了(`spellTargeting.ts` 的 `reachesAlly`),
 * 「是不是一堵墙」也有了(`abilityProfile.ts` 的 `isSurvivalWall`)。**缺的是治疗
 * 本身的分档**:一个 25% 的瞬发自愈和一个只在有人治你时才生效的受治疗增益,在
 * 「爆发窗口」这个语境里价值完全不同,而现在两者都只是「Defensive」。
 *
 * 和减伤裁定册(`mitigationVerdicts.ts`)完全同构:官方数据给**量**(治多少、
 * 增益多少 %),人给**判断**(这算不算一个答案)。2026-08-17 那次减伤问卷已经证明
 * 这两件事不能互相推导 —— 同一个百分比档内出现过相反的裁定。
 *
 * ## 签字纪律(照 `curatedAbilityFacts.ts`)
 *
 * `HEALING_VERDICTS` 只装**签过字**的条目,每条带 `source` 与
 * `approved: "YYYY-MM-DD user"`,格式不合 CI 直接红。研究做完但没批的放
 * `PROPOSED_HEALING_VERDICTS`(类型故意去掉 `approved`,不许伪造日期占位);
 * 获批后连同补上的签字戳迁入正册,并**从暂存区删除** —— 晋升即移除。
 *
 * ## 现状:只记录,不接线
 *
 * 本册**尚未被任何判据消费**。这是故意的:12 条一条都还没签字,而按 CLAUDE.md 的
 * 价值门规则,没签字的判断不许悄悄进产品。接线计划(等签完再做,每处带前后数字):
 * `cd-waste`、低压力免责注、`death-unused-defensive` 现在问的都是
 * `tag === "Defensive"`,该问的是「这是不是一个爆发答案」。
 */
import { classMetadata } from "./classSpells";
import { SPELL_NAMES_ZH_GENERATED } from "./spellNamesZh";
import { SpellTag } from "./spellTypes";
import { abilityProfile } from "./abilityProfile";

export type HealingVerdict =
  /** 爆发打在脸上时按下去能改变这一波的结果(免疫/大额瞬发/免死/吸收顶住)。 */
  | "burst-answer"
  /** 只对持续掉血有用;爆发窗口里按了也白按,该按的是别的东西。 */
  | "sustain-only"
  /** 它本身不产生生存,只是**放大别人的治疗** —— 没人治你的时候按它等于没按。 */
  | "needs-healer"
  /** 未裁定 —— 记成有据可查的空缺,不猜,不出面。 */
  | "unresolved";

/** 官方数据快照,仅供人核对;裁定**不从它推导**(见文件头)。 */
export interface IHealingOfficialFacts {
  /** 治疗施法者自己(Effect 10/136 或 aura 8/20)。 */
  healsSelf: boolean;
  /** 治疗别人。 */
  healsOthers: boolean;
  /** 提高**受到**的治疗量 %(aura118/259)。 */
  healingReceivedPct?: number;
  /** `isSurvivalWall` 说它是不是墙(减伤/吸收/免疫三者有其一)。 */
  isWall: boolean;
}

export interface IHealingVerdict {
  /** 官方中文名(取自 spellNamesZhGenerated),便于人核对。 */
  zh: string;
  official: IHealingOfficialFacts;
  verdict: HealingVerdict;
  /** 裁定人给出的、官方数据之外的理由(仅在有话说时存在)。 */
  note?: string;
  source: string;
  /** 必须是 `YYYY-MM-DD user`,由 CI 校验。 */
  approved: string;
}

/**
 * 已签字的裁定。
 *
 * **当前为空** —— 2026-08-23 建册当天,12 条全部在下方暂存区等签字。空表在扫描里
 * 和「100% 健康」长得一样,所以 `curatedIdRegistry` 登记的是两张表的并集(见那边
 * 的注册项),完备性由 `test/healingVerdicts.test.ts` 的键集断言兜住:任何一个
 * 「Defensive 牌子 + 官方说它治疗」的技能,必须出现在正册或暂存区之一。
 */
export const HEALING_VERDICTS: Record<string, IHealingVerdict> = {};

/** 待签暂存区。获批后迁入 `HEALING_VERDICTS` 并从这里删除(晋升即移除)。 */
export interface IProposedHealingVerdict extends Omit<
  IHealingVerdict,
  "approved" | "verdict"
> {
  /** 提议的档位 —— **提议,不是裁定**,消费方一律不许读暂存区。 */
  proposed: HealingVerdict;
  /** 什么情况下这个提议会被推翻(写给裁定人看的,不是自我保护)。 */
  wouldFlipIf: string;
}

const SRC =
  "2026-08-23 建册普查:取 classMetadata 里 Defensive-tagged 且 abilityProfile 官方数据说它治疗的全部技能(12 条)";

export const PROPOSED_HEALING_VERDICTS: Record<
  string,
  IProposedHealingVerdict
> = {
  // ── 官方口径已是墙,治疗只是附带 ──────────────────────────────────────
  "642": {
    zh: "圣盾术",
    official: { healsSelf: true, healsOthers: false, isWall: true },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf: "不会 —— 全学派免疫 127,官方 100% 减伤",
  },
  "45438": {
    zh: "寒冰屏障",
    official: { healsSelf: true, healsOthers: false, isWall: true },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf: "不会 —— 全学派免疫 127,官方 100% 减伤",
  },
  "47585": {
    zh: "消散",
    official: { healsSelf: true, healsOthers: false, isWall: true },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "官方 75% 减伤 + 自愈;若裁定人认为 75% 挡不住 12.1 的爆发,则降为 sustain-only",
  },
  "108416": {
    zh: "黑暗契约",
    official: { healsSelf: true, healsOthers: false, isWall: true },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "吸收盾 + 自愈,吸收量取决于当前生命值 —— 若裁定人认为血少时吸收太小、不构成爆发答案,则降档",
  },
  "116849": {
    zh: "作茧缚命",
    official: {
      healsSelf: false,
      healsOthers: false,
      healingReceivedPct: 50,
      isWall: true,
    },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "吸收 + 受治疗 +50%。**吸收那一半让它自己就能扛**,所以提 burst-answer 而不是 needs-healer;若裁定人认为没人治时它形同虚设,则改 needs-healer",
  },
  "740": {
    zh: "宁静",
    official: { healsSelf: false, healsOthers: true, isWall: true },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "团队引导治疗。**它是引导 —— 要站桩读条**,若裁定人认为爆发窗口里根本读不完,则降为 sustain-only",
  },

  // ── 官方口径不是墙:治疗就是全部机制 ──────────────────────────────────
  "19236": {
    zh: "绝望祷言",
    official: { healsSelf: true, healsOthers: false, isWall: false },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "瞬发大额自愈,没有任何减伤/吸收。用户 2026-08-23 已裁定它「算防御,但仅限于自己挨打」—— 那是「算不算防御」这一维,**不等于**「扛不扛得住爆发」。若裁定人认为一口自愈填不上一轮集火,则降为 sustain-only",
  },
  "109304": {
    zh: "意气风发",
    official: { healsSelf: true, healsOthers: false, isWall: false },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "同绝望祷言:瞬发自愈、零减伤。**这是三个今天完全没有归类的技能之一**",
  },
  "187827": {
    zh: "恶魔变形",
    official: { healsSelf: true, healsOthers: false, isWall: false },
    proposed: "unresolved",
    source: SRC,
    wouldFlipIf:
      "官方只挖到「治疗自己」一条,而它实际还给最大生命/护甲/闪避 —— **官方数据在这一条上明显不全**,不猜。**今天完全没有归类的三个之一**",
  },

  // ── 受治疗增益:自己不产生生存 ────────────────────────────────────────
  "47788": {
    zh: "守护之魂",
    official: {
      healsSelf: false,
      healsOthers: false,
      healingReceivedPct: 60,
      isWall: false,
    },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "官方只给了受治疗 +60%,**免死那一半没有任何官方行**(它才是爆发答案的理由)。若裁定人按官方口径只认 +60%,则应为 needs-healer",
  },
  "55233": {
    zh: "吸血鬼之血",
    official: {
      healsSelf: false,
      healsOthers: false,
      healingReceivedPct: 30,
      isWall: false,
    },
    proposed: "needs-healer",
    source: SRC,
    wouldFlipIf:
      "官方只给受治疗 +30%,它自己不治疗;实际还带最大生命提升(官方未挖到)。若裁定人认为抬血那一半本身就是爆发答案,则升为 burst-answer。**今天完全没有归类的三个之一**",
  },
  "64843": {
    zh: "神圣赞美诗",
    official: {
      healsSelf: false,
      healsOthers: true,
      healingReceivedPct: 4,
      isWall: false,
    },
    proposed: "burst-answer",
    source: SRC,
    wouldFlipIf:
      "团队引导治疗,和宁静同形态 —— 引导要站桩。两条应当同档,若宁静降档它也降",
  },
};

/** 这一册的完备域:挂 Defensive 牌子 **且** 官方数据说它治疗的技能。 */
export function healingVerdictDomain(): string[] {
  const ids = new Set<string>();
  for (const cls of classMetadata) {
    for (const a of cls.abilities) {
      if (!a.tags.includes(SpellTag.Defensive)) continue;
      const p = abilityProfile(a.spellId);
      if (!p.healsSelf && !p.healsOthers && p.healingReceivedPct === undefined)
        continue;
      ids.add(a.spellId);
    }
  }
  return [...ids];
}

/** 已签字的裁定;未签或不在册一律返回 `undefined` —— 调用方不许把「查不到」
 *  当成任何一档(这正是本册要消灭的那种「不知道就当没有」)。 */
export function healingVerdictOf(spellId: string): HealingVerdict | undefined {
  return HEALING_VERDICTS[spellId]?.verdict;
}

/** 人核对用:官方中文名。 */
export function healingVerdictZh(spellId: string): string | undefined {
  return (
    HEALING_VERDICTS[spellId]?.zh ??
    PROPOSED_HEALING_VERDICTS[spellId]?.zh ??
    SPELL_NAMES_ZH_GENERATED[spellId]
  );
}
