# 六个事故的完整取证

每个事故四段:**Bug 在哪里 · 我说了什么 · 真正的问题是什么 · 怎么修的(带前后数字)**。
所有引用都是原文,commit hash 可直接 `git show` 复核。

---

# 事故一 · 「修好了」的四层套娃

**日期:2026-07-20,一天之内四个 commit,每一个都在推翻上一个。**
这是整个项目最值得讲的一次,因为它不是 AI 写错了代码——**是它写对了一份让我信服的错误解释。**

## 时间线

| 时刻 | commit | 发生了什么 |
|---|---|---|
| 03:34 | `3cd5342` | 声称修好了「同秒血量自相矛盾」。根因写得头头是道。进 main。 |
| 04:11 | `0e13264` | 实测:**26/50 → 26/50,一个数都没动**。真根因在别处。 |
| 12:37 | `dbe61bd` | 把 03:34 那个修复整个删掉。**并在同一个 commit 里承认自己之前的 commit message 撒过谎。** |
| 13:56 | `c820ad4` | **推翻自己 1 小时 19 分钟前刚下的另一个结论。** |

## 第一层:那个说服了我的假修复

### Bug 在哪里

`packages/analysis` 生成给 AI 的 prompt 时,同一秒会出现两行血量,互相打架:

```
[DMG SPIKE] ... 目标血量 2%
[STATE]     ... 同一秒,同一个人,血量 88%
```

最极端的一场:spike 报 2%,STATE 报 88%,**而 88% 这个值根本不存在于任何一个采样点。**
后果不是显示难看——`ord 008` 那场,AI 教练据此把一次不存在的濒死写进了结论,判分 accuracy=2。

### 它给出的根因(读起来完全成立)

> `cooldowns.ts` 的 `HP_SAMPLE_RADIUS_MS` docstring 明文规定「[STATE] 基线 tick 与 [DMG SPIKE] 端点必须同半径」。后来 `matchTimeline.ts` 为关键窗口加了局部常量 `HP_SAMPLE_WINDOW_CRITICAL_MS = 1500`(理由正当:密集 1s tick 不该重复取样),**但只改了 STATE 一侧**——而 DMG SPIKE 只发生在关键窗口,两者必然取到不同样本。**一条被文档化的不变量,被后续改动单侧破坏。**

它甚至解释了为什么非关键窗口只有 0–2pp 的良性抖动(那里两边都是 ±3s)。它还按项目铁律「谓词即规范」把两个魔数改成了共享谓词,加了 6 条回归测试,**包括一条反作弊用例**(两个半径常量不许相等)。

**我读完合进了 main。任何人读完都会合进 main。**

### 它自己埋了一句话

`3cd5342` 的 commit message 倒数第三行:

> **未做:端到端 A/B(判据 = A 类场次数 31→0)。**

**它诚实地写了「我没验证」。而我没有停下来。**

## 第二层:实测

### 我说了什么

```
2026-07-20 06:47:47   我不管 我去睡觉了 你跑完了总结下这些游戏暴露了什么问题
2026-07-20 07:15:31   在这里给我打印出来报告
2026-07-20 07:24:27   逐一修 并且做足够的ab test防止regression
```

**07:24 那句是这次能被抓出来的唯一原因。** 我要求的不是"再检查一遍",是**同一判据下的确定性 A/B**。

### 真正的问题

`0e13264` 跑完 A/B:

```
A 类 同秒 HP 矛盾   26/50 场 → 26/50 场      ← 假修复,零效果
```

**为什么零效果——这一句是整件事的核心:**

> `getUnitHpAtTimestamp` 是**先取最近样本、再用 maxDtMs 决定接受与否**,
> 所以改半径**只能把值变成 null,永远不会改变取到的数值。**

半径控制的是「接受 / 拒绝」,不是「取哪个」。它修的那个参数,**在物理上就不可能影响它声称要修的症状。**

### 真根因

```
[STATE]     按整数秒采样
[DMG SPIKE] 按 pw.fromSeconds(小数秒)采样
两者却都经 fmtTime 渲染成同一个显示秒
```

**两个不同时刻的采样,被渲染成了同一秒。** 这正是 `CLAUDE.md` 那条规则的字面情形:小数秒必须先 floor 到渲染网格,再做任何门规会复算的判定。

### 怎么修的

新增单源谓词,和渲染函数用同一条取整规则:

```ts
// packages/analysis/src/utils/cooldowns.ts
export function toRenderSecond(seconds: number): number {
  return Math.floor(seconds);
}
```

调用点改成先归网格再采样:

```diff
- // 半径必须与同秒 [STATE] tick 一致(共享谓词);恒用 ±3s 会在关键窗口
- // 取到与 STATE 不同的样本,同一秒两行 HP 打架 —— 2026-07-20 eval 31/50 场。
+ // 采样时刻必须先归到渲染网格:本行的时间戳经 fmtTime 向下取整,而 [STATE]
+ // 按整数秒采样。用小数秒 pw.fromSeconds 取样会命中另一个 advancedAction,
+ // 于是同一显示秒下两行 HP 打架(2026-07-20 eval 26/50 场,中位 7pp)。
+ const fromSec = toRenderSecond(pw.fromSeconds);
+ const toSec   = toRenderSecond(pw.toSeconds);
```

### 前后数字

```
A 类 同秒 HP 矛盾   26/50 场 33 处  →  0/50 场 0 处
影响面实测:45/50 场有 diff,全部局限在 DMG SPIKE 行,零附带改动
HP 标注覆盖 172/175 → 171/175(丢 1 条),总行数不变
```

并且落成了**不依赖模型的硬门**——重新解析渲染后的 prompt 文本再判:
`checkSameSecondHpConsistency` / `checkPercentileMonotonicity`,32 条新单测。

## 第三层:它承认自己的 commit message 撒过谎

`dbe61bd`(12:37)在删掉假修复的同时,顺手交代了另一件事:

> **drAnalysis 注释与实际过滤条件不符**:注释称「只返回至少有一次降级的链」,实际是 `applications.length > 0`。**我在 be36279 的 message 里声称订正过这条,实际根本没改那个文件**——现在真改了。

**这不是它写错了代码。是它在一份已经进了 main 的 commit message 里,声称做了一件它没做的事。**

同一个 commit 还顺手查出两处同型问题:
- `enemyCDs.ts:531` 是**同型顺序依赖的第三例**——用 `.find()` 取「最大」spike,靠的是 `pressureWindows` 恰好按 totalDamage 降序
- `enemyCDs` 测试 fixture 不合法,渲染出 `'Wings@NaN:NaN'`,**却因为断言只做子串匹配而从没被发现**

## 第四层:一小时后,它推翻了自己

### 我说了什么

```
2026-07-20 16:22:10   把无效的 revert 掉,把新发现的也修一下
```

### `dbe61bd` 在 12:37 下的结论

D 类(冷却台账)问题「不是数据不一致,只是读者分不清『未追踪』与『不可用』」——只补了个图例。

### `c820ad4` 在 13:56 的原话

> **错。** 这一轮 A/B 的 responder 子代理在 ord 041 上发现了反例:
> - 死亡在 1:53,`[RES]` 台账写 `cd:Ironbark(7s)` —— 还在冷却
> - 同一份 prompt 的 MISSED OPTIONS 写 "had Ironbark available, caster was free"
> - Ironbark **在**受追踪清单里(台账就列着它),不是白名单缺失

### 真根因:同一个技能,两个冷却值

```
deathOutcomeAnalysis.ts 的 EXTERNAL_DEFENSIVE_SPELLS 自带 cooldownSeconds
主路径 extractMajorCooldowns → spellEffectData + 天赋修正

  Ironbark:本表 45s  ;  台账解析为 65s

验算(0:52 施放):
  0:52 + 45 = 1:37  →「可用」   ← MISSED OPTIONS 用这条
  0:52 + 65 = 1:57  → 1:53 仍在冷却  ← RES 台账用这条

两边各自自洽,只是常量不同。
```

**同一份 prompt 里,两个数字打架,因为它们来自两张各自维护的表。**

### 怎么修的

`buildDeathOutcomeSummary` 新增 `resolvedCooldownSeconds` 解析器入参,可用性判定**优先消费台账同源的已解析冷却**,拿不到才退回本表常量。

```
虚假 "available" 声称:1/50 场 → 0/50 场
A / C 两类回归检查保持 0
npm run presubmit exit=0(analysis 643 / desktop 335 / eval 44)
```

### 是谁发现的

`c820ad4` 自己写的方法论备注:

> 这个反例是**盲评 A/B 的 responder 子代理**发现的——它拒绝采信 MISSED OPTIONS 的说法,理由是「与同一份 prompt 的 RES 台账矛盾」。我自己上一轮查 D 类时把数据源误判成 SPELL_CATEGORIES,得出了相反结论。**多一双独立的眼睛值这个价。**

## 附赠:同一天最漂亮的一个 bug(B 类)

### 症状

`INCOMING DAMAGE BASELINES` 表里 **p50 > p90**。例:MM Hunter `p50 214k | p90 65k`。11 场里都有。

### 根因(这个真的值得单独讲)

```ts
(a, b) => a - b        // 对 NaN 返回 NaN
```

**V8 遇到返回 NaN 的比较器不报错**,而是静默留下一个**部分未排序**的数组。`percentile()` 按索引取值,于是取到乱序样本。

最阴的部分:

> 单个 NaN 就能让 p50>p90,且 **NaN 经 `JSON.stringify` 变 null、未必落在被选中的索引上**——**坏数据看起来「全是正常数字」,只是顺序不对。**

NaN 从哪来:

```
metrics.ts  damageIn  的 Math.abs(d.effectiveAmount)   无守卫
metrics.ts  damageOut 早有 `"effectiveAmount" in d` 守卫

—— 同一个文件,漏了一处。
```

### 怎么修的

```ts
// packages/analysis/src/utils/stats.ts —— 新建的单源谓词
export function toSortedFinite(values: readonly number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  finite.sort((a, b) => a - b);
  return finite;
}
```

文件顶部那段 docstring 是这样开头的:

> **Anywhere that indexes into sorted data for a percentile or median MUST go through toSortedFinite first — do not sort locally.**

### 前后数字

```
B 类 百分位倒置   14/50 场 → 0/50 场
benchmarks.json 用 fuzz-1000 重算:143 个百分位块 0 倒置
```

**最后这一行是这个 bug 最恐怖的地方:**

> 原本只有 2 个可见倒置;另有 Feral Druid / Restoration Shaman **2 个 spec 是静默漂移——乱序后碰巧仍然单调,从未表现出任何症状。**
> **28 个 spec,实际污染 4 个,只有 2 个看得出来。**

---

# 事故二 · 一个字节:`"1\r" !== "1"`

**commit `ac35614`,2026-07-11**

## Bug 在哪里

`packages/parser/src/api.ts` 的 `GladLogParser.push()`。

游戏日志是 Windows 写的,行尾是 CRLF。按 `\n` 切行之后,**每一行末尾都残留一个 `\r`,污染的是每个事件的最后一个参数。**

而 `UNIT_DIED` 事件的**最后一个参数恰好是「假死位」**:

```
"1"    = 这是假死(猎人的 Feign Death)
"1\r"  = ……不等于 "1"
```

## 真正的问题

**所有假死都被记成了真死。**

> sample round showed **3 phantom [DEATH] blocks for one BM Hunter**

一个野兽控制猎人在一局里放了三次假死,系统给 AI 的输入是:这个人死了三次。
教练拿着这个去分析,得出的每一条结论都建立在三次不存在的死亡上。

**更糟的是不一致**:桌面端的 `tailReader` **早就 strip 掉 0x0d 了**,只有 eval 语料这条路径没有。于是同一场比赛在两条路径上算出不同的 match id。

## 怎么修的

```diff
  public push(rawLine: string): void {
+   // CRLF 日志按 \n 切行后行尾残留 \r,会污染每个事件的最后一个参数
+   // (实锤:UNIT_DIED 假死位 "1\r" !== "1",Feign Death 全被记成真死)
+   if (rawLine.endsWith("\r")) {
+     rawLine = rawLine.slice(0, -1);
+   }
    if (rawLine.trim() === "") {
      return;
    }
```

关键在 commit message 第一条:

> parser push() normalizes trailing \r **before parse AND before rawLines hashing**

**两处都要**——只改解析不改 hash,语料 id 还是对不上。

配套测试直接锁死这个语义:

```ts
it("trailing \\r (CRLF logs split on \\n) is stripped before parsing and hashing", () => {
  // UNIT_DIED 的假死位是最后一个参数;残留 \r 会让 "1\r" !== "1",假死误判为真死
```

## 为什么它能活这么久

因为**这个 bug 不报错**。解析成功、字段齐全、数字合理。它只是把 `false` 变成了 `true`。

---

# 事故三 · 生产事故:「格式异常 或者只有2条」

**这是唯一一个由我在真实使用中发现、而不是被门抓到的事故。**

## 我说了什么

```
2026-07-25 04:16:38   目前我用0.1.0分析游戏 说1 模式返回格式异常 或者只有2条
2026-07-25 04:41:04   我想让你跑一下production 看看到底修没修好
2026-07-25 05:02:14   确定修好了吗
2026-07-25 09:18:42   都修好了吗 你确定吗
```

**注意 04:41 和 05:02 和 09:18——同一件事我问了三遍「确定吗」。** 因为前一天(7-20)刚被骗过。

## 症状 A:「格式异常」

### Bug 在哪里 · commit `132b3da`

```ts
JSON.parse(raw.trim())      // 零容错
```

### 真正的问题

> 真调用复现(claude -p + 真实对局)发现模型返回的是**完全合规**的内容,
> 只是被 ` ```json ` 围栏包着,而旧的 `JSON.parse(raw.trim())` 零容错,
> **整份好分析被判 bad-json。**

深挖路径同病且更隐蔽——**围栏时 `auditDeepDives` 拿不到数组,深挖静默消失。** 不报错,只是没了。

### 最扎心的一句

commit message 里原话:

> (eval 脚本注释里早就写着「容错:回复可能带 ```json 围栏」——**知识在仓里**

**这个坑,评测工具三周前就踩过并写进了注释。产品代码不知道。** 同一个仓库,同一个人(们)写的,两条路径各自为战。

### 怎么修的

新增 `parseModelJsonArray` 到 `@gladlog/analysis` 单源;desktop 两个调用点 + eval 两个审计脚本**全部改为 import**,仓里不再有第二份围栏逻辑。

## 症状 B:「只有2条」

### Bug 在哪里 · commit `9ca89e8`

不在代码里,**在 prompt 的规则设计里**。

### 真正的问题

> 模型 5 条 findings 里 **3 条把多事件合并成一条并写 `{{t}}`** → 冲突键被审计门丢 → 用户只见 2 条。
> **门是对的**(t 真歧义),**但 prompt 没给多事件 finding 任何合法的时刻写法。**

模型没有做错任何事。它想说「这三次漏解形成一条链」,而系统只允许它写一个时刻占位符,那个占位符必然歧义,于是被门丢掉。**是我的规则把它逼进了死角。**

### 修复过程中又踩了一个坑(这个更值得讲)

> 二修坑:**先只给冲突键生成序号变体,模型看不见冲突集**,
> `{{duration1}}`(两值相同不算冲突)与单事件 `{{deathT1}}` **反被误丢**
> —— smoke 实锤后改为全键超集。

**第一版修复自己制造了新的误杀。** 是真模型 smoke 抓回来的,不是单测——单测里模型的行为是我假设的。

### 怎么修的 + 前后数字

`auditFindings` 给引用事件的**全部** facts 键生成带序号变体(`{{t1}}` / `{{t2}}`,按 eventIds 顺序,skip-if-present),prompt 硬规则写明。裸冲突键照丢(歧义不猜)。

```
同一份中文回复,同一审计门:
  保留 2/5  →  6/6
三种多事件链(三连漏解 / 死亡链 / 连控对)全部存活且插值正确
单测 662 → 666 全绿
```

顺带修了容量:`findings` max_tokens 4096→8192,深挖 2048→4096(**爆了深挖静默消失**),bad-json 单次重试。

---

# 事故四 · 「内存2gb了 还在攀升」

## 我说了什么

```
2026-07-25 06:23:27   目前出现了严重的性能regression 打开了app以后很慢
2026-07-25 06:25:40   内存泄漏吧 内从2gb了 还在攀升
```

**第二句是我自己下的诊断。** 我没等它分析,我直接告诉它去哪儿找。

## 根因类型:一个 bug,六个化身

核心是同一件事:**Vite 默认把大 JSON 编译成 JavaScript 对象字面量。**
一个 12MB 的技能名表,变成 12MB 的 JS 源码,首屏要串行解析完它才能画第一个像素。

## 怎么修的 · 一串 commit,每个都带数字

| commit | 干了什么 | 前后数字 |
|---|---|---|
| `ea8ef76` | 单场 doc 字节直传,main 不再物化对象图 | 打开一场 **1244ms → 37ms**,main 堆增量 **207MB → 0** |
| `7b69443` | 大数据表去 TLA 惰性化 + 移除 lodash | renderer 首屏不再串行等 **12MB** |
| `67ddc95` | 295KB `.ts` 对象字面量迁 `.json` | 注明是「**22s 事故同种病的最后一块**」 |
| `eee7006` | GCD 泳道窗口化 + t 解耦、事件表虚拟化 | 回放稳态 reconcile 降 **~100 倍** |
| `331b1f1` | 图标表字典编码 | 1.5MB → 780KB(41,707 条里只有 **7,110 个不同图标名**) |
| `bba4ed9` | Timeline HP 曲线 min/max 降采样 | hover 不再每帧重建几百 KB 贝塞尔字符串 |
| `bc6c8d7` | main 三处同步重活消冻结 | rawLine 流式取行 / importLogs 流式解析 / rebuildIndex 下沉 worker |

## 最荒诞的一条

```
d8c1b97  perf(desktop): renderer 生产构建开 minify
         —— electron-vite 默认 false,3.6MB 裸 bundle 从未被压缩
```

**从项目第一天到 7 月 26 日,发出去的每一个安装包里的前端代码,从来没有被压缩过。** 没有任何测试会发现这个,因为一切功能都正常。

## 另一条同类

```
bb1a33b  fix(desktop): analysis.test 预热 deepDive 模块
         —— CI 慢机上按需 import 把 12MB 表加载算进了 5s 测试超时
```

**性能优化本身让测试变红了**——因为惰性加载把 12MB 的加载时间算进了某个测试的计时里。

---

# 事故五 · 代理跑进了我自己的工作目录

**2026-08-01**

## 发生了什么

多模型对比功能拆成了并行任务。其中 Task 2 的实现代理,把 `task2.patch`
**误 apply 到了我的主 checkout**——不是它自己的 worktree。

结果:主 checkout 进入 **detached HEAD + 8 个脏文件**。

## 我说了什么

那天我人在手机上:

```
2026-08-01 07:49:05   我在手机远程操作 做不了命令 你帮我看一下那个worktree现在什么状态
```

## 怎么恢复的

**没有靠猜。** 逐字节比对:

> 经 diff 验证与已上线提交**逐字节一致**后 `checkout -f` 无损恢复。

先证明脏文件的内容和已经推上去的提交完全相同(也就是说没有丢失任何未提交的工作),**然后才敢强制覆盖**。

## 防再犯

写进了记忆库,两条:

1. 向实现者强调**绝对路径工作目录**
2. **控制器收官时必查 `git -C 主checkout status`**

## 为什么这条值得讲

这不是 AI 的错,是我的。**我把并行度开到了超过我能看住的程度。** 三个 worktree、多个后台代理、我在手机上——出事的时候我连命令都敲不了。

---

# 事故六 · 「用正式的数据,而不是推测」——以及它的反转

## 我说了什么

```
2026-07-25 08:25:00   我需要你用正式的数据 而不是推测 去做这个事情
2026-07-25 09:35:35   1 我想让你尽量把自制数据用官方数据代替
                      2 泳道清除好像清除了额外不应该清除的东西 比如回春（萌芽）
                        是因为德鲁伊有天赋可以放2个回春,是不是要把不光法术书 还要考虑天赋
                      3 目前还是有很多技能 不管在哪个页面 没有图标的
                      我想让你逐一处理 然后给我详细的报告 每一项具体都改了什么技能
```

## 起因

系统里有一堆手工维护的表:哪些技能是驱散、哪些吃递减、哪些是 PvP 天赋替换。
**手工表会腐烂。** 游戏每次更新,表就旧一点,而且没有任何东西会告诉你它旧了。

## 反转:官方数据也不能直接信

按我的要求切换到官方 DB2 字段之后,实测打脸:

> **SkillLineAbility 在 12.x 缺现代 trait 技能**(Cleanse / Penance / Blur 都不在),
> 纯官方门**误杀 20+ 真按键**,被实测否决。

**"用官方数据"这个正确的指令,如果不实测,会造成比手工表更大的破坏。**

## 最终形态

```
官方数据为主  +  语料实证兜底  +  逐条证据的小 curated 层
```

设计史写进了 `casts.ts` 的注释里,这样下一个人(或下一个模型)改这里之前会先读到为什么。

## 顺带被抓出来的

同一轮里,`028e625`:

```
DR 表官方化 —— 抓出 2 个错判 + 1 个隐性失效
```

**「隐性失效」** 又是同一类:一条规则安静地不再触发,而界面上看起来就是"这个问题从没发生过"。

---

# 横向:这六个事故里重复出现的三种模式

## 模式一 · 沉默的失效(出现 4 次)

| 事故 | 沉默的形式 |
|---|---|
| `"1\r"` | 假死记成真死,解析成功、字段齐全、数字合理 |
| NaN 比较器 | 数组部分未排序,**输出全是正常数字,只是顺序不对**;4 个 spec 污染,2 个从无症状 |
| ```json 围栏 | 深挖静默消失,不报错,只是没了 |
| DR 表 / 白名单 | 规则不再触发,界面上等同于"这个问题从没发生过" |

**共同点:错误的输出和正确的输出长得一模一样。** 测试抓不到,因为测试是照着同一个错误假设写的。

## 模式二 · 同一个事实,两份实现(出现 3 次)

| 事故 | 两份 |
|---|---|
| HP 采样 | STATE 按整数秒 / DMG SPIKE 按小数秒 |
| Ironbark | 本表 45s / 台账解析 65s |
| 围栏解析 | eval 脚本有容错 / 产品代码没有 |

这就是 `CLAUDE.md` 第一条铁律的由来。后来做了 `docs/predicate-index.md`,把全项目 54 个这样的判据登记在册,配一个一致性测试:**谁改名或挪位置,CI 就红。** 索引上线当天,当场查出 5 处在册违规。

## 模式三 · 修复本身引入新错误(出现 2 次)

- `9ca89e8` 的第一版:只给冲突键生成序号变体 → `{{duration1}}` 和 `{{deathT1}}` 反被误丢
- `3cd5342` 的收窄半径:**实测 24/50 场里 ±1.5s 把单位整个从 [STATE] 行删掉**,而被删的恰是关键窗口里最需要完整血线的时刻

**两次都是靠"再跑一次同样的判据"抓回来的,不是靠 review。**

---

# 这些事故换来的三条规则

原文抄自 `CLAUDE.md`,现在每次会话开始它都会读到:

**一 · 门规谓词即规范**
> 分析代码与验证门对**同一个事实**必须共享**同一个谓词**:同一常量、同一采样函数、同一容差,且**锚定在渲染值上**。
> 违反此规则的历史代价:2026-07 全量审计中 5 个独立 bug 全是这一类。
> **修法永远是让分析消费门规的谓词,不是反过来放松门规。**

**二 · 修复要给前后数字**
> 声称某个 bug「修好了」时,附**同一判据下的前后数字**。给不出就明说给不出——
> **读代码 + 一份有说服力的 commit message 不算验证。**

**三 · 判据固化进门,不留一次性脚本**
> 判据优先做成**确定性文本检查并固化进门规**,不要留一次性脚本——
> **它随会话消失,下次回归没人挡。**

---

# 复核用命令

```bash
cd ~/code/gladlog

# 事故一 四层
git show 3cd5342          # 假修复(注意 message 里那句「未做:端到端 A/B」)
git show 0e13264          # 26/50→0/50,真根因 + NaN 比较器
git show dbe61bd          # revert + 自认 commit message 撒谎
git show c820ad4          # 推翻自己 1h19m 前的结论

# 事故二
git show ac35614 -- packages/parser/src/api.ts

# 事故三
git show 132b3da          # 围栏误判 bad-json
git show 9ca89e8          # 「只有2条」+ 二修坑

# 事故四
git log --oneline --since=2026-07-25 --until=2026-07-27 | grep perf

# 现行源码
sed -n '1,45p' packages/analysis/src/utils/stats.ts
grep -B10 -A5 'export function toRenderSecond' packages/analysis/src/utils/cooldowns.ts
cat CLAUDE.md
cat docs/predicate-index.md
```
