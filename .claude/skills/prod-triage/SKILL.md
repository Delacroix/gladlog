---
name: prod-triage
description: 用户报产品症状(分析结果不对/UI 显示错/性能异常)时的定位工作流 —— 在本机真实对局库上量化复现、机制定位、同判据前后数字验收。用于「只有N条」「XX显示错了」「很慢/内存涨」这类生产反馈。
---

# 生产症状定位(2026-07-25 一天七例沉淀)

核心纪律:**先量化复现,再谈机制;修完必须同判据前后数字**(见 memory
fix-needs-before-after-numbers)。猜测出的修法当天被数据推翻过两次
(SpellCooldowns 有行判据、name-bridge),都是量化才拦下的。

## 数据源:本机真实对局库

```
~/Library/Application Support/gladlog/matches/
  _index.ndjson          # 每行一个 meta(id/kind/bracket/startTime/durationS)
  <id>/match.json        # {schemaVersion, kind, data};shuffle 的 data.rounds[]
  <id>/raw.txt           # 原始日志行(B2 lineIndex 对齐)
```

- 取最近 N 场:`index.slice(-N)`;shuffle 逐轮 = `doc.data.rounds`
- 单位事件数组:`units[id].{casts,auraEvents,damageOut,...}`,玩家判定 `u.info`
- doc 已瘦身(params ≤13 位稀疏);旧肥档读取时自愈

## 诊断脚本约定

- 放 `packages/desktop/scripts/tmp-*.mts`(workspace 依赖只在包内可解析,
  /tmp 下 tsx 解析不了 `@gladlog/*`;.mts 免 CJS/TLA 冲突),**用完即删**
- 需要复刻渲染层口径时 import 真 derive(`toLegacySafe` + derive 函数),
  别手写第二套谓词(门规谓词即规范)
- 判据值得留的,升级进 `packages/eval/scripts/`(evidenceDist/confidenceAudit
  模式:常驻 + 注释里写基线数字)

## AI 管线症状(格式异常/条数不对)

`packages/desktop/scripts/verify-production.ts`:对本机真实对局跑与产品
逐字一致的 findings 链路(真模型 claudeCli + zh system),输出每场
菜单数/解析 attempt/保留/丢弃原因。丢弃原因是第一线索(collision/
numeric/causal 各对应一类 rubric-模型失配)。用户侧残留症状:设置→
开发者页有最近 10 次调用的 prompt/raw。

## 修后验收清单

1. 同一诊断脚本复测,前后数字进 commit message
2. 涉及白名单/官方表:全语料复扫(parserInvariants / confidenceAudit /
   evidenceDist 带 --manifest)
3. `npm run presubmit`;UI 变更走 desktop-dev 的视觉基线配方
4. 发版走 release skill;用户在等修复时按当前小版本 +1 直接出包
