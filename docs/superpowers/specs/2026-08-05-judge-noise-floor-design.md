# 判官噪声底改造(子项目 A)设计

日期:2026-08-05。批次:评估工程改进 B→A→C→D 之 A;方案 A3 于批次 brainstorm 拍板,细化于本 spec。前置:子项目 B(`2026-08-05-outcome-halo-experiment-design.md`)已裁决**判官维持单 pass**(六个非 outcome 维光环污染不成立),并给出功效新基准:同臂判官配对差 SD=0.94(accuracy,替代档案值 1.3)。

## 目标与痛点

已知痛点(档案 + eval-ab.md:95):七维里 accuracy 等主观维在 A/B 裁决中分辨率不足,|Δ|<0.4 测不出,内部一致性类修复只能凭确定性判据采纳。目标:

1. **accuracy 噪声源收窄**:从「判官整体打分直觉」收窄到「逐条主张核验」,打分环节改为确定性计算;
2. **A/B 裁决分辨率**提升到可稳定检出 |Δ|≈0.2(K=3 中位数 + 更低的单判官噪声);
3. 校准检出率不倒退(现 7/7 PASS)。

## 设计一:确定性 accuracy(结构化,治本)

关键事实:现行判官**本来就**被强制写逐条 factAudit(每条 verdict ∈ verified/unsupported/refuted,条数受 `FACT_AUDIT_MIN/MAX` 门规约束),rubric 的 accuracy 本来就是 errorCount 查表制(`eval-baseline.md` Step 3 的查表,无插值)。所以改动只在最后一步:

- 判官负责产出 factAudit(逐条主张 + 三元 verdict + 依据行引用);score JSON 里 **仍写 accuracy 字段以保持契约不变**(下游 abStats/校准零改动),但其值必须等于查表计算值;
- `checkScoreProvenance.ts` 新增确定性计算:`accuracy = ACCURACY_LOOKUP(refuted+unsupported 计数)`,查表规则与现 rubric 逐字一致,表作为 export 常量单源;
- 判官所写 accuracy 与计算值不符 ⇒ provenance FAIL(与现有 matchId/hash 校验同级)——打分环节从此没有自由度;
- rubric(`eval-baseline.md`)相应改写:accuracy 一节从「打分锚点」改为「factAudit 产出规范」,三元 verdict 定义沿用 AgentProcessBench 式三分类语义(正确/中立探索/错误)映射到现有 verified/unsupported/refuted。

**不做主张跨判官对齐**:不同判官抽取的主张集合天然对不上,强行对齐会引入新噪声源。每个判官各自 factAudit → 各自确定性分;跨判官聚合走设计二的中位数。

## 设计二:K=3 重判官,只用于 A/B 裁决

- **范围(已拍板)**:K 重只上 A/B 盲评(痛点所在);baseline 维持 K=1(探索性排序,容忍噪声;成本不 ×3)。协议以 K 为参数,默认 A/B=3、baseline=1。
- 派发:每个盲件 3 个独立判官(一件一代理铁律不变,同件的 3 个判官互不知情),分数文件命名 `blind/scores/<blindId>.r1.json` / `.r2.json` / `.r3.json`(具体命名进 plan,须与 abStats 读取端同步)。
- 聚合:`abStats` 先对每件逐维取 **3 分中位数**(accuracy 的三个输入本身已是确定性分),再走现有配对 bootstrap。缺份规则:某件不足 2 份 ⇒ 该件按缺分处理(整对丢弃并计数);恰 2 份 ⇒ 取均值(2 分中位数)并在报告标注。
- 成本账:A/B 一轮 100 对 = 200 件 × 3 = 600 判官(用户已拍板接受);换取的理论分辨率:中位数方差 ≈ 单判官的 ~0.45 倍 ⇒ 配对 SE 约 0.94×0.67/√100 ≈ 0.063,可稳定检出 |Δ|≈0.13-0.2。

## 设计三:验收(前后数字,同一判据)

同一批固定材料(定种子,建议复用 B 的 100 件臂 O 材料——prompt+response 已有、免 responder 成本),旧协议 vs 新协议各测:

| 判据                                   | 现值(旧协议)           | 通过线                                                                              |
| -------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| accuracy 判官间配对 SD(同件两独立判官) | 0.94(B 实测)           | 单判官确定性分 SD 如实测量并报告(无硬线,预期下降);**K=3 中位数配对 SD ≤ 0.5(硬线)** |
| /calibrate-judge 种植缺陷检出          | 7/7 维 PASS(≥0.8)      | 不倒退(7/7 维持)                                                                    |
| 已知差异对检出                         | \|Δ\|<0.4 测不出(档案) | 种植 \|Δ\|≈0.2 的合成差异(按比例混入校准扰动件构造),K=3 协议下 CI 不含零            |

给不出任何一项就明说给不出——不许只靠「协议改了理应更稳」收工。

### 验收结果(2026-08-06 实测,50 对 ×K3=300 判官,种植 10 对 +3s)

| 判据                    | 实测                                                                                                           | 判定                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| K=1 同内容配对 SD       | 0.934(独立复现 B 的 0.94 基线)                                                                                 | ✅ 基线可信                                                                         |
| K=3 中位数配对 SD ≤ 0.5 | **0.751**                                                                                                      | ❌ FAIL——副本误差相关(同模型同 rubric 挑同样的事实),中位数只降 ~20%                 |
| 种植 Δ 检出(CI 不含零)  | 聚合 −0.10 [−0.32, 0.12] inconclusive;逐对:种植均值 −0.50 vs clean 0.000,6/10 检出                             | ❌ 聚合层 FAIL(设计假设 100% 检出率错误,60%×20% 占比≈−0.12 与实测吻合);逐对信号成立 |
| calibration 不倒退      | fabricated-claim 检出 9/10(旧协议同套件 8/10;敏感性 10/10,全部压到 accuracy=1;唯一未计入对仅 specificity 抖动) | ✅ PASS(仅重评 accuracy 相关 20 件——其余六维 rubric 未动;脱敏中转取 caseId 保盲评)  |
| accuracy 契约一致性     | 300/300 零失配(accuracyMismatches=0)                                                                           | ✅ 确定性 accuracy 可独立采纳                                                       |

详细报告:eval-home `ab/2026-08-06-planted-accuracy/report.md`。**最终决议(用户拍板 2026-08-06,选项 a)**:采纳确定性 accuracy(Task 1-2:契约 + 验证门 + rubric,已全部落地);**K=3 不采纳**——代码保留(K 为参数),A/B 默认维持 K=1,最小可检 Δ 维持 ~0.4,更小的差异继续以确定性文本判据裁决。异构副本方向留作未来实验。

## 落点文件

- `docs/commands/eval-baseline.md`:accuracy rubric 改写(factAudit 产出规范 + 分数由系统计算的声明);
- `packages/eval/src/provenance/checkScoreProvenance.ts`:`ACCURACY_LOOKUP` export(单源)+ verdict 计数 → 分数计算 + 自报分一致性校验;
- `docs/commands/eval-ab.md` + `packages/eval/src/ab/blindAbPool.ts`(如需)+ `abCompareStats.ts`:K 重派发命名约定与中位数聚合;
- `packages/eval/src/judge/`(校准侧):checkCalibration 读分适配 K 重命名(校准本身 K=1 不变);
- 谓词索引双语登记 `ACCURACY_LOOKUP`(rubric markdown ↔ 代码常量,等值单测钉住,FACT_AUDIT_MIN/MAX 同款范式)。

## 明确不做

- 两 pass 判官(B 已裁决无必要);
- 主张跨判官对齐/合并;
- baseline 的 K 重;
- 其余六维的打分机制改动(sufficiency 已是确定性门;noise/labelBias 在 A/B 中以确定性 diff 为准,盲分本无裁决权 —— eval-ab.md:95)。
