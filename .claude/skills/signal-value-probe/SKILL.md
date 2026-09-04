---
name: signal-value-probe
description: 用户提出、复活、重设计或想下架一条教练信号(「新信号想法」「值不值得」「尝试复活」「都做了试试 ab test 一下」「反向问一下 llm 用没用」),或者要用归档语料给某个「该按没按 / 交多了 / 浪费了」类判断找依据时读这个。在写任何产品代码、跑标定或批量模型调用之前。
---

# 教练信号价值探针(2026-08-28 至 09-03 同一套流程走了七遍沉淀)

CLAUDE.md 的 Value-Gate Rule 说的是**原则**;这里是**顺序、工具和本周踩过的坑**。
本周七个实例:crisis-no-response、七条老信号结果探针、GH #60 爆发窗 + over-react、
missed-sync-window 复活、GH #31 击杀窗、GH #24 定身可达、09-04 占比探针。
每次重新组装一遍,平均半天;照下面走是两小时。

## 顺序(不许调换)

**0. 先查有没有判过。** 仓库内:`docs/BACKLOG.md` 的负结果条目(#38 (g) 之类)、
`docs/coaching-grounding-audit.md`;eval-private 内(没挂载就写明没查):`ledger.md`、
`reports/signal-outcomes-2026-08-30/`。整场溢出率四段全平这种结论已经在案,
条件版(窗口内)值得再测,但不值得跳过测。

**1. 目标结论句 + 真实对局例子,先给用户。** 手写「如果这条信号精良,它在这场会说什么」,
再**确定性地**渲染 1–3 个例子(候选行 / 上下文行 + 周围 `[STATE]` 行,不调模型):
一次性生成器照 `packages/eval/scripts/offcdExampleGen.ts` / `kwV2ExampleGen.ts` 的写法,
只 import 已导出的谓词。`headlessAnalyze.ts` 会真的调模型,是给 review bench 灌缓存用的,不是这一步的工具。
句子自己写不成指控 → 直接记负结果,停。crisis-no-response 第一版四个例子被否掉才换口径,
mana 候选跳过这一步烧了半天。
**用户给的数字(50%、10 秒、60%)是假设,不是常量**:探针里当敏感性行测,产品继续键在共享常量上
(如 `CRISIS_HP_PCT`),除非用户明确裁定一条新事实 —— 否则同一事实会长出第三个阈值。

**2. 决策点谓词从 analysis 导出,探针只 import。** 先例 `crisisDecisionPoints` /
`burstWindowDecisionPoints` 同时供产品、扫描和门规。探针里手写第二套谓词 = 违反共享谓词规则,
而且沉默 id 只覆盖 3/61 那种错就是这么漏的。**行为人 ≠ 决策点主人时分开算**:队友穿越用
`crisisDecisionPoints(teammate, …, "dps")` 定时刻,可行性看行为人(治疗)自己的
`buildCannotCastIntervals` / 射程 / 存活。

**3. 探针 = 决策点 → 行为 → 结果对照。** 模板 `packages/eval/scripts/signalOutcomeProbe.ts`
(七条信号的写法都在里面),行为分布模板 `behaviorPriorScan.ts`,分段梯度 `signalSkillGradientScan.ts`。
结果口径:本人 10 秒内阵亡;单排按 15 秒内我方任何人阵亡(用户 08-30 裁定)。
分段 = (赛制, ISO 周) 内百分位,**绝不用绝对分**(赛季通胀,用户 08-29 裁定)。
分母 = 有机会的回合/窗口,不是回合数。跑法:≤600 场切片单进程前台、显式 timeout;全量 18k
按 `update-wow-data.md` 6b-pre-2 的写法 ≤3 个 `nice` 分片、脚本 `trap` 清子进程,绝不更多。

**4. 读数字前先清洗三道门:** 可行性(被控/锁定/3 秒内死/目标够不到,复用
`rootReachability.canReachTargetAt`)、开场(t < 30 s)、窗内目标已死。
missed-sync-window 单排「平(+0.7pp)」是脏分母假象,清洗后 +4.5pp。
**结果泄漏**:指标窗口与结果窗口重叠时(10 秒溢出率 vs 10 秒内阵亡 —— 3 秒就死的目标溢出≈0),
数字会反向读成「浪费 = 活得好」;按「活过整个窗口」条件化或截断到结果之前。

**5. 指控类型决定检验方法。** 「该按没按」→ 第 3 步的结果对照就够。
「交多了 / 浪费了 / 反应过度」→ **必须回合内配对 DiD**;原始后账 +14~17pp 全是长 CD 阴影伪影
(180 秒的技能之后每个窗口都还在转)。cd-spent-idle 与 over-react 两条浪费类指控都这么死的,
先跑 DiD 再谈实现。DiD 目前只有 eval-private 里的 python 范本、仓库内没有工具 —— 下次做的时候
转正到 `signalOutcomeProbe.ts` 旁边,不要手搓第二套。

**6. 门槛:** 每个 bracket 内对比 ≥3pp、≥2 个 bracket 单调、附二项 95% CI;
**全量语料跑完再下结论**。本周四次部分数据翻盘:20 场 88% vs 36% 扩样后持平、
3,246 场 39% 全量 29.7%、顶级段 −2.8pp 全量 +7.5pp、O1 单排反向。

**7. 结论只有四种形态,下架是用户的裁决:** 候选(指控,带参照句和 ≥3pp 最小对比门)/
上下文事实行(不指控,如 `[ROOT]` `[BURST ANSWERED]`)/ 图例里的参照句 / 退役。
带参照句的信号一律配最小对比门(参照差 <3pp 不出面)。

**8. 接线后的验收与 A/B。** `acceptanceCapture.ts` 前后各一份(哈希 + healer:/dps: 逐类计数 +
关键字行);参照表进 `docs/commands/update-wow-data.md` 的 6b-pre 段;渲染出来的参照数字加
`promptQualityCheck.ts` hardFailure 一类;`PROMPT_VERSION` bump。A/B 走 `docs/commands/eval-ab.md`
findings 模式,盲评 n≤24 必然 inconclusive,裁决靠确定性指标 + 反向探针(那份文档有节)。

## 合理化对照表

| 想法                                        | 现实                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| 「数字全对了,先标定/A/B」                   | 08-16 两条 mana 候选全对、一个例子被毙。第 1 步没过,后面全是沉没成本            |
| 「先跑 2,000 场看趋势」                     | 本周四次翻盘全是部分数据。趋势只能决定要不要跑全量,不能进结论                   |
| 「胜负差就是效果」                          | 胜负是循环轴;分段才是外部真相,而且先分 bracket 再看(池化必出辛普森)             |
| 「触发率高说明重要」                        | 触发率高通常说明分母脏;cc-locked 87% 触发、输赢差 2.6pp                         |
| 「对面爆发时他交太多了」                    | 浪费类指控没有 DiD 证据就是零证据,两连败                                        |
| 「用户很兴奋、今晚要用,先做进去探针明天补」 | 今晚能诚实给的只有第 1 步的渲染例子(worktree dev 构建里看),不是候选、更不是发版 |
| 「梯度为正说明信号有效」                    | 正梯度全是「别人对你做了什么」,分段描述整个房间,按构造验证不了                  |

## 工具速查

| 要回答                            | 用                                                                          |
| --------------------------------- | --------------------------------------------------------------------------- |
| 这个状态下高手怎么做              | `packages/eval/scripts/behaviorPriorScan.ts`                                |
| 这条信号说的时刻,行为改不改变结果 | `signalOutcomeProbe.ts`(加一条 case)                                        |
| 随分段怎么变                      | `signalSkillGradientScan.ts`(分母表在 `src/explore/signalSkillGradient.ts`) |
| 浪费类指控有没有代价              | 回合内配对 DiD,范本 `eval-private/reports/overreact-study-2026-09-01/`      |
| 接线前后动了什么                  | `acceptanceCapture.ts`                                                      |
| LLM 用没用                        | eval-ab.md 反向探针节                                                       |
