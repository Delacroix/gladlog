# 候选菜单信号扩容第一批(HEAL/POSITION/COOLDOWN + 驱散升维)设计

日期:2026-08-07 · 背景:治疗视角菜单驱散/饰品四类占 64%(#22 临时压频只到 58.6%,
根治=扩容);BACKLOG #18 第二批。发生率实证(200 场/899 source,报告
`signal-rates-report.md`,脚本 tmp-signal-rates.mts 评审后删)先行,数字如下。

## 三个新候选类型 + 一个字段升维

| 候选                             | 判据(全部既有谓词)                                                                                                                      | 实证                                        | 门槛/cap                         | facts                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `healing-gap`(HEAL-001)          | `detectHealingGaps`;owner 为治疗;`freeCastSeconds ≥ HEAL_GAP_FREE_MIN_S(4)` 且 `mostDamagedAmount > 0`                                  | 5.3% 轮,54 条                               | cap 2(按 mostDamagedAmount 降序) | t(fromSeconds floor)、durationS、freeS、pressured(短名)、pressuredSpec                                                     |
| `position-mistake`(POSITION-001) | `computeOwnerPositionEvents`;STAYED_IN 须 `stayedInHadRealCost`;三类都接(MISSED_PUSH/CD_OUT_OF_RANGE 治疗语料现为 0,面向未来 DPS owner) | 10.9% 轮,118 条                             | cap 2(按 hpMin 升序=损失最重)    | t、kind(走位事件类型)、enemy?、hpStart?、hpMin?、spell?、dist? —— 与 deepDive `position` item facts 同字段名(单源渲染习惯) |
| `cc-held`(COOLDOWN-001)          | owner 的 CC 大招(`ccSpellIds` ∩ `extractMajorCooldowns`)availableWindows 连续可用 ≥ `CC_HELD_MIN_S(90)`                                 | ≥90s 25.3% 轮,259 条(60s 档假阳性风险高,弃) | cap 2(按窗口时长降序)            | t(窗口起点)、spell、heldS、windowEndT                                                                                      |
| missed-cleanse 升维(DISPEL-002)  | 既有候选加 `latencySeconds`(CC 落地→被驱间隔;实证晚驱仅占已驱 7.1%,不值新类型)                                                          | 69 条晚驱                                   | 不新增类型、不改 cap             | 既有 facts + latencyS(仅当有值)                                                                                            |

- 三个新类型合计预期菜单占比 **8-12%**(接受阶段性;15-25% 原目标依赖 #18 剩余候选)。
- 可教信号门精神:门槛常量集中声明、单点可调;POSITION 三态纪律(无位置数据不产出,
  绝不当 0);cc-held 对 kit 无 CC 大招的 owner 自然零产出(845/898 轮有)。
- prompt:buildFindingsPrompt 为三个新类型加图例行(照既有类型行文;cc-held 图例
  须防「因果断定」措辞——「长期未使用」是事实,「因此输了」是禁语)。
- `PROMPT_VERSION` 例行 +1。
- **#22 不随本批撤销**:占比不足以压回潮,改注「待第二波(DEATH-002/OFFENSIVE 类)
  后评估」。

## 验收

- 单测:每类型 门槛边界/排序保最重/cap;POSITION 无数据轮零产出;cc-held 无 kit 零产出;
  升维字段仅在有值时出现。
- 语料复扫(同 200 场判据):三新类型条数与实证吻合(54/118/259 ±门槛效应);
  驱散/饰品四类占比变化如实记录(预期 58.6% → ~52%)。
- presubmit 全绿;发生率报告归档进本 spec 同目录不 commit(.superpowers gitignored),
  关键数字已抄录上表。
