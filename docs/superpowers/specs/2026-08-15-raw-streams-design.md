# 原始日志双流(法力值 + SPELL_CAST_FAILED)设计(BACKLOG #26)

日期:2026-08-15 · 状态:待用户审阅
用户拍板:方案 A(分析层扫 raw.txt,零 parser 改动零库迁移);法力压力 + 蓝效审计进产品候选(走开关+标定+独立 A/B 制度),喝水骚扰做深挖工具,意图区分做守护层(含对已上线 cd-hoarded 的正确性补丁);不预建派生缓存(先实测扫描耗时,慢了再议)。

## 背景

深挖实验自由臂(2026-08-14,match 60ab1e8f)实证 parser 丢弃了 raw.txt 里两条高价值流:

- **逐事件法力值**(advanced 参数):该场死因被重定性为法力死亡(终局 10 秒神圣震击被拒 15 次,蓝 545/273000),此前四轮约束深挖全部漏掉;
- **SPELL_CAST_FAILED**(~933 条/场):玩家按键意图(技能名+拒绝原因),区分「按了被拒」vs「真没按」。

现状:全库 1028/1028 场都存有 raw.txt(与 match.json 同目录);`advancedActorPowers` 字段在数据模型存在但 parser 恒不填充;`SPELL_CAST_FAILED` 在 parser 零引用。归档语料(他人日志)同样保存原始字节,双流可用。

## 架构:单源 raw 流模块

新增 `packages/analysis/src/utils/rawStreams.ts`——唯一的 raw.txt 双流解析点(门规谓词即规范):

```ts
export interface ManaSample {
  tSeconds: number;
  unitGuid: string;
  mana: number;
  manaMax: number;
}
export interface CastFailedEvent {
  tSeconds: number;
  unitGuid: string;
  spellId: number;
  spellName: string;
  reason: string;
}
export function parseRawStreams(rawText: string): {
  manaSamples: ManaSample[];
  castFailed: CastFailedEvent[];
};
// 派生谓词(全部消费 parseRawStreams 的输出,不各自重扫):
export function manaAt(samples, unitGuid, tSeconds): number | null; // 渲染网格锚定:t 先 floor
export function oomWindows(samples, unitGuid, thresholdPct): Window[]; // 低蓝连续窗
export function castFailedInWindow(
  events,
  unitGuid,
  fromS,
  toS,
  spellId?,
): CastFailedEvent[];
export function drinkingSegments(samples, unitGuid): Segment[]; // 蓝量持续回升段(喝水嫌疑)
```

- **raw 缺失优雅降级**:raw.txt 不存在/不可读 → 返回空流并带 `available: false` 标记;所有下游候选静默不产出、深挖子命令明说「流不可用」,绝不 throw。
- **渲染网格**:凡进入 prompt facts 的时刻/时长,先 `toRenderSecond` floor 再派生(P1P2 Task 2 教训)。
- **性能**:流式逐行扫描,不整文件 split;先实测(85GB 库中位 raw ~4-10MB,预期亚秒级),实测超过 ~2s/场再立派生缓存项,本期不做。
- 谓词索引双语登记;eval 既有 raw 扫描(`observedCastsInCc` 族)不重写,后续若需法力/意图观测线,消费本模块。

## 消费方一:两个产品候选(默认开关关)

1. **`mana-pressure`(法力压力)**:己方治疗蓝量跌破阈值形成 OOM 窗,且窗内存在被拒治疗施法或持续接敌 → 候选。facts:蓝量轨迹关键点(峰谷)、OOM 窗时长、窗内 CAST_FAILED 次数与原因、期间友方承压事实。阈值(低蓝 %、窗最短时长、被拒次数门)全部 `<标定定稿>` 占位。
2. **`mana-efficiency`(蓝效审计)**:按治疗法术聚合全场耗蓝 vs 有效治疗(剔除过量治疗),效率低于标定地板且样本量足够 → 候选(全场聚合型,一场至多一条)。facts:逐法术「耗蓝占比 / 有效治疗占比」表、最差法术例证。图例写明这是资源运营信号,与单事件候选形态不同。
   - 耗蓝数据源:法术 mana cost 走官方数据——现有生成物若无耗蓝字段,新增 datagen 脚本挖 `SpellPower` 表(wagoCsv 既有基建,manifest 注册,锚定清单验证照 DR 七步法);有效治疗复用既有 healing 统计谓词,不重算过量治疗口径。

两候选进 `CANDIDATE_TYPE_FLAGS`(扩两键,默认 false),照 P1P2 制度:n≥500 语料标定(发生率/场均/阈值敏感性/双向误差注)→ 各自独立 A/B(responder/judge=sonnet,确定性主指标)→ 逐类型呈用户终批。菜单接线与图例 flag-gated,开关全关生产零变化。

## 消费方二:意图守护(cd-hoarded 正确性补丁,无开关、直接生效)

「没按」类候选生成时查同窗 `castFailedInWindow`:

- **cd-hoarded**:hoard 窗内该技能有 CAST_FAILED → facts 加 `attempted: "曾尝试施放被拒(<reason>×N)"`,严重度降一档(尝试过≠屯着不用);
- 其余「无响应/未使用」类候选(deathUnusedDefensiveEvents 等)同一守护注模式,凡断言「未按 X」前先查意图流。
- 红线测试:合成「按了被拒」fixture → 候选带 attempted 注且降级;「真没按」→ 原行为不变;raw 缺失 → 原行为不变(守护是增强不是新依赖)。

此项不设开关:它只增加事实、修正误报方向,不产生新输出面。

## 消费方三:深挖工具

- `matchExplore <id> mana --unit <name> [--from --to]`:蓝量轨迹关键点 + OOM 窗 + 被拒清单;
- `matchExplore <id> drink`:全场双方治疗 `drinkingSegments` 表(回升段时刻/回蓝量/是否被打断);
- 深挖手册(`docs/commands/deepdive-probe.md`)机制纪律节加一句:「无响应类结论必须先查 CAST_FAILED 意图流」。

## 非目标

- 不改 parser、不改 match.json schema、不做库迁移;
- 喝水骚扰不做产品候选(深挖工具止);
- 不做逐时刻蓝量 UI(回放/时间轴不显示蓝条——若日后要,另立 parser 集成项目);
- 不建派生缓存(实测慢再议)。

## 验收(前后数字)

- 60ab1e8f 复现:`mana` 子命令重建法力死亡叙事(终局蓝 545/273000、震击被拒 15 次与深挖实验数字一致);
- 标定报告:两候选发生率/场均落 0.5-2 带(或如实报告不落带+归因);
- 守护注:全库扫描「cd-hoarded 候选中带 attempted 注的占比」——量化此前的冤枉面;
- A/B:两候选各自采纳率/审计通过率/filler 前后数字;
- 扫描耗时实测数字(中位/最大场),超 2s/场则立缓存挂账;
- 红线测试全绿;谓词索引双语登记。

## 测试

- `rawStreams` 单测:合成 raw 片段(advanced 行/CAST_FAILED 行/畸形行)→ 解析正确、畸形行跳过不崩;
- 候选行为测试照 P1P2 惯例(fixture + 直调 + 负断言 + 单开开关);
- 守护注三红线(见上);
- 真机 sanity:60ab1e8f + 一场无 OOM 对照场。
