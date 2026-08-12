# deepdive-probe — 深挖上限实验运行手册

单场实验:一名代理用最强模型对一场真实对局做**无预算限制**的深挖(多轮 `matchExplore`
查询 + 假设验证),把它的发现和产品现有管线(`analysis-v2` 缓存里的 baseline findings)
混盲后交给你(对局的本人玩家)逐条打分,最后揭盲对比。目的不是「深挖一定更好」——是
量出深挖能不能挖到 baseline 挖不到的、**真实、你事后认、可执行**的发现,以及代价
(幻觉率、查询轮数)。产出三样:上限报告(这轮深挖挖到了什么)、金标集(你的逐条标注,
`answers.json` 会跨轮累积)、可蒸馏清单(哪些发现模式值得下沉进产品 prompt)。

> **第一盘跑完前不下「深挖是否更好」的结论。** 修复要给前后数字,实验要给逐条标注——
> 一盘的样本量什么都证明不了,先攒金标集。

工具链背景(Task 1–8,均已并入 `main`):`matchExplore.ts`(八条查询 + `overview`,单源
谓词——门规复算走的也是它)、`buildReviewSession.ts`(机器预筛 + baseline 合并 + 盲序
洗牌)、`dev:ui` 试验台的 `?review=<name>` 盲评工作台(左战报/右评审面板,答完才揭盲)。

## Step 0:选局前置条件——先确认 baseline 有得比

选局(下一节)之后、写深挖发现之前,**先确认这场对局已经有非空的产品 AI 分析结果**——
否则盲评会话里只有深挖卡片、零 baseline 卡片,整场实验退化成「深挖发现的自我审查」,
比不出任何东西。2026-08-12 实测:本机对局库里已跑过分析的场次绝大多数是 **0-finding
缓存**(空 baseline),必须重新触发一次分析。

```bash
ls "$HOME/Library/Application Support/gladlog/matches/<matchId>/" | grep analysis-v2
```

- 文件不存在,或存在但产品里显示「AI 分析」标签页发现列表为空:打开 gladlog 桌面应用
  → 找到这场对局 → 进入右侧「AI 分析」标签页 → 点「AI 分析」(或已有旧结果时点
  「重新分析」)→ 等待跑完。
- 跑完后再看一眼发现列表:非空即可继续。仍是 0 条(模型偶发输出全部被审计丢弃)——换
  一场,或再点一次「重新分析」重试。
- 别跳过这步再回头补——`buildReviewSession.ts` 是在构建会话那一刻读 baseline 缓存
  快照的(见 Step 3),分析必须发生在构建会话**之前**。

## Step 1:选局

```bash
npx tsx packages/eval/scripts/matchExplore.ts pick --min-duration 120
```

输出是本地对局库的 tab 分隔表(`id kind 时长 playerName result bracket`)。挑一场:

- `playerName` 是你自己的角色(不要挑别人上传/下载来的对局——本人才能做「事后认不认」
  的盲评判断)。
- 时长 > 2 分钟(`--min-duration 120` 已经过滤掉了短局)。
- 有死亡或明显转折——用 `overview` 子命令核对(每个玩家一行,带 `[死亡: m:ss, …]`):

```bash
npx tsx packages/eval/scripts/matchExplore.ts <matchId> overview
```

没有任何死亡记录的场次通常也没什么好深挖的,换一场。`kind=shuffle` 的对局记得后续
所有命令都要带 `--round N`(N 是 `doc.data.rounds` 的**数组下标**,不是
`sequenceNumber`——两者不一定相等,shuffle 每回合换边)。

选定后确认 Step 0 已完成(该 matchId 有非空 baseline 缓存),再往下走。

## Step 2:深挖代理开场提示词(全文可直接粘)

给一个**新会话**、指定**最强可用模型**(不要用批量子代理默认的省钱档),整段粘贴:

> 你是一名 WoW 竞技场深挖分析代理。任务:对一场真实 3v3/2v2/solo shuffle 对局做**无
> 预算限制**的深挖,找出产品现有 AI 分析管线大概率会漏掉的发现——不是重复"谁伤害最
> 高"这种一眼能看出的信息,而是需要跨多个数据面(HP、距离、视线、CD、光环、CC 链、
> 施法流)交叉验证才能发现的因果链、误判、时机窗口。
>
> **数据访问方式**:唯一渠道是下面这个 CLI,禁止凭记忆/推测编造任何时间戳、HP 值、
> 距离或技能名——每一条你打算写进最终产出的具体事实,都必须能指向某一次真实调用的
> 输出行。
>
> ```bash
> npx tsx packages/eval/scripts/matchExplore.ts <matchId> [--round N] [--store <dir>] <子命令> [flags]
> ```
>
> matchId = `<把 Step 1 选中的 id 代入>`；如果是 shuffle,`--round <把选中的数组下标代入>`。
>
> | 子命令                             | 参数        | 返回                                                |
> | ---------------------------------- | ----------- | --------------------------------------------------- |
> | `overview`                         | 无          | 每个玩家一行(阵营/死亡时间戳)+ 时长                 |
> | `cd --t S`                         | S=秒        | 每个玩家在 S 秒时刻的大 CD 就绪/在 CD(剩余秒数)     |
> | `hp --t S`                         | S=秒        | 每个玩家在 S 秒时刻的 HP%                           |
> | `hpcurve --from A --to B --step N` | 秒范围+步长 | 区间内逐点 HP% 曲线(多行,等价于多次 `hp`)           |
> | `auras --t S`                      | S=秒        | 每个玩家在 S 秒时刻身上的光环列表                   |
> | `pos --t S`                        | S=秒        | 你(owner)与其他每个玩家的距离(yd)+ 视线(通/挡/未知) |
> | `dr --from A --to B`               | 秒范围      | 区间内双向 CC 链(施法者→目标,含 DR 层数、时长)      |
> | `flow --from A --to B`             | 秒范围      | 区间内的施法流水账(谁在什么时候放了什么)            |
> | `gaps`                             | 无          | 每个友方治疗的漏治窗口                              |
>
> 时间一律用**渲染秒**(`m:ss` 对应的整数秒,不要用带小数的原始时刻——查询内部已经
> `floor` 到渲染网格,你给的浮点秒会被同样处理,但为了后续证据行能精确复制,直接传
> 整数)。
>
> **纪律(强制顺序,不许跳步)**:
>
> 1. 先跑一次 `overview` 通读全场骨架(死亡时刻、时长)。
> 2. 针对每个死亡/转折点,提出**具体假设**("A 死之前 B 的减伤 CD 是不是在冷却"、
>    "C 在被集火前是不是已经脱离视线掩护"这类可用某个子命令直接验证的问题)。
> 3. 用对应子命令查数据行,验证或推翻假设。**一个假设可能需要交叉两三个子命令**
>    (比如 `cd` 确认某 CD 状态 + `pos` 确认距离/视线 + `hp` 确认承伤结果)。
> 4. 验证通过 → 写成一条 claim(见下方产出格式);验证不通过 → 放弃这个假设,不要
>    硬凑证据,也不要因为"查都查了"就降格写成模糊的话。
> 5. **停止判据:连续两轮(两次"提假设→查证"的循环)都没有产出新的、能通过验证的
>    claim,就停止**,不要为了凑数量硬挖。深挖的价值在于命中率,不在数量。
>
> **深度标杆(低于这条线的不算深挖)**:单点数据读数("某人 1:30 时 HP 74%")本身
> **不是** finding——玩家当场就看得见血条,这种卡会被评审判"当时就知道/太泛"。合格的
> finding 是**反事实因果链**:伤害本可规避、控制本可打出、CD 本可交换。每个大伤害时刻
> 至少跑一遍这条假设模板:
>
> 1. `hpcurve` 找到 HP 骤降的时刻 t;
> 2. `flow --from t-6 --to t` 看这波伤害来自谁的哪个施法——是读条技能吗?
> 3. `cd --t t-5` 查你(和队友)当时哪些反制手段是转好的:盾反/打断/控制/减伤/外置;
> 4. 若反制是控制:`dr --from t-15 --to t` 查对面该控制类别的 DR 档位,控不控得满;
>    再用 `flow --from 0 --to t` 全场扫对面**饰品(角斗士勋章)**的施放记录——最近一次
>    交了没、按冷却推 t 时刻在不在 CD(饰品在 CD 的控制才是死控);
> 5. 全链成立才落 claim:"t-4 时你的盾反可用、对面饰品 t-40 已交、这个读条可被打断——
>    这波伤害可规避",每一跳附对应查询的证据行。
>
> 防守侧同理反推:你被打死的那次爆发,3-5 秒前你/队友有没有转好的保命、打断、反控
> 可以掐掉它。挖不出这个深度的时刻,宁可不写。
>
> **产出格式**:把最终结果写成一个 JSON 文件,内容是 `DeepFindingInput[]`(TypeScript
> 类型定义,来自 `packages/eval/src/explore/reviewTypes.ts`,原样照抄):
>
> ```ts
> export interface EvidenceRef {
>   cmd: string; // 例如 "hp --t 90"
>   line: string; // 该次查询输出里,证明这条 claim 的那一行,原样复制
> }
>
> export interface DeepFindingInput {
>   claim: string; // 用自然语言写清楚发现是什么
>   anchorT: number; // 这条发现锚定的时刻(秒,渲染秒)
>   unitNames: string[]; // 涉及的单位全名(和 overview/hp 等输出里的名字一致)
>   evidence: EvidenceRef[]; // 支撑这条 claim 的一条或多条查询证据
>   severity: "high" | "med" | "low";
> }
> ```
>
> **证据行铁律**:`evidence[].line` 必须是某一次真实调用输出里的**原样一行**(不做任何
> 改写、不合并多行、不换算单位),`evidence[].cmd` 是产出这一行的那次调用的参数串
> (例如 `"hp --t 90"`,对应你实际敲的 `matchExplore.ts <matchId> hp --t 90`)。编不出
> 这样一条证据的结论——不许写进 `claim`。写完后自查一遍:能不能把每条 `evidence.line`
> 粘贴回对应 `evidence.cmd` 重新跑一次的输出里去,一字不差地找到?找不到就删掉这条
> claim 或修正证据行。
>
> 把最终 JSON 数组写到:`$GLADLOG_EVAL_HOME/review-sessions/<name>.deep.json`
> (`$GLADLOG_EVAL_HOME` 未设置时默认 `~/code/gladlog-eval-private`;`<name>` 你和用户
> 约定一个本轮实验的名字,建议 `YYYY-MM-DD-<matchId 前 8 位>`)。

## Step 3:构建 + 评审 + 揭盲

深挖代理写完 `<name>.deep.json` 后:

```bash
# 机器预筛(把每条 evidence 的 cmd 重新跑一遍 runQuery,核对 line 是否原样命中)
# + 合并该场的 baseline findings(Step 0 确认非空的那份缓存)+ 盲序洗牌
# 与 Task 1 loadLegacyRound 同一 --round 语义(数组下标)
npx tsx packages/eval/scripts/buildReviewSession.ts --name <name> --match <matchId> [--round N]
# 输出:wrote .../review-sessions/<name>.session.json (N cards)
```

`buildReviewSession.ts` 已经把每条深挖证据重跑过一遍预筛(`verified`/`mismatch`/
`unverifiable`),但终端不会打印结果——预筛 verdict 只在你揭盲之后的 UI 里才显示
(盲评期间连你自己都看不到,这是设计使然,不是遗漏)。启动试验台:

```bash
cd packages/desktop && npm run dev:ui   # 后台常驻,http://localhost:5199/
```

浏览器打开 `http://localhost:5199/?review=<name>`,逐张盲评(不会显示这条来自深挖还是
baseline,也不会显示预筛 verdict,直到你答完全部卡片)。

> **已知弱盲(2026-08-12 用户拍板接受)**:两条管线的卡片文风/证据格式天然不同
> (baseline 是「标题 — 解释」+ 候选事实键值对;深挖是散文 + CLI 输出行),细看样式可以
> 推断来源。评审人知情并自律按内容打分、模拟真实使用场景评估,不做格式统一。此偏差
> 解读揭盲对比时要记在心里。

每张卡片:点时间戳跳左侧战报回放到对应时刻核对,答完五问(属实吗/意识到了吗/建议可
执行吗/下次会照做吗/对胜负影响)即自动保存并翻下一张(POST 落盘到 `<name>.answers.json`,
断点续评——刷新页面重进不丢已答项)。全部答完后面板自动切换成揭盲汇总(深挖 vs 现有
管线的总数/已答/验真新发现数,以及五维分布对照表)。

> 左侧战报页面上的「AI 分析」标签页按钮在 review 模式下会一直停在「分析中」——试验台
> 用的是 mock 分析后端,这个按钮不接产品分析管线,不是 bug,不要点它等结果:真正的
> 评审动作全在右侧卡片里。

```bash
cat "$GLADLOG_EVAL_HOME/review-sessions/<name>.answers.json"   # 原始逐条标注,金标集本体
```

## Step 4:参考层(不作裁决,只并列展示)

这一层的结论**不能**用来判「深挖赢了/输了」——只是给 Step 5 的台账多留一点旁证,真正
裁决权在你(Step 3 的盲评)手上。

**agy/Gemini 独立审一遍深挖发现**(核对证据链是否站得住,不看你的标注):

```bash
node ~/.claude/skills/agy/scripts/agy-run.mjs review --model flash \
  --files "$GLADLOG_EVAL_HOME/review-sessions/<name>.deep.json" \
  "逐条核对这些 claim 的 evidence 是否真的支撑 claim(不是查距离结论却在说视线这类
   张冠李戴),标出你认为证据不足或过度推断的条目。" \
  > "$GLADLOG_EVAL_HOME/review-sessions/<name>.agy-review.txt" 2>&1
```

**七维判官照跑**(把深挖发现当一份"回复",套用 `docs/commands/eval-baseline.md` Step 3
的三遍法评分,只取 `accuracy`/`inferenceScaffolding` 两维参考——sufficiency/noise/
labelBias/outcomeAlignment/focusCalibration 是为教练回复文体设计的,套在一组离散 claim
上没有意义,不要硬填)。这一步是可选的重锚点,人手紧张时可以跳过,不影响 Step 3 的盲评
结果。

## Step 5:单盘收尾——记台账

不管 Step 4 做没做,**这一步不能跳过**:分数文件/session 文件会被下一轮实验覆盖,台账
是唯一跨轮累积的记录。向 `$GLADLOG_EVAL_HOME/ledger.md` 追加一行(新起一节
`## Deepdive probe runs`,表头同下,append-only,不改旧行):

| 字段                | 内容                                                             |
| ------------------- | ---------------------------------------------------------------- |
| Date                | 本轮日期                                                         |
| Name                | `<name>`                                                         |
| Match               | matchId(+ round,如是 shuffle)                                    |
| Deep cards          | 深挖卡片数                                                       |
| Baseline cards      | baseline 卡片数(Step 0 确认非空的那份)                           |
| Deep 验真新发现     | 盲评揭盲表里深挖列「验真新发现」数                               |
| Baseline 验真新发现 | 同上,baseline 列                                                 |
| Deep 幻觉/不属实    | 深挖卡片里 `truth=false` 的条数                                  |
| Notes               | 一句话:这轮深挖挖到了什么 baseline 没有的、Step 4 参考层有无分歧 |

## 注意

- 全程无外部 API key(深挖代理是一个普通 Claude Code/agy/Codex 会话,产品分析走桌面
  应用自带的模型配置)。
- `<name>` 一旦定下就不要中途改——`session.json`/`answers.json`/`deep.json` 三个文件
  靠文件名对齐,改名等于丢断点续评。
- `?review=` 是 `dev:ui` 试验台专属入口,不进 `dev/scenes.ts`、不进视觉基线、生产
  桌面应用里不存在这个路由。
