# 幻觉归因:七种机制,以及每种是怎么被处理的

先分清两类,它们的成因和解法完全不同:

- **产品侧** —— AI 教练写出日志里没有的东西
- **开发侧** —— AI 程序员声称做了没做的事

---

# 第一部分 · 产品侧:AI 教练的幻觉

## 总体架构:按「可验证性」分流,不是按「严重性」

这是整套设计里最关键的一个决定。四类幻觉,**处理方式完全不同**:

| 幻觉类型 | 可验证性 | 处理方式 |
|---|---|---|
| 数字 | 可 | **按构造消除**——模型根本没有写数字的能力 |
| 事件锚点 | 可 | 确定性硬门拦截 |
| 因果 | **不可** | **禁止这种语言**,而不是验证这种断言 |
| 语义走私 | 部分 | 同谓词守护注(最后才发现的一类) |

---

## 机制一 · 数字幻觉 → 从能力上拿掉

### 归因

模型写「你在 43 秒时掉到 12% 血」——这里有两个数,每一个都可能是编的。
而且**编出来的数字和真数字长得一模一样**,事后无法区分。

### 解法:模型不许写数字,一个都不许

`packages/analysis/src/analysis/buildFindingsPrompt.ts` 给模型的硬规则原文:

> `Write NO digits at all in "explanation". Every number must be a {{key}} placeholder
> drawn from the referenced events' facts (e.g. {{t}}). For counts or durations you have
> no placeholder for, use words ("twice", "briefly", "early", "a few globals") — never a
> raw number. **An explanation containing any bare digit will be discarded.**`

模型写的是:

```
你在 {{t}} 秒时掉到 {{hp}}%
```

**主进程再把 `{{t}}` / `{{hp}}` 替换成日志里的真值。**

### 为什么这叫「按构造不可能」

模型**没有机会**编造数字——它写的位置上根本不是数字,是一个键名。
键名要么能在事实表里解析出来(那就是真值),要么解析不出来(整条被丢弃)。

`claimChecker.ts` 的双重检查:

```ts
// 1. every {{key}} must resolve
if (!Object.prototype.hasOwnProperty.call(facts, m[1]))
  violations.push(`unknown placeholder {{${m[1]}}}`);

// 2. strip placeholder spans, then scan the prose for raw stat-like numbers
const prose = rawText.replace(PLACEHOLDER, " ");
```

注意第 2 步的顺序:**先把占位符抠掉,再扫剩下的散文里有没有裸数字。**
这样合法的占位符不会被误判,而任何漏网的裸数字都会被抓住。

### 这个约束本身是 A/B 验过的

`buildFindingsPrompt.ts` 里的注释:

> accuracy **+0.71 [0.43, 1.00] (p=0.004, 42/42 claims verified)** for the free-text eval coach.
> **Do not weaken these constraints without an A/B.**

不是"感觉更好",是量化过的:准确度提升 0.71 分,置信区间不跨零,p=0.004。

---

## 机制二 · 事件锚点幻觉 → 菜单制 + 三层审计

### 归因

模型可以凭空说「你在中期漏了一次驱散」——这个事件根本没发生过。

### 解法一:只给菜单,不给自由创作

prompt 里的原话:

> `Event menu (**the ONLY things that provably happened** — every finding must reference these ids)`
> `Reference only event ids from the menu (in "eventIds"). **Never invent an event.**`

所有候选事件由确定性代码从日志里算出来(`candidateFindings.ts`),
每个带一个 id 和一组 facts。模型只能**从菜单里挑**,不能点菜单上没有的。

### 解法二:三层审计(`auditFindings.ts`)

```
Layer 1  grounding   —— eventIds 非空,且每个 id 都能解析到真实事件
Layer 2  claimChecker —— 每个 {{key}} 能解析 + 散文里无裸数字
Layer 3  causalLint   —— 无强因果断言
```

Layer 1 的原文注释:

> the finding must anchor to >=1 event, and every eventId must resolve.
> **(Empty eventIds is unanchored → drop.)**

### 这里踩过的坑:门太严也是 bug

2026-07-24 和 07-25 各修过一次,注释里都留了痕:

> **Refined 2026-07-24**: drop only when the explanation *actually uses* a colliding key —
> the old rule dropped the whole finding whenever a colliding key merely existed, which
> also killed the multi-event chains the prompt explicitly encourages…
> **a smoke run measured 3/7 findings dying this way.**

> **reproduced in production 2026-07-25**: 3 of 5 findings in a Chinese reply died this way
> **and the user saw only 2.**

**防幻觉的门,自己造成了两次生产事故。** 这是这套设计真实的代价。

---

## 机制三 · 因果幻觉 → 不验证真值,禁止这种语言

### 归因(这条是整套设计里最有洞察力的一步)

「你死了**因为**你走位太靠前」——这句话没法验证。
你无法从日志里判定它是真是假。反事实不存在于数据里。

跨 AI 辩论(agy)的结论被记成一条政策:**avoid-causality-by-design**——
定性/因果**不可按构造验证**。

### 于是解法不是"验证因果",而是"不许写因果"

`causalLint.ts` 开头第一句就把这件事挑明:

> This checks causal **LANGUAGE** (enforcing the policy), **not causal TRUTH** (unverifiable).

prompt 侧的硬规则:

> `Do NOT assert causation. No "because … you lost", "cost you the game", "that's why",
> "led to the loss". **State observations and suggestions only.**`

甚至连"死亡链"这种最自然会写成因果的情形,也被明确指定了中性写法:

> Describe the sequence neutrally — "at {{t}}s X happened; at {{deathT}}s the death followed"
> — and suggest what to do differently at the setup moment.
> **The no-causation hard rule still applies: never write that the setup "led to"/"caused"/"resulted in" the death.**

### 这个"简单"的检查器有多难写

`causalLint.ts` 的注释里记着三轮修补,每一轮都是被真语料打脸:

**坑 1 —— 句子边界(2026-07-31)**

原来的间隙模式用 `[^.]*`(非句点),对英文成立,**对中文完全失效**:

> Pre-2026-07-31 this class was ASCII-only `[^.]*` — invisible as a bug for English text
> (which does use "." to end declarative sentences) but it **silently let a zh gap-pattern
> span an entire multi-sentence paragraph.**

中文句子用「。!?」结尾,从不用 ".";而 deepDive 的 prompt 明确要求 3–5 句一段,
生产默认语言就是中文。于是一整段里任意位置的"因为"和任意位置的"死"都会被连起来判为因果。

**坑 2 —— 否定被当成断言**

真语料原句:「所幸**没有导致**后续崩盘」——这是**否认**因果,却被判成断言因果。

修法是一串 lookbehind:

```js
const NEG_LOOKBEHIND = "(?<!没有)(?<!不会)(?<!并未)(?<!未曾)(?<!从未)(?<!未)(?<!不)";
```

注释里解释了为什么单字和多字都要列(不是冗余):

> "未导致" is caught by `(?<!未)` but NOT by `(?<!未曾)` (the immediately-preceding char
> there is "曾", not "未"); "未曾导致" is the reverse.

**坑 3 —— 过度拦截检查**

加完否定守卫之后,他们反过来验证了一遍会不会误伤:

> Over-block check for the new `(?<!不)`: every real 2-3 char Chinese word ending in 不
> immediately before one of these markers (毫不/绝不/决不/从不) **is ITSELF a negation
> of the causal claim, so blocking is correct there, not an over-block.**

**加一条守卫之后,主动去证明它不会误伤——这一步是大多数人不会做的。**

---

## 机制四 · 语义走私:门挡住了菜单,上下文绕过了门

**这是最后才被发现的一类,也是最难防的一类。** 2026-08-01,由我在真实使用中报出来。

### 症状

分析说「你自己的减伤没有用」,而**那一轮我几乎没挨打**。

### 归因(定量的)

`37f5df2` 的 commit message,本地库 40 场 163 轮实测:

```
cd-waste 候选门(minHP≥60 不发)工作正常:低承压 92 轮  0 条候选
                                        ↑ 门是好的

但 timeline prompt 的 <player_loadout> 里,owner 未用减伤的 [UNUSED] 标签
                                        ↑ 不看承压

低承压轮:72/92(78%)带无门标签
承伤 <10% maxHp 的症状轮:3/3 全中
```

**门把这个教学点从菜单里挡掉了。但同一份 prompt 的另一个区块,
仍然赤裸裸地告诉模型「这个减伤没用过」。** 模型据此自由发挥。

### 为什么审计抓不到

memory 里的原话:

> **findings 只需锚定任意菜单 id,审计查不出语义走私。**

三层审计检查的是:锚点存不存在、数字有没有编、有没有写因果。
**它不检查"这句话讲的是不是这个锚点的事"。**

模型可以锚定一个真实的死亡事件,然后在解释里谈论一个完全不同的、
被门否决过的话题。**每一层审计都会通过。**

### 根因的一句话表述

> **给模型的「事实」若与教学门不同源,门等于没关——事实照样诱导产出被门否决过的判语。**

**这就是「谓词单源」那条铁律,应用在 prompt 上下文而不是代码上。**
门和上下文各自决定同一个事实(「这个减伤该不该被指摘」),用了不同的判据。

### 修法:同谓词的守护注

不是删掉 `[UNUSED]` 标签(**诚实伦理:不删事实**),而是在低承压时补一句立场:

```
lowPressureUnusedDefensiveNote  ——  消费与 cdWasteEvents 同一个
                                    CD_WASTE_PRESSURE_HP_PCT + matchMinHpPct
```

门槛处与候选门**精确互补**:≥门槛压候选就出注,<门槛发候选就不出注。单测钉死。

### 前后数字

```
低承压轮 [UNUSED] 无守护注裸奔:  72/92  →  0/92
候选门行为零变化:cd-waste 低承压 0→0、真承压 57→57
症状轮 3/3 带注
PROMPT_VERSION 13→14(旧缓存里这类误报一并作废)
```

### 它自己声明了没验的部分

commit message 最后一句:

> 注:**守护注对模型行为的末端效果未做真模型 A/B**,本修的可验证面是确定性 prompt 层。

**修的是"模型看到什么",不是"模型因此说什么"。后者没验。这句话被明确写下来了。**

---

# 第二部分 · 开发侧:AI 程序员的幻觉

产品侧的幻觉可以靠架构消灭;开发侧的不行——**因为写代码这件事没有占位符可用。**

## 机制五 · 合理叙事替代因果验证(`3cd5342`)

### 现象

它给出的根因:

> 一条被文档化的不变量,被后续改动单侧破坏。

### 逐条核查:每一条局部事实都是真的

| 它的声称 | 事实 |
|---|---|
| docstring 规定两侧必须同半径 | ✅ 真的,`HP_SAMPLE_RADIUS_MS` 的注释确实这么写 |
| `HP_SAMPLE_WINDOW_CRITICAL_MS = 1500` 是后加的局部常量 | ✅ 真的 |
| 它只加在 STATE 一侧 | ✅ 真的 |
| DMG SPIKE 只发生在关键窗口 | ✅ 真的 |
| **所以两者必然取到不同样本** | ❌ **假的** |

**前四条都对。只有第五条那个"所以"是编的。**

### 编在哪里

它没有去读 `getUnitHpAtTimestamp` 的实现。如果读了,五行就能看到:
半径只在 `if (dt > maxDtMs) return null` 里出现一次,
而返回值来自更早的 `binarySearchClosest`——**两者之间没有因果通路**。

### 机制命名:叙事完成压过因果追踪

它在做的是**补全一个故事**:有一条被文档化的不变量,有一处单侧修改,有一个症状——
这三样东西拼在一起是一个**极其常见、极其真实的 bug 模式**。
模型识别出了这个模式,然后**假定**实例符合模式,**没有去验证这一次的数据流真的是这样**。

**它拟合的是 bug 的形状,不是这个 bug。**

### 它自己知道

commit message 倒数第三行:

> **未做:端到端 A/B(判据 = A 类场次数 31→0)。**

**它诚实地标注了未验证部分。 我没读那一行就合了。**

这条特别值得注意:**幻觉不总是伴随着虚假的自信。**
这一次,不确定性被正确地标注出来了,只是标注在一份 40 行 message 的倒数第三行。

---

## 机制六 · commit message 写的是意图,不是 diff(`be36279`)

### 实锤

`be36279` 的 message 写着:

> 顺带订正:analyzeOutgoingCCChains 的注释称「只返回至少有一次降级的链」,
> 实际过滤条件是 applications.length > 0 —— 注释过时,**已按实际行为使用**。

实际改动:

```
 packages/analysis/src/context/matchTimeline.ts | 29 +++++++++++++++++++++++++-
 1 file changed, 28 insertions(+), 1 deletion(-)
```

**一个文件。`drAnalysis.ts` 一次都没被碰过。**(`git show be36279 --name-only | grep -c drAnalysis` → 0)

### 归因

commit message 是在**动作序列结束之后**写的,内容来自**当时的计划和推理过程**,
而不是来自 `git diff`。计划里有"顺带订正这条注释",推理过程里讨论过它,
于是它进了 message——**而那个编辑动作从未实际发生**。

### 为什么这类最危险

- 代码写错 → 测试红
- 逻辑推错 → A/B 能测出来
- **message 与 diff 不符 → 没有任何自动化会发现**

它污染的是**未来的自己和未来的人**读到的历史。三个月后有人 `git log` 查
"这条注释什么时候订正的",会查到 `be36279`,然后困惑地发现代码里还是老样子。

### 怎么被抓到的

不是被工具抓到的,是 `dbe61bd` 那一轮**重新去读那个文件**的时候撞上的。
纯属偶然。

---

## 机制七 · 单样本外推(`dbe61bd` 的 D 类结论)

### 现象

12:37,`dbe61bd` 判定 D 类问题「不是数据不一致,只是读者分不清『未追踪』与『不可用』」,
只补了个图例。

13:56,`c820ad4` 开头一个字:

> **错。**

### 归因

`c820ad4` 自己写的复盘:

> 我自己上一轮查 D 类时**把数据源误判成 SPELL_CATEGORIES**,得出了相反结论。

它查了一个技能(Lay on Hands),发现两份数据里都没有,于是推断"这不是数据不一致问题"。
**而那个技能在千场语料(2525 场战斗)里只被施放过 1 次——n=1。**

真正的问题技能是 Ironbark,在两张表里有两个不同的值。它没查到。

### 抓回来的是谁

> 这个反例是**盲评 A/B 的 responder 子代理**发现的 —— 它拒绝采信 MISSED OPTIONS
> 的说法,理由是「与同一份 prompt 的 RES 台账矛盾」。**多一双独立的眼睛值这个价。**

**注意这个子代理不是被派去查 bug 的。** 它的任务是扮演一个教练回答问题。
它在干自己活的时候撞见了矛盾,并且**拒绝在矛盾上继续作答**。

---

# 第三部分 · 为什么"更小心一点"解决不了

三个测量盲区,每一个都被量化过。

## 盲区一 · 单元测试对 prompt-模型交互是瞎的

`gladlog-deepdive-eval` 的记录:

> **占位符/裸数字/因果纪律类 feature,合成 pack 单测有系统盲区**——
> 手工对齐占位符的单测**永远绿**,但真模型会栽在 prompt-model 交互上。

真模型 smoke 实测:**纪律通过率 50% → 100%**,靠两轮改 prompt。

两个具体栽法:

1. 清单里 `units=X` 印成独立顶层 token → 模型写不存在的 `{{pN.units}}` → 被丢
2. HP 字段名 `hpT15/10/5` 把偏移量编进 key 名 → 模型写「死前 15 秒」的**裸数字**被丢;
   服务器名(Area52)含数字、模型写全名 → 裸数字审计**误杀**

**这两个都不是模型的错,是 prompt 的数据形状逼出来的。** 单测里的模型行为是我假设的,
所以永远测不出来。

**结论写成了规矩:** 任何"模型输出必须过占位符/纪律审计"的改动,
landing 前跑一次真模型 smoke(≥6 真语料锚点),别只靠单测。

## 盲区二 · LLM 判官有一半的维度不能用来裁决

`gladlog-judge-noise-floor`,两次独立方法得出同一结论:

```
accuracy    配对 SD = 1.30   →  |Δ| < 0.4 根本测不出
            (其余六维 0.14–0.65,它是 2–9 倍)
sufficiency 检出率 1/5 = 20% →  注入「删掉整场死亡行」,5 件里 4 件判官给分持平或更高
```

**「删掉整场死亡数据」这种明目张胆的缺陷,判官 80% 的情况下看不出来。**

推论被写成了铁律:

> prompt 内部一致性类修复**不要指望盲评能验出来**。2026-07-20 那轮八类缺陷修复的
> 确定性指标是 hard-failure **185→0、80/98 场→0/98**,盲评却**七维全 inconclusive**
> (accuracy 点估计还是负的 −0.30)。
> **采纳依据写「凭确定性」,不许包装成 A/B 赢。**

**这是我见过最诚实的一条工程规矩:修好了,但不许说是 A/B 赢的,因为 A/B 没测出来。**

## 盲区三 · 语料里"没发生过"和"发不出来"长得一样

上游数据表缺了条目 → 下游整条规则不再触发 → 界面上看起来就是"这个问题从未出现"。

同类的死门至少两例:
- `G6_IMPOSSIBLE_CC`:门规阈值 50 码 > 生产者抑制阈值 45 码,**从上线起就不可能触发**
- DR 表官方化时抓出「**2 个错判 + 1 个隐性失效**」

---

# 归因总表

| # | 机制 | 一句话 | 处理方式 | 可验证性 |
|---|---|---|---|---|
| 1 | 数字编造 | 编的数和真的数长得一样 | **从能力上拿掉**(占位符 + 主进程插值) | 按构造不可能 |
| 2 | 事件编造 | 说一件没发生的事 | 菜单制 + grounding 层 | 确定性可验 |
| 3 | 因果编造 | 「因为…所以你输了」 | **不验证真值,禁止这种语言** | **不可验证** |
| 4 | 语义走私 | 锚定 A,谈论被禁的 B | 同谓词守护注 | 部分(prompt 层可验,行为层未验) |
| 5 | 叙事完成 | 拟合 bug 的形状而非这个 bug | 同判据前后数字 | 事后可验 |
| 6 | 意图当成事实 | message 写计划不写 diff | **无自动防线** | — |
| 7 | 单样本外推 | n=1 就下结论 | 独立第二意见 | 事后可验 |

## 三条贯穿始终的结论

**一 · 幻觉不是一种东西。** 数字幻觉可以按构造消灭,因果幻觉永远不能验证,
语义走私连审计都看不见。**把它们当同一个问题处理,就会在错误的地方花力气。**

**二 · 最贵的幻觉发生在推理层,不是输出层。** 输出层的编造(数字、事件)已经被
架构解决了。剩下的全是**推理层**:一个每步都对、只有连接词是假的论证链。
**这类没有任何自动化能挡,只能靠"同一判据再跑一次"。**

**三 · 模型标注不确定性时,人要读得到。**
`3cd5342` **写了**"未做端到端 A/B"。防线在那一刻是有效的——
**失效的环节是我没读那一行。**
后来的解法不是让模型更谨慎,是把这类声明从 commit message 的第 37 行
**挪进了 CI 会拦下来的地方**。

---

# 复核命令

```bash
cd ~/code/gladlog

# 产品侧四道防线
sed -n '80,92p' packages/analysis/src/analysis/buildFindingsPrompt.ts   # 给模型的硬规则
sed -n '1,60p'  packages/analysis/src/compare/claimChecker.ts           # 占位符 + 裸数字
sed -n '15,50p' packages/analysis/src/analysis/auditFindings.ts         # 三层审计
sed -n '1,75p'  packages/analysis/src/analysis/causalLint.ts            # 因果:查语言不查真值
git show 37f5df2                                                        # 语义走私 72/92→0/92

# 开发侧三种机制
git show 3cd5342 | tail -12                    # 「未做:端到端 A/B」
git show be36279 --stat --format=''            # 只改了 1 个文件
git show be36279 --name-only --format='' | grep -c drAnalysis   # → 0,message 撒谎实锤
git show c820ad4 | head -30                    # 「错。」+ n=1 外推的复盘

# 三个盲区
cat ~/.claude/projects/-Users-mingjianliu-code-gladlog/memory/gladlog-deepdive-eval.md
cat ~/.claude/projects/-Users-mingjianliu-code-gladlog/memory/gladlog-judge-noise-floor.md
```
