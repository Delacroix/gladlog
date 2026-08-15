# Hallucination Attribution (Layer 2): Crash history of anti-hallucination tools, and origins in previous work

Companion doc: `hallucination-attribution.md` (Table of seven mechanisms).
This document digs into two things: **How the anti-hallucination tool itself went wrong**, and **What this methodology looked like in the previous work**.

---

# Part 1 · causalLint: Nine rounds of fixes for a single gate

Causal hallucination is unverifiable, so the solution is to "ban this language".
**Then how reliable is this "language checking" tool itself?** The complete answer is in its commit history.

## Commit History: Two days, nine times

```
2026-07-12   1046bf9  Created
             2ff8aec  Opus cross-family review rejected (REQUEST_CHANGES)
             ab05545  agy re-verification: 3 regexes too broad
             cdebdf1  agy cross-family bug hunt: 7 more items
                      ── Rejected three times by three parties on the day it was born ──

2026-07-31   d249c3a  Zero coverage for Chinese (live for 19 days)
             aed104d  Re-check four items: negation guards
             22eb6f2  Re-check round 2: single-character negation bypass
             1b48d39  Two whitelist rots: is/isn't + hedge blind spots
             91f7d0e  Re-check caught Critical false negative
                      ── Five rounds in one day, each round found by the previous round's re-check ──
```

---

## 第一天(2026-07-12):诞生即被打回三次

### 打回一 · 数字层漏掉了整数(`2ff8aec`)

Opus 跨家族 review 给了 REQUEST_CHANGES。第一条:

> **bare INTEGER stats passed the numeric layer** — the reused compare claimChecker
> only catches decimals/%/percentiles, but **analysis fabrication is integer-heavy
> (times, damage)**. **'You died at 47s' (real death 30s) was shown as verified.**

**读三遍这句话。**

防幻觉的数字层是从 compare 模块复用过来的。compare 场景里的数字是小数和百分比
(「你的治疗量在同水平里排 73%」),所以检查器抓小数、`%`、百分位。

**但分析场景的编造是整数密集的**——时刻、伤害量。
「你在 47 秒时阵亡」(真实 30 秒)**通过了所有检查,并被标为「已验证」。**

**验证机制自己生产了虚假的验证。** 这比没有验证更糟:它给了一个假的保证。

修法:`auditFindings` 改为禁止 `{{占位符}}` 之外的**任何**裸数字。

### 打回二 · JS 语义坑绕过接地层

> **empty eventIds bypassed grounding (`refs.some` on `[]` is false).**

```js
[].some(r => !r)   // → false
```

空数组的 `.some()` 永远返回 `false`。于是「这条 finding 有没有锚点解析失败」
这个检查,对**完全没有锚点**的 finding 返回"没问题"。

**一条彻底没有接地的断言,顺利通过了接地层。**

### 打回三 · 正则过宽,把真话也杀了(`ab05545`)

agy 复验确认了上面三个修复,同时标出 3 个过宽的正则:

| 模式 | 误杀的句子 |
|---|---|
| `cost` | 「it **cost** you nothing」——本意是说"没有代价" |
| `that's why` / `which is why` | 「**which is why** you survived」——**正向鼓励被当成因果断言** |

修法:`cost` 必须跟一个结果名词(game/round/match/series);
`that's why` 必须跟一个**负面**结果,正向强化保留。

### 那天留下的一条取舍声明

`ab05545` 的原文,值得完整引用:

> The strict no-raw-digit rule is **KEPT** (drops legit constants like 'within 5 yards'
> too, **but that's the honest choice vs letting a fabricated '47s' through** — the
> regex-imprecision the spec earmarks LLM-judge/SP-A.1 to resolve).

**明知会误杀合法内容("5 码之内"里的 5),仍然保留严格规则。**
理由写得很清楚:宁可少说,不可乱说。而且指明了这个不精确性将来由谁解决。

---

## 第二天(2026-07-31):中文零覆盖 —— 上线 19 天

### 归因

`d249c3a` 标题:**「补中文因果确定性模式 —— 生产默认 zh 此前零覆盖」**

**这个门自 7 月 12 日上线,到 7 月 31 日为止,对生产环境的默认语言完全失明。**

发现方式不是靠工具,是靠**人工深读 300 场生产模拟**:

> 300 场 agy 生产模拟人工深读发现 **8 条真实中文因果确定性违规**
> (如「这波你绝对死不了」/「是直接导致输掉比赛的原因」),**英文-only 正则全部放过。**

### 前后数字

```
before(英文-only):    0/300 文件命中   ← 已知,因为正则看不见中文
after:               107/300 文件命中(137 条)
标注 recall:          8/8 quote 全部触发,7/7 文件全部进入命中集合
```

### 而且他们人工复核了全部 137 条命中

> 人工复核全部 137 条命中:**2 条(1.5%)为确认假阳性**(否定句「没有导致」、巧合邻接)

**137 条,一条一条读完。** 这才是"前后数字"这条铁律的真实成本。

### 顺带修的那个 bug 是第一天埋的

> gap 正则的句边界代理原来只排除 ASCII `"."`(中文从不用它),
> **deepDive 的 3-5 句段落会让门规静默跨句**。

第一天写的 `[^.]*` 对英文是对的。中文句子用「。!?」结尾,从不用 `.`。
于是**一整段里任意位置的"因为"和任意位置的"死"都会被连起来判为因果**。

英文正确、中文全错——**而且这个 bug 在英文测试里永远是绿的。**

---

## 第三轮到第五轮:假阳性 → 假阴性的钟摆

这四个 commit 展示了一个规律:**每一次为了减少误杀而放松,都可能开一个新的漏网口。**

### `aed104d` · 否定被当成断言

真实语料原句(`responses/48357f81.0.txt:14`):

> 「所幸**没有导致**后续崩盘。」

这是**否认**因果,被判成断言因果。而消费方**命中即整条丢弃**——
**这个假阳性会在生产里删掉好内容。**

修法:一串 lookbehind。前后数字精确到个位:

```
107/300 文件 → 106/300(-1,精确对应 48357f81.0 那一条,无其他文件受影响)
标注 recall 不变:8/8、7/7
```

### `22eb6f2` · 单字否定旁路,零变化的修复

复核轮 2 用**构造例**证明:守卫只列了多字词(没有/不会/并未/未曾/从未),
单字否定贴在连接词前直接绕过——「这个决策**未导致**后续崩盘」仍被误判。

前后数字:

```
106/300 → 106/300   (无变化)
```

commit message 自己解释了为什么零变化:

> 本次语料里恰好没有「未导致」/「不导致」单字否定形式的实例;
> 此修复堵的是**复核轮 2 用构造例证明存在、但当前语料未采样到的旁路**。

**一个数字都没动的修复,仍然被提交、被测试、被记录。** 因为漏洞是被证明存在的,
只是这批语料没采到。

同一个 commit 还做了**过度拦截排查**,三条真实语料结构逐条验证不受影响:

```
「这不仅导致了团灭」        —— 导致前紧邻是"仅"不是"不",仍判定 ✓
「不是因为…而是因为」        —— 因为前紧邻是"是"不是"不",两个分句都不受影响 ✓
「你不得不交出减伤,这才导致了」—— "不"在更早位置,紧邻"导致"的是"才" ✓
```

**加一条守卫,然后主动证明它不会误伤。** 这一步大多数人不做。

### `1b48d39` · hedge 盲区:真话被吞

第二处白名单腐烂,是这轮里最有产品意味的一条:

> **可能/或许/大概/也许/似乎/恐怕**(zh)与 **possibly/perhaps/likely/may have/
> might have/could have**(en)此前与确定性断言**同等触发**——
> 但**可能性框架正是产品诚实伦理允许的表达**,消费方命中即整段丢弃,
> **误判即真话被吞。**

**门在惩罚模型的诚实。** 模型说「这**可能**是你阵亡的原因」——
这正是我们希望它说的话——却和「这**就是**原因」受到同样的处罚。

前后数字(这次上了 561 场语料):

```
ds-sim:    43 files / 51  →  40 / 47
agy-sim:  106 files /136  → 102 /132
win16-sim:  1 file  /  1  →   1 /  1
合计:     150 files /188  → 143 /180

被清除的 8 例逐条人工核验:全部含明确 hedge 词,leakage = 0
```

**「leakage = 0」——放松之后,没有一条真实的无保留断言溜过去。逐条验的。**

### `91f7d0e` · 上一轮的修复自己开了个 Critical 漏洞

跨 AI 复核确认上一版 hedge 豁免有 **Critical 假阴性**:

> 豁免仅以句子边界为界,导致**同句但不同分句**的 hedge 会跨过逗号/转折连词
> **误豁免其后一个完全无保留的因果断言**:
>
> 「**可能**你没看到,**但**没交盾**直接导致了**死亡。」
>
> 此前不会被标记。**这正是本 gate 存在的目的要拦的那一类。**

前半句一个「可能」,豁免了后半句一个毫无保留的因果断言。

修法:hedge 回顾从「不跨句」收紧为「不跨分句」,边界集包含多字词
(但是/然而/不过),所以不能用字符类,得用 `(?:(?!边界词).)*`。

**注意这个漏洞是 `1b48d39` 引入的**——为了修假阳性(真话被吞)而加的豁免,
制造了一个假阴性(谎话溜过)。**钟摆的另一端。**

前后数字:

```
561 场语料:与收紧前完全一致(150/188 → 143/180,被清除的仍是同 8 例)
—— 语料里未出现「hedge + 转折词 + 无保留断言」的真实实例
   本次修复对当前语料零净效应,纯为对抗性场景加固
   NEW-ONLY 泄漏计数 = 0
```

**又一个数字不动的修复。** 用对抗性构造例证明漏洞存在,修掉,固化成测试。

---

## causalLint 这条线的三个结论

**一 · 防幻觉工具本身会幻觉。** 它误判过否定句、误杀过正向鼓励、放过过整数、
对生产语言失明 19 天。**没有任何理由假设"检查器"比"被检查者"更可靠。**

**二 · 假阳性和假阴性是一根跷跷板,而且两端的代价不对称。**
假阳性 = 真话被吞(用户看到内容变少);假阴性 = 谎话上线(用户被误导)。
这个项目的取舍一贯偏向假阳性——`ab05545` 那句「that's the honest choice」写得最直白。

**三 · 九次修改里有两次数字完全没动。** 它们修的是**被构造例证明存在、
但当前语料没采样到**的漏洞。这是"前后数字"这条铁律最难的一面:
**当数字不动时,你还愿不愿意做这个修复。**

---

# 第二部分 · 前作:幻觉的三个来源层

`TRACKER_ARCHIVE.md` 有 **279 条归档条目**,其中 **32 条**与编造/误判直接相关。
读完之后,我发现第一份归因里**漏掉了一整个层**。

## 层一 · 数据层幻觉:分析代码自己编造了事件

### B10 — 名字就叫 Hallucination

> **Evoker Stasis "Fake Release" Hallucination** — Stasis release logged on
> **all buff removals, even if buff expired or player died.**
> Fix: only emit release if a Stasis `SPELL_CAST_SUCCESS` occurred during the buffering window.

Stasis 是个"储存法术、之后一次性释放"的技能。分析代码把**任何 buff 消失**
都记成了"释放"——包括 buff 自然过期、包括玩家直接死了。

**没有任何模型参与。是确定性代码编造了一个从未发生的事件。**

### 同类还有一批

| # | 编造了什么 |
|---|---|
| B16 | 偷取的 buff 被当成"漏解控"——因为 `SPELL_AURA_APPLIED` 上带的还是原敌人的 srcUnit |
| B26 | 「Ghost Threat」假阳性——没检查敌人是否被控/是否在射程内 |
| B19 | `[RES]` 快照按**代码执行顺序**算的,不是按时间顺序——共享闭包状态在调用时被修改,而各段落按源码顺序执行 |
| B13 | Stasis 释放清单为空——只匹配 7 个硬编码治疗 id,漏了 `SPELL_AURA_REMOVED_DOSE` |

### 为什么这一层最危险

**所有的接地检查都会通过。**

三层审计的第一层是「finding 必须锚定到一个真实事件 id,且能解析」。
一个由分析代码编造出来的事件——**它有 id、它在菜单里、它能解析**。

**接地层验证的是"模型有没有忠于分析输出",而不是"分析输出有没有忠于日志"。**
如果分析层自己在编,接地层提供的保护是**零**。

这也解释了为什么 gladlog 的门规最终形态是**「重新解析已渲染的 prompt 文本,
从原始日志独立复算一遍」**——它跨过了分析层,直接对着日志验。

---

## 层二 · 模型层幻觉:数据对的,模型编的

### B110 — 在一场 1:45 的比赛里引用 2:04

> Healer Response Accuracy: occasional timestamp hallucinations / CC-trinket-sequence
> misreads (**Match 016 hallucinated 2:04/3:40 in a 1:45 match**; Match 003 hallucinated
> trinket CD at 2:02). **Root cause is model behavior, not missing data.**

比赛只打了 1 分 45 秒。模型引用了 2:04 和 3:40——**两个比赛结束之后的时刻。**

### 当时的修法,和后来的修法

**前作(2026-07-05):** 在三份 system prompt 里加一条纪律——

> cite only times printed on a timeline line and at/before `[MATCH END]`;
> **never extrapolate a time** — e.g. no 2:04 in a 1:45 match

commit 里管它叫 **"model-behavior guardrail"**,验证方式是"等下一次全量 meta-eval,
看有没有引用超过 `[MATCH END]` 的时刻"。

**gladlog(2026-07-12 起):** 模型**不许写任何数字**,只能写 `{{t}}`,主进程填真值。

### 这就是两代之间最大的方法论跃迁

```
前作:  求模型别编         →  用 prompt 规则约束      →  事后抽查
gladlog: 不让模型有机会编  →  用类型/占位符约束        →  按构造不可能
```

**从"约束行为"到"取消能力"。**

---

## 层三 · 上下文串扰:不是编造,是从邻居那儿取错了

### B135 — Solo Shuffle 的跨回合污染

这一条前作明确标注了 **"Distinct from B110 (intra-match hallucination)"**——
他们意识到这是**另一种机制**。

> findings import events (casts / timestamps / damage / CC / roster) **from an
> ADJACENT round that shares the same combat log + players**, producing hallucinated evidence

具体案例(每一条都能追到具体回合号):

```
1:17 的痛苦压制 + 2:12 的饰品   →  超过了 1:39 的比赛结束时刻(376)
一个战士队友 / 法术护盾祝福      →  属于兄弟回合(386/389)
304k@2:20 的火焰震击            →  从回合 718 泄漏到 719
1:51 的混乱之箭                 →  从回合 1034 导入到 1033
WotF-on-Psychic-Scream          →  从 1052 抬到 1053
```

影响面:

> ~10 cards and **the single top accuracy-killer (3 of the 28 inaccurate cards)**

**28 张不准确的卡片里,3 张来自这一个机制——它是当时最大的单一准确度杀手。**

### 归因:近似上下文

Solo Shuffle 是同一批人打 6 个回合,**共用一份战斗日志**。
六个回合的 prompt **长得几乎一模一样**——同样的人、同样的职业、相似的时间轴。

模型不是在凭空编造。**它是在一堆近乎相同的上下文之间取错了。**

### 修法:显式否定,而不是省略

> stamp each Solo Shuffle round prompt with an **in-body round id / hard round boundary**
> + emit explicit **`X: not cast this round`** markers so sibling-round detail cannot bleed

**关键是第二半:不是"不提 X",而是"明确写出 X 这一轮没放"。**

因为**沉默是有歧义的**。上下文里没提某个技能,模型可以理解成"没发生",
也可以从邻近的相似上下文里把它补全进来。**必须显式否定。**

### 这条和 gladlog 的语义走私是同一个形状

| | 前作 B135 | gladlog `37f5df2` |
|---|---|---|
| 症状 | 从邻居回合导入了事件 | 从 loadout 标签导出了被禁的判语 |
| 错误的直觉修法 | 不提这个技能 | 删掉 `[UNUSED]` 标签 |
| 实际修法 | **显式写「本轮未施放」** | **显式写「未用减伤是正确决策」** |
| 原则 | 不省略,只否定 | **不删事实,只声明立场** |

**两代人独立撞见同一条原则:在给模型的上下文里,沉默会被自动补全。
要抑制一个推论,必须显式地说出来,而不是把材料拿走。**

---

# 第三部分 · 最深的一层:先枚举"数据回答不了什么"

前作的 `DATA_AUDIT.md` 有一节叫 **Fundamental Limitations (What is Impossible from Logs)**:

> These are boundaries that **cannot be solved by more advanced tracking or AI** due to
> log format limitations:
>
> - **Line of Sight (LoS) Detection Is Impossible** — 即使高级日志给了 X/Y 坐标,
>   我们**缺 Z 轴(高度)**,更关键的是**缺 3D 碰撞网格**(柱子、桥、斜坡)。
> - **Perfect Player Latency Context** — parser 只看到服务端时间戳。
>   **无法区分"慌乱按键 / 3.5 秒治疗空档"和"玩家网络卡了 500 毫秒"。**
> - **True Pre-match State** — 无法知道玩家是否在开门前 30 秒在起始房间交了个 2 分钟 CD。
> - **Micro-CDR Math Limits** — 上百个被动天赋、随机 proc、套装效果的动态减 CD,
>   实践中不可能保持 100% 准确。

**这是防幻觉的最上游:在写任何分析之前,先写清楚这份数据回答不了什么。**
下游任何声称回答了这些问题的东西,都可以直接判定为编造。

## 一个漂亮的续集:「不可能」怎么变成「有边界的可能」

前作说 LoS 不可能。**gladlog 里有 `hasLineOfSight`。**

这不是打脸,是**把不可能收窄成了可验证的子集**。看 `losAnalysis.ts` 的注释:

```ts
/**
 * Interpolate a unit's game position at a given absolute timestamp (ms).
 * Returns null when advanced logging is absent or the timestamp is outside range.
 *
 * Position snapshots are event-driven (damage taken, heals received, casts),
 * so an idle unit (drinking, stealthed, out of combat) produces none —
 * the straight line interpolated across such a gap is FABRICATED, NOT OBSERVED.
 * Pass `maxGapMs` to return null when the query time is further than maxGapMs
 * from the NEAREST recorded snapshot...
 * Omitted = legacy behavior: interpolate any gap, hold the last position forever.
 */
```

三件事同时做到了:

1. **手工建 2D 障碍几何**(`arenaGeometry.ts`)替代拿不到的 3D 碰撞网格——
   放弃 Z 轴,只解决"柱子挡视线"这个 2D 子问题
2. **代码注释里管自己的输出叫 fabricated** ——
   *"the straight line interpolated across such a gap is **fabricated, not observed**"*
3. **不安全的默认行为被明确记录**:
   *"Omitted = legacy behavior: interpolate any gap, **hold the last position forever**"*

而这个 `maxGapMs`,就是谓词索引里那条:

> `INTERP_MAX_GAP_MS` is the T3 grounding guard that **killed fabricated mid-gap
> interpolation (a false 0.4 yd trained claim)**.

**曾经真的有一条"距离 0.4 码"的贴脸声称,是从两个快照之间凭空插值出来的。**

再往上还有一道门:`positioningScan` 对全语料做几何声称的重算,硬门 0 违规。

### 这条演化路径值得单独记住

```
前作:  "LoS 不可能"                    →  不做
gladlog: "3D 不可能,2D 柱子可以"        →  做,但收窄
       + "插值超出间隙就返回 null"       →  边界内才敢答
       + "注释里承认插值是 fabricated"   →  自己标注不可信区
       + "全语料几何重算硬门"            →  独立复算兜底
```

**「不可能」不是终点,是一个需要被精确切分的边界。**

---

# 两代之间的方法论跃迁总表

| 维度 | 前作(3–7 月) | gladlog(7–8 月) |
|---|---|---|
| 数字幻觉 | prompt 里写纪律「别外推时刻」 | **模型不许写数字**,只写 `{{t}}` |
| 验证方式 | 事后 meta-eval 抽查 | **确定性硬门,进 CI** |
| 幻觉发现 | 人工读 1065 份 prompt | 全语料重算 + 人工深读 300 场 |
| 事故记录 | TRACKER 里 279 条编号条目 | **CLAUDE.md 三条铁律 + 64 条谓词索引** |
| 教训留存 | 文档里的一段话 | **一致性测试,改名就 CI 红** |
| 上下文串扰 | 显式 `not cast this round` 标记 | 同谓词守护注 |
| 数据边界 | `DATA_AUDIT.md` 枚举不可能 | 代码注释里管自己叫 `fabricated` |

**一句话:前作把教训写成了文档,gladlog 把教训写成了会失败的测试。**

---

# 复核命令

```bash
# causalLint 九轮
cd ~/code/gladlog
git log --format='%ad %h %s' --date=short -- packages/analysis/src/analysis/causalLint.ts
for c in 2ff8aec ab05545 d249c3a aed104d 22eb6f2 1b48d39 91f7d0e; do git log -1 --format='%b' $c; done

# LoS:从「不可能」到「有边界」
sed -n '1,30p' packages/analysis/src/utils/losAnalysis.ts
grep -n 'INTERP_MAX_GAP_MS' -r packages/analysis/src/

# 前作
cd ~/code/wowarenalogs
grep -o 'Evoker Stasis "Fake Release" Hallucination[^|]*' TRACKER_ARCHIVE.md
grep -o 'Cross-round contamination[^|]*' TRACKER_ARCHIVE.md
grep -o 'B110[^|]*timestamp-discipline[^|]*' TRACKER_ARCHIVE.md
sed -n '169,180p' DATA_AUDIT.md          # Fundamental Limitations
```
