# 代码级取证:每个 bug 到底出在哪一行

配套文档:`incidents-forensics.md`(事故叙事与你的原话)。
这一份只回答一个问题:**代码从哪里出的问题。**

所有路径相对仓库根,所有 `git show` 可直接复核。

---

# 一 · A 类:同秒血量矛盾

## 案发文件

| 角色 | 位置 |
|---|---|
| **真凶** | `packages/analysis/src/context/matchTimeline.ts` → `emitDmgSpikeEntries` |
| **被冤枉的** | `packages/analysis/src/utils/cooldowns.ts:394` → `getUnitHpAtTimestamp` |
| **假修复动的** | `matchTimeline.ts` 的局部常量 `HP_SAMPLE_WINDOW_CRITICAL_MS = 1500` |
| **真修复加的** | `packages/analysis/src/utils/cooldowns.ts` → `toRenderSecond` |
| **兜底的门** | `packages/eval/src/quality/promptQualityCheck.ts` → `checkSameSecondHpConsistency` |

## 铁证:为什么假修复在物理上不可能生效

`packages/analysis/src/utils/cooldowns.ts:394`,一字未改的现行源码:

```ts
export function getUnitHpAtTimestamp(
  unit: ICombatUnit,
  timestampMs: number,
  maxDtMs = 10_000,
): number | null {
  const closestAction = binarySearchClosest(      // ①  先取最近样本
    unit.advancedActions,
    timestampMs,
    (a) => a.logLine.timestamp,
  );

  if (!closestAction) return null;
  if (closestAction.advancedActorId !== unit.id) return null;
  if (closestAction.advancedActorMaxHp <= 0) return null;

  const dt = Math.abs(closestAction.logLine.timestamp - timestampMs);
  if (dt > maxDtMs) return null;                  // ②  再用半径决定收不收

  return Math.round(                              // ③  返回值只依赖 ①
    (closestAction.advancedActorCurrentHp / closestAction.advancedActorMaxHp) * 100,
  );
}
```

**`maxDtMs` 只出现在 ②,而返回值只依赖 ①。**

`3cd5342` 改的就是这个 `maxDtMs`。它能做的极限是把一个数变成 `null`——
**永远不可能改变"取到哪个样本"。** 它修的参数和它声称的症状之间没有因果通路。

这不是个隐晦的推理,是读五行代码就能得出的结论。但那份 commit message 讲了一个
关于「文档化的不变量被单侧破坏」的完整故事,故事本身是**真的**——
`HP_SAMPLE_WINDOW_CRITICAL_MS` 确实只加在 STATE 一侧。
**它诊断出了一个真实存在的不一致,然后错误地认定它就是症状的原因。**

## 真凶

`emitDmgSpikeEntries` 里,采样用的是**小数秒**:

```ts
getUnitHpAtTimestamp(targetUnit, matchStartMs + pw.fromSeconds * 1000, …)
//                                              ^^^^^^^^^^^^^^ 小数
```

而 `[STATE]` 那一侧按**整数秒**采样。两个不同时刻取到两个不同的
`advancedAction`,然后 **`fmtTime` 把它们渲染成同一个显示秒**。

```
真实时刻  12.4s → 取到 sample@12.4 → HP 2%   → 渲染成 "0:12"
真实时刻  12.0s → 取到 sample@12.0 → HP 88%  → 渲染成 "0:12"
                                                    ^^^^^^ 同一秒,两个数
```

## 修法

```ts
// packages/analysis/src/utils/cooldowns.ts
export function toRenderSecond(seconds: number): number {
  return Math.floor(seconds);
}
```

调用点:

```diff
+ const fromSec = toRenderSecond(pw.fromSeconds);
+ const toSec   = toRenderSecond(pw.toSeconds);
  const hpFrom = targetUnit
    ? getUnitHpAtTimestamp(
        targetUnit,
-       matchStartMs + pw.fromSeconds * 1000,
+       matchStartMs + fromSec * 1000,
```

**九行代码。** 前面那个假修复动了两个文件、加了 6 个测试、写了 40 行 commit message。

## 前后数字

```
A 类 同秒 HP 矛盾   26/50 场 33 处  →  0/50 场 0 处
影响面:45/50 场有 diff,全部局限在 DMG SPIKE 行,零附带改动
```

## 被写进索引的教训

`docs/predicate-index.md`,`HP_SAMPLE_RADIUS_MS` 那一行的备注:

> 3000 ms everywhere. **Narrowing it "for freshness" was tried and reverted:
> the radius only accepts or rejects a sample, it never changes which sample you get.**

`getUnitHpAtTimestamp` 那一行:

> Always pass `HP_SAMPLE_RADIUS_MS` explicitly — **the default parameter is much looser.**

(注意默认值是 `10_000`,而项目标准是 `3000`。这个默认值本身就是个陷阱。)

---

# 二 · B 类:p50 > p90(最精彩的一个)

## 案发文件

全部在 `packages/analysis/src/benchmark/metrics.ts` 一个文件里。

## 三处代码,合起来才出事

### ① NaN 的产地(约 187 行,修前)

```ts
for (const d of unit.damageIn) {
  const t = (d.logLine.timestamp - matchStartMs) / 1000;
  const bi = Math.min(Math.floor(t / WINDOW_SECONDS), bucketCount - 1);
  buckets[bi] += Math.abs(d.effectiveAmount);
  //             ^^^^^^^^^^^^^^^^^^^^^^^^^^^ effectiveAmount 可能不存在
  //                                          Math.abs(undefined) === NaN
}
```

**同一个文件里的 `damageOut` 早就有守卫:**

```ts
"effectiveAmount" in d      // ← damageOut 有,damageIn 没有
```

一个文件,两个几乎对称的循环,**只有一个带守卫。**

### ② 静默失效的排序(89–102 行,修前)

```ts
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  //     ^^^^^^ 纯按下标取值,完全不检查内容
}

function toPercentiles(values: number[]): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  //                          ^^^^^^^^^^^^^ 对 NaN 返回 NaN
  return { p50: percentile(s, 50), p75: …, p90: …, p95: … };
}
```

**JS 规范对"比较器返回 NaN"的行为是未定义的,V8 的选择是:不报错,静默留下部分未排序的数组。**

于是 `percentile()` 按下标取值,取到的是乱序里的第 N 个,而不是第 N 百分位。

### ③ 第三个消费者(276 行,修前)

```ts
const sorted = [...used].sort((a, b) => a - b);   // cdFirstUse 也有一份
```

同一个错误,同一个文件,写了两遍。

## 为什么它极难被发现

commit message 原话:

> 单个 NaN 就能让 p50>p90,且 **NaN 经 `JSON.stringify` 变 null、未必落在被选中的索引上**
> —— 坏数据看起来「全是正常数字」,只是顺序不对。

**产物文件 `benchmarks.json` 里根本看不到 NaN。** 你看到的是一堆合理的数字,
只是排列顺序错了。而只有当错乱恰好跨过 p50/p90 的取值下标时,才会表现出症状。

```
28 个 spec  →  4 个被污染
              ├─ 2 个可见倒置(p50 > p90)
              └─ 2 个静默漂移:Feral Druid / Restoration Shaman
                 乱序后碰巧仍然单调,从未表现出任何症状
```

**一半的污染是不可见的。**

## 修法:新建单源谓词

```ts
// packages/analysis/src/utils/stats.ts —— 新文件
export function toSortedFinite(values: readonly number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));   // 先滤,再排
  finite.sort((a, b) => a - b);
  return finite;
}
```

三处调用点全部改为 `toSortedFinite(...)`。

## 修的时候顺手抓出的第二个 bug

同一个 hunk 里多加了一行守卫,它防的是完全不同的另一件事:

```ts
// bi 非有限时 buckets[NaN] 会写成非索引属性 —— 展开时静默丢失,不是累加。
if (!Number.isInteger(bi) || bi < 0) continue;
```

`buckets[NaN] += x` 在 JS 里**不会报错**,它给数组挂了一个名叫 `"NaN"` 的字符串属性。
`[...buckets]` 展开时这个属性被无声丢弃。

**结果不是算错,是伤害凭空消失。** 这是另一个完整的静默失效,搭便车被修掉了。

## 前后数字

```
B 类 百分位倒置   14/50 场  →  0/50 场
benchmarks.json 用 fuzz-1000 重算:143 个百分位块 0 倒置
```

## 索引里的那一行

> Plain `sort((a, b) => a - b)` over a pool containing NaN silently leaves the array
> unordered — **that is what produced `p50 214k | p90 65k` in 11 of 50 matches.**

---

# 三 · D 类:同一个技能,两个冷却值

## 案发文件

`packages/analysis/src/utils/deathOutcomeAnalysis.ts`

## 第一份真相(修前第 48 行起)

```ts
const EXTERNAL_DEFENSIVE_SPELLS: Record<
  string, { name: string; cooldownSeconds: number; specs: CombatUnitSpec[] }
> = {
  '102342': {
    name: 'Ironbark',
    cooldownSeconds: 45,          // ← 手写常量
    specs: [CombatUnitSpec.Druid_Restoration],
  },
  '33206': { name: 'Pain Suppression', cooldownSeconds: 180, … },
  '47788': { name: 'Guardian Spirit',  cooldownSeconds: 180, … },
  …
};
```

消费点(修前第 289 行):

```ts
if (!isAvailableAt(teammate, spellId, spell.cooldownSeconds, atSeconds, matchStartMs)) continue;
//                                    ^^^^^^^^^^^^^^^^^^^^^ 用的是本表的 45
```

## 第二份真相

主路径:`extractMajorCooldowns` → `spellEffectData` + 天赋修正 → **65s**

`[RES]` 台账渲染用的是这一份。

## 结果:同一份 prompt 自相矛盾

```
0:52  Ironbark 施放

本表:  0:52 + 45 = 1:37  →  1:53 时「可用」
台账:  0:52 + 65 = 1:57  →  1:53 时「还在冷却(7s)」

于是同一份 prompt 里:
  [RES]          cd:Ironbark(7s)
  MISSED OPTIONS "had Ironbark available, caster was free"
```

**两边各自的算术都是对的。错的是它们不是同一个数。**

## 修法:不是把 45 改成 65

改成让可用性判定**去问台账要那个已解析的值**:

```ts
/**
 * 返回某单位某技能**已解析的**冷却秒数(即 `[RES]` 台账渲染所用的那个值,
 * 含天赋修正)。传入后优先于下面 EXTERNAL_DEFENSIVE_SPELLS 表里的常量。
 *
 * 为什么必须传:本表曾自带 cooldownSeconds,与主路径各自维护,同一个技能
 * 出现两个值。实证(2026-07-20,ord 041):Ironbark 本表写 45s、台账解析为
 * 65s,0:52 施放后 1:53 时本块判 "available" 而同秒台账写 `cd:Ironbark(7s)`
 * —— 同一份 prompt 对同一个冷却给出相反结论。
 */
resolvedCooldownSeconds?: (
  unit: ICombatUnit,
  spellId: string,
) => number | undefined,
```

消费点:

```diff
- if (!isAvailableAt(teammate, spellId, spell.cooldownSeconds, atSeconds, matchStartMs)) continue;
+ // 冷却值优先取**已解析的**(与 [RES] 台账同源,含天赋修正);
+ // 拿不到才退回本表常量。见本函数签名处的根因说明。
+ if (!isAvailableAt(
+       teammate, spellId,
+       resolvedCooldownSeconds?.(teammate, spellId) ?? spell.cooldownSeconds,
+       atSeconds, matchStartMs)) continue;
```

**为什么不直接改成 65:** 因为下次天赋一改,65 又错了。
把常量改对只修这一次;把数据源接对修所有次。

## 前后数字

```
虚假 "available" 声称:1/50 场  →  0/50 场
```

## 兜底的门

`packages/eval/src/quality/promptQualityCheck.ts` → `checkCooldownLedgerConsistency`

索引里的备注揭示了这个门自己也踩过坑:

> Ownership-aware: **mirror comps make name-only matching 67% false-positive.**

(镜像阵容——两队同职业——按名字匹配会有 67% 误报。门本身修过一次。)

---

# 四 · `"1\r" !== "1"`

## 案发文件

`packages/parser/src/api.ts` → `GladLogParser.push()`

## 修前原文

```ts
public push(rawLine: string): void {
  if (rawLine.trim() === "") {
    return;
  }
  this.linesTotal++;
  const parsed = parseLine(rawLine, { timezone: this.timezone });
  if (parsed === null) {
    this.linesDropped++;
  } else {
    this.segmenter.push(parsed, rawLine);
  }
}
```

注意 `rawLine.trim()` **只用于判空**,拿去解析和拿去 hash 的都是**未 trim 的原文**。

## 为什么恰好炸在假死上

游戏日志是 CSV。按 `\n` 切行后,CRLF 的 `\r` 落在**每行最后一个字段**的尾部。

`UNIT_DIED` 的最后一个字段,恰好是假死位:

```
UNIT_DIED,...,0        ← 真死
UNIT_DIED,...,1        ← 假死(猎人 Feign Death)
UNIT_DIED,...,1\r      ← 实际读到的
```

判定代码写的是 `flag === "1"`,`"1\r"` 不等于 `"1"`,于是**所有假死都进了 `deathRecords`**。

> sample round showed **3 phantom [DEATH] blocks for one BM Hunter**

## 第二个受害者:hash

桌面端的 `tailReader` **早就 strip 掉 0x0d 了**。
只有 eval 语料这条路径没有。于是同一场比赛,**两条路径算出不同的 match id**。

这是同一个 bug 的两个面:**一个污染语义,一个污染身份。**

## 修法

```diff
  public push(rawLine: string): void {
+   // CRLF 日志按 \n 切行后行尾残留 \r,会污染每个事件的最后一个参数
+   // (实锤:UNIT_DIED 假死位 "1\r" !== "1",Feign Death 全被记成真死)
+   if (rawLine.endsWith("\r")) {
+     rawLine = rawLine.slice(0, -1);
+   }
    if (rawLine.trim() === "") {
```

放在函数最顶部——**解析前和 hash 前都在这一句之后**,一次修两个面。

commit message 里那句强调不是废话:

> normalizes trailing \r **before parse AND before rawLines hashing**

## 测试

```ts
it("trailing \\r (CRLF logs split on \\n) is stripped before parsing and hashing", () => {
  // UNIT_DIED 的假死位是最后一个参数;残留 \r 会让 "1\r" !== "1",假死误判为真死
  const run = (suffix: string) => { … };
  // 断言:带 \r 与不带 \r 产出完全一致(含 hash)
});
```

---

# 五 · ` ```json ` 围栏:零容错的解析

## 案发代码

desktop 主进程里的一行:

```ts
JSON.parse(raw.trim())
```

模型返回的是**完全合规的 JSON 数组**,只是外面包了一层 markdown 围栏:

````
```json
[{"category":"…","text":"…"}]
```
````

`raw.trim()` 去掉的是首尾空白,不是围栏。`JSON.parse` 抛异常,整份好分析被判 bad-json,
退化成确定性展示。用户看到的是「模型返回格式异常」。

## 更隐蔽的第二处

> 深挖路径同病且更隐蔽 —— **围栏时 `auditDeepDives` 拿不到数组,深挖静默消失。**

第一处会报错给用户看;第二处**不报错,只是功能没了**。

## 最扎心的一点:答案三周前就在仓库里

commit message 原话:

> eval 脚本注释里早就写着「容错:回复可能带 ```json 围栏」——
> **知识在仓里存在、产品路径却不知道**,正是 CLAUDE.md 那条谓词单源要防的腐烂。

**评测工具早就踩过这个坑并写进了注释。产品代码不知道。同一个仓库。**

## 修法:单源 + 负向契约写死

新文件 `packages/analysis/src/analysis/parseModelJson.ts`:

```ts
/** ```json … ``` / ``` … ```(允许前后有散文)。 */
const FENCE = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/;

/**
 * 解析模型返回的 JSON **数组**。成功返回数组,任何失败返回 null。
 * 调用方按 null 走各自的回退,别再自己 try/catch JSON.parse。
 */
export function parseModelJsonArray(raw: string): unknown[] | null {
  for (const c of candidates(raw)) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}
```

**容错边界被明确写死在 docstring 里,并配了负向测试:**

```
- 截断的 JSON 救不回来 → null(吐半份比回退更糟)
- 顶层是对象 → null(契约就是数组,这是真违约不是格式噪音)
- 围栏里包对象时不许把内层数组切出来救活
  (守卫必须作用在剥完围栏的载荷上)
```

注释里还写了一句设计原则:

> 只做**定位**不做修补 —— **修补等于替模型编内容。**

## 消费点收敛

> desktop 两个调用点与 eval 两个审计脚本**全部改为 import**,仓里不再有第二份围栏逻辑。

## 前后数字

```
40 场真语料 / agy flash:  修前 39/40  →  修后 40/40
救回 1 例围栏,两者都吃不下的 0 例
claudeCli 上按对局稳定复现,某些场次 3/3 全带围栏
```

**注意 39/40 这个数字。** 单看很小——但它是"按对局稳定复现"的:
某些比赛 100% 触发。对那个用户来说,这个功能是**永久坏的**,不是偶尔坏。

---

# 六 · 12MB 表编进 JS 源码

## 根因类型

Vite 默认把 `import data from './x.json'` 编译成 **JavaScript 对象字面量**。
一个 12MB 的 JSON,变成 12MB 的 JS 源码——要被 parse 成 AST、求值、建对象图。

`JSON.parse("…")` 比等价的对象字面量快一个数量级(引擎有专门的快路径)。

## 代码位置与前后数字

| commit | 位置 | 数字 |
|---|---|---|
| `ea8ef76` | main 进程物化整个对象图后再 IPC | 打开一场 **1244ms → 37ms**,main 堆增量 **207MB → 0** |
| `7b69443` | 顶层 await 直接 import 大表 | renderer 首屏不再串行等 **12MB** |
| `67ddc95` | `spellEffectGenerated` 295KB `.ts` 对象字面量 | 迁 `.json`;注明「**22s 事故同种病的最后一块**」 |
| `331b1f1` | 图标表逐条存字符串 | 字典编码 1.5MB → 780KB(41,707 条只有 **7,110 个不同图标名**) |
| `eee7006` | GCD 泳道全量 reconcile | 窗口化后稳态 reconcile 降 **~100 倍** |
| `bba4ed9` | Timeline hover 每帧重建贝塞尔字符串 | min/max 降采样 + `useMemo` |
| `2d7ecc7` | 回放采样线性扫描 | 换二分,行为逐点等价 |

## 两条不属于同一类、但同样离谱的

```
d8c1b97  renderer 生产构建开 minify
         —— electron-vite 默认 false,3.6MB 裸 bundle 从未被压缩
```

**这是配置默认值,不是代码 bug。** 从第一天到 7 月 26 日,发出去的每个安装包
里的前端代码都没压缩过。没有任何测试会红,因为功能全对。

```
bb1a33b  analysis.test 预热 deepDive 模块
         —— CI 慢机上按需 import 把 12MB 表加载算进了 5s 测试超时
```

**性能优化让测试变红了。** 惰性加载把 12MB 的加载耗时算进了某个测试的计时。

---

# 七 · 谓词索引:把「同一事实两份实现」变成 CI 红灯

事故一(A/B/D 三类)、事故五(围栏)本质是同一个病:**同一个事实,两处各写一遍。**
最终的解法不是"更小心",是一张表加一个测试。

## `docs/predicate-index.md` —— 现状 64 条

> ⚠️ `CLAUDE.md` 里写的是 54 条,已经过期了。实际 64 条。

| 分区 | 条数 | 典型 |
|---|---|---|
| 时间与渲染网格 | 3 | `fmtTime` · **`toRenderSecond`**(事故一 A 类的产物) |
| 血量采样 | 2 | **`HP_SAMPLE_RADIUS_MS`** · `getUnitHpAtTimestamp` |
| 冷却可用性 | 4 | `cdAvailableAt`(事故一 D 类的产物) |
| 位置与几何 | **17** | 最大的一块 |
| 顺序统计 | 2 | **`toSortedFinite`** · `medianFinite`(事故一 B 类的产物) |
| 阈值 | 3 | `DMG_SPIKE_THRESHOLD` 等 |
| 分类与名表 | 10 | `specToString` · `ccSpellIds` 等 |
| 格式与标记 | 3 | `PLACEHOLDER` · `fmtFactNum` |
| 门规侧 | 10 | 四条硬门全在这里 |
| 语料归档 | 10 | |

**四个分区是事故直接催生的**(粗体那些)。

## 执行的那一半:`packages/eval/test/predicateIndex.test.ts`(682 行)

这个测试做五件事:

1. **按文件路径 import 表里每一个谓词**——改名或删除 → CI 红
2. **同时解析中英两版**——两版列的谓词不一致 → CI 红
3. **对无法共享 export 的,断言"派生"而非"重打一遍字面量"**
4. **断言 `makeRng` 和 `IndexEntry` 在整个 eval 树里各只有一处声明**
   (原文:*"the only way to pin a type, which the compiler erases"*)
5. **端到端断言生产者/门规互为逆运算**,每条都配**反向对照**,防止断言空洞地通过

第 5 条是最关键的。举例:

> 一个经 `fmtTime` + `renderedWindowSeconds` 渲染出来的窗口,必须能通过
> `checkWindowSpanConsistency`;由 `toSortedFinite` 取出的百分位,必须能通过
> `checkPercentileMonotonicity`;由**真实的** `computeOwnerPositionEvents` 产出、
> **真实的**格式化器渲染的 `HEALER_TRAINED` 声称,必须能通过**真实的**门
> —— 每一条都带反向对照。

## 「尚未统一」那一节 —— 现在是空的

上线当天记录了 5 处在册违规,**同日全部关闭**:4 处变成共享 export,1 处查明根本不是重复。

其中最有意思的一条:

> **"最大合理控制距离"是三个数字声称自己是同一个事实。** 它其实是两个事实:
> `CC_MAX_CAST_RANGE_YARDS`(40 —— 控制能不能够得着)和
> `CC_MAX_PLAUSIBLE_RANGE_YARDS`(45 —— 这个重算出来的距离可不可信),
> 后者由前者派生,所以顺序不会漂。
> **门规私有的那个 50 码被删了:它比生产者自己的抑制阈值还松,所以
> `G6_IMPOSSIBLE_CC` 这条门永远不可能触发。**

**一条门规,因为阈值比它要检查的对象还宽松,从上线起就是死的。**
收紧它对今天的语料行为中性:141,237 条已渲染的控制距离声称里,超过 50 码的 0 条,
超过 45 码的 0 条(最大 44.7)。

## 还有一节专门写"这些不是重复,别去统一它们"

因为**过度统一同样是 bug**。最长的一条解释了为什么生产者和门规**故意**用不同的采样:

> 门规的采样时刻是生产者的**严格超集**,间隙更松,而
> `getUnitPositionAtTime` 的间隙**只接受或拒绝样本、不改变其值**——
> 所以 `gateMin ≤ producerMin` 恒成立,门规那个单边测试
> (「声称的距离比物理上观测到的更近」)是这个方向的正确表达,不是变通。
> **让生产者采用门规的间隙反而是回归**:`INTERP_MAX_GAP_MS` 是那个
> 杀掉「凭空插值出中间位置」的接地守卫(它曾造出一个假的 0.4 码贴脸声称)。

注意这段推理的形状和事故一**一模一样**:「间隙只接受或拒绝样本、不改变其值」。
**同一个洞察,在两个不同的谓词上各被撞见一次。**

---

# 横向清单:所有"沉默失效"的代码形态

| # | 代码 | 静默的机制 |
|---|---|---|
| 1 | `flag === "1"` vs `"1\r"` | 字符串比较失败 → 走 else 分支,不抛异常 |
| 2 | `[...v].sort((a,b)=>a-b)` 含 NaN | V8 不报错,留下部分未排序数组 |
| 3 | `buckets[NaN] += x` | 挂成字符串属性,`[...]` 展开时被丢弃 |
| 4 | `JSON.parse` 抛异常 → `auditDeepDives` 拿不到数组 | 深挖功能整体消失,无提示 |
| 5 | `EXTERNAL_DEFENSIVE_SPELLS` 常量漂移 | 两边算术都对,结论相反 |
| 6 | 门规阈值 50 > 生产者阈值 45 | 门永远不触发,看起来像"从没违规过" |
| 7 | `electron-vite` minify 默认 `false` | 功能全对,只是包大三倍 |
| 8 | 白名单上游缺条目 | 下游规则不触发 ≡ "这个问题没发生过" |

**八种形态,一个共同点:错误的输出和正确的输出,在观察者看来长得一模一样。**

这就是为什么最后落地的门全都是**「重新解析已渲染的文本,再独立复算一遍」**,
而不是单元测试——单测是照着同一份(可能错误的)假设写的。

---

# 复核命令

```bash
cd ~/code/gladlog

# 一 · A 类:铁证
sed -n '394,430p' packages/analysis/src/utils/cooldowns.ts     # getUnitHpAtTimestamp
grep -B10 -A5 'export function toRenderSecond' packages/analysis/src/utils/cooldowns.ts
git show 3cd5342                                                # 假修复(看倒数第三行「未做:端到端 A/B」)
git show 0e13264                                                # 真修复 + 26/50→0/50

# 二 · B 类:NaN
git show 0e13264^:packages/analysis/src/benchmark/metrics.ts | sed -n '89,102p'   # 修前
sed -n '1,45p' packages/analysis/src/utils/stats.ts                               # 修后
git show 0e13264 -U6 -- packages/analysis/src/benchmark/metrics.ts                # 守卫 diff

# 三 · D 类:Ironbark
git show c820ad4^:packages/analysis/src/utils/deathOutcomeAnalysis.ts | sed -n '48,56p'
git show c820ad4 | grep -B12 -A12 resolvedCooldownSeconds
git show dbe61bd                                                # 中间那次被推翻的结论

# 四 · CRLF
git show ac35614^:packages/parser/src/api.ts | sed -n '61,73p'   # 修前
git show ac35614 -- packages/parser/src/api.ts

# 五 · 围栏
git show 132b3da | grep -A40 'parseModelJson'
cat packages/analysis/src/analysis/parseModelJson.ts

# 六 · 性能
git log --oneline --since=2026-07-25 --until=2026-07-27 | grep perf

# 七 · 谓词索引
cat docs/predicate-index.md
npm test --workspace=packages/eval -- predicateIndex
```
