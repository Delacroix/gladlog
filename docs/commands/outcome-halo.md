# outcome-halo — 判官赛果光环实验执行协议

一次性实验(设计:docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md)。
工具常驻 packages/eval;本文档是执行剧本。

## 0. 前置

- worktree 内 `npm run typecheck` 与 eval 包测试全绿。
- 语料源:$GLADLOG_EVAL_HOME/runs/2026-07-30-wire-unnecessary-baseline(300 场 buildCorpus 产物,index.json 含 result)。

## 1. 建臂

```bash
npx tsx packages/eval/scripts/haloBuild.ts --source-run 2026-07-30-wire-unnecessary-baseline --ab 2026-08-05-outcome-halo --seed 20260805 --n-per-stratum 50
```

预期输出:`halo arms: 100 pairs (50 Win + 50 Loss)`。
抽查:任取一 ordinal,diff 两臂 prompt 应只差一行 Result: token。

## 2. Responder(100 件)

按 docs/commands/eval-baseline.md Step 2 的责任方协议执行,差异仅在路径:
读 control/prompts/NNN-*.txt,写 control/responses/<ordinal 三位>.txt,
首行 MATCHID: <matchId> 头照规矩带。sonnet 子代理,一件一代理,≤8 并发。

完成后:

```bash
npx tsx packages/eval/scripts/haloCopyResponses.ts --ab 2026-08-05-outcome-halo
```

预期:copied 100 responses。

## 3. 混池

```bash
npx tsx packages/eval/scripts/blindPool.ts --ab 2026-08-05-outcome-halo
```

预期:Blind pool: 200 items (100 pairs)。

## 4. 盲评(200 件)

按 docs/commands/eval-ab.md Step 5 执行,契约与反去盲铁律原文适用:
一件一判官(sonnet);判官只读 blind/items/item-NN/{prompt.txt,response.txt};
七维 1–5 整数按 docs/commands/eval-baseline.md rubric;score JSON 写
blind/scores/item-NN.json,matchId 填 blindId 占位。
orchestrator 在 Step 5 之前不读 mapping/items/scores。

## 5. 解盲统计

```bash
npx tsx packages/eval/scripts/haloStats.ts --ab 2026-08-05-outcome-halo
```

## 6. 判读与交付

判读规则照 spec:六个非 outcome 维任一 contaminated ⇒ A 采两 pass 判官;
全 inconclusive ⇒ 维持单 pass。reverse 同样算「标签有效应」,进讨论。
交付:ab/2026-08-05-outcome-halo/report.md(主表+分层附表+judgeModel/responderModel
+种子与语料源)、$GLADLOG_EVAL_HOME/ledger.md 记账、结论回写 spec 的 A 行。
