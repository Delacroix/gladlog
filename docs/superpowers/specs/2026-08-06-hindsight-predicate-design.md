# 产品端后视偏差谓词(子项目 C)设计

日期:2026-08-06。批次:评估工程改进 B→A→C→D 之 C(B、A 已收官)。锚点语义经用户拍板:**隐式锚点 + 豁免表**(零输出契约变更、零 PROMPT_VERSION bump、零缓存失效)。

## 痛点与目标

findings 路径(`buildFindingsPrompt.ts` → `parseModelJsonArray` → `auditFindings`)对模型输出有四层确定性校验(grounding/歧义/数字/因果 lint),但**零时序检查**:模型可以引用 t=130s 的事件写建议、再引用 t=160s 的死亡事件当依据——"如果你在 2:10 交饰品就不会在 2:40 死"式的后视偏差,现在只有散文规则(no-causation)挡,换个说法就绕过。目标:把时序约束升级为确定性谓词,一处 export、产品与 eval 两侧消费,入谓词索引。

## 设计一:谓词定义

`packages/analysis/src/analysis/hindsightLint.ts` 新文件,export:

```ts
export const HINDSIGHT_CLUSTER_SLACK_S = 30; // 同一次交手的聚簇窗;独立常量,语义≠PACK_BEFORE_S
export function hindsightViolations(
  finding: { eventIds: string[] },
  byId: Map<string, CandidateEvent>, // 需要 .t 与 .type
): string[]; // 空数组 = 通过;违规返回人类可读理由(zh)
```

规则(全部在 CandidateEvent 的数字 `t` 空间比较,不涉渲染文本重解析——两侧消费方拿到的都是同一份结构化数据):

1. **锚点** T = **有时刻的**引用事件中最小的 `t`。whole-round 事件(无 `t`)不参与锚点计算、也**不豁免整条**(防旁路:塞一个 whole-round 引用不能关掉谓词);有时刻事件不足 2 个 ⇒ 通过。
2. 记锚点聚簇 = 所有 `t ≤ T + HINDSIGHT_CLUSTER_SLACK_S` 的引用事件。对每个引用事件 e,若 `e.t − T > HINDSIGHT_CLUSTER_SLACK_S` **且** `e.type` 不在锚点聚簇的 type 集合里 ⇒ 违规("引用了锚点 {T}s 之后 {e.t}s 的 {e.type} 事件,跨类型且超出聚簇窗")。(锚点并列多 type 时判定无歧义:聚簇 type 集合天然含全部并列者。)
3. **豁免表**(两条,均已隐含在规则里,列出以固化语义):
   - **同 type 重复** = 模式类 finding("你在 1:10、2:30、4:00 三次吃踢")——聚合建议无特定锚点,合法;
   - **producer 声明的未来事实**(death-setup 的 `facts.deathT` 等)——它们是**单事件的 facts 字段**,不是另一个引用事件,谓词天然不触发;legend 本就要求 death-setup 只引用自身。

设计取舍:不读 explanation 文本判"意图"(不可判定),只约束**引用结构**——跨类型、跨聚簇窗的多事件引用被拆散成独立 findings 反而是更好的教练输出;30s 聚簇窗放行"同一次交手"的合法组合(踢丢 + 被控锁在同 10s 内)。

## 设计二:消费方(一谓词两侧)

1. **产品门(auditFindings)**:第五层 drop,reason 直接取谓词返回串(谓词自带 `hindsight: ` 前缀,消费方**不再拼前缀**,防止 `hindsight: hindsight:` 重复),位置在 causalLint 之后、accept 之前。dropped[] 走既有 onDrop 诊断通道,开发者工作台可见。**直接 enforce(drop)**,不做旗标期——依据:后视建议属质量硬伤,且规则按结构保守设计(误杀面=真跨类型跨时段引用,冒烟实测兜底,见设计三)。
2. **eval 侧**:`packages/eval/scripts/hindsightScan.ts` 语料扫描(rotScan 范式)——对语料场重建候选菜单 + 合成/回放 findings 跑同一谓词,量化违规发生率;并给 `buildCalibrationSuite.ts` 加 `hindsight-pair` 扰动类(hardenCausation 同款范式:取真实菜单里跨类型跨窗的两事件合成 finding),校准谓词检出。
3. **谓词索引**:`docs/predicate-index.md` + `.zh-CN.md` "Gate side" 一节各加一行(`hindsightViolations` + `HINDSIGHT_CLUSTER_SLACK_S`),`predicateIndex.test.ts` 钉扎(符号存在 + 常量单源)。

## 设计三:验收(前后数字,同一判据)

| 判据                                                                              | 通过线                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 种植检出:从真实语料菜单合成 20 个跨类型跨窗 finding                               | 谓词 20/20 捕获                                                        |
| 合法保真:同 type 多事件 + 30s 内聚簇 + death-setup 单事件共 20 个合成合法 finding | 0/20 误杀                                                              |
| 真实冒烟:20 场语料 sonnet responder 走完整 findings 管线,统计 hindsight drop 率   | 如实报告;drop 的逐条人工复核,误杀 >1/3 则回炉调 SLACK/规则(不静默放宽) |
| 单测                                                                              | 谓词边界(恰好 30s、whole-round、同 type 跨时段、单事件)全绿            |

## 落点文件

- 新建 `packages/analysis/src/analysis/hindsightLint.ts` + `hindsightLint.test.ts`;
- `packages/analysis/src/analysis/auditFindings.ts`:第五层 drop;
- `packages/eval/scripts/hindsightScan.ts`(冒烟/发生率);
- `packages/eval/src/judge/buildCalibrationSuite.ts`:`hindsight-pair` 扰动类;
- `docs/predicate-index.md` / `.zh-CN.md` + `packages/eval/test/predicateIndex.test.ts`。

## 明确不做

- deepDive 路径的时序审计(pack 的 +10s 后窗是有意设计,窗口模式语义不同——单列后续任务,不混入本谓词);
- explanation 文本级后视句式识别(causalLint 已覆盖因果句式;意图不可判定,结构约束足够);
- findings schema 加 anchorEventId(用户已否,零契约变更是本方案核心约束);
- 对旧缓存分析结果的追溯清洗(谓词只管新生成路径)。
