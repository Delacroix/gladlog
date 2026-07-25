# 测试覆盖提升计划(2026-07-25 审计驱动)

> **For agentic workers:** 本计划按「agy exec 实现 → Claude 审查(diff + 门禁 + 前后覆盖数字)→ commit」逐任务执行。步骤用 checkbox 跟踪。

**Goal:** 把 2026-07-25 覆盖审计发现的产品路径盲区(analysis/src/context 四文件、eval 审计器)补上单测,并落地可复现的 coverage 度量基建。

**Architecture:** 全部走既有测试模式——真实 fixture(`loadLegacyMatchFixture`)克隆 + 合成事件注入(deathrecap 先例),纯函数直喂合成输入;不改生产逻辑(唯一例外:calibrateAuditor 导出纯函数)。每个任务以同判据前后覆盖数字验收(仓库规则:修复要给前后数字)。

**Tech Stack:** vitest ^2 + @vitest/coverage-v8@^2(v8 provider)。

## Global Constraints

- 覆盖判据统一为:`(cd packages/<pkg> && npx vitest run --coverage --coverage.reporter=json-summary)` 读 `coverage/coverage-summary.json` 的 lines.pct——前后必须同判据。
- CI 的 tsc 包含 test 文件;lint 是全仓 `eslint .`(error 级 no-unused-vars 挡 merge)。每任务收尾跑:`npm run typecheck && npx eslint . --quiet && npm test --workspace=packages/<pkg>`。
- parser 的 `parseBudget.test.ts` 在 coverage 插桩下必挂(性能预算),coverage 配置必须 exclude 它或不给 parser 上 coverage CI 门。
- 复合命令绝不 `cd`(用 `(cd … && …)` 子壳);门禁链绝不加管道裁剪输出。
- 提交方式:直接 commit 到 main(仓库既定工作流),每任务一个 commit。
- agy exec 可写文件但会幻觉成功——每次实现后必须读回文件 + 本机跑测试验证,不信 agy 的自述。
- 不为 `@deprecated` 代码补测试(buildMatchFlow);不测 CLI `main()`(eval scripts、abCompareStats.main、log-pipeline 入口)——YAGNI。

## 前后数字基线(2026-07-25 实测,v8 lines)

| 目标文件                                      | 修前             | 目标                            |
| --------------------------------------------- | ---------------- | ------------------------------- |
| analysis/src/context/criticalMoments.ts       | 7.61% (51/670)   | ≥60%                            |
| analysis/src/context/matchTimelineSections.ts | 53.46% (270/505) | ≥80%                            |
| analysis/src/context/resourceSnapshot.ts      | 58.11% (340/585) | ≥80%                            |
| analysis/src/context/matchNarrative.ts        | 20.65% (38/184)  | buildMatchArc 全覆盖(文件 ≥55%) |
| eval/src/provenance/judgeSpotAudit.ts         | 0% (0/112)       | ≥80%                            |
| eval/src/provenance/calibrateAuditor.ts       | 0% (0/180)       | 纯函数部分 ≥40%                 |

---

### Task 0: coverage 度量基建

**Files:**

- Modify: `package.json`(root,加 devDep 与 `coverage` script)
- Modify: `packages/{analysis,parser,desktop,eval,parser-compat}/vitest.config.ts`(加 coverage exclude)

**Interfaces:**

- Produces: 每包 `npx vitest run --coverage` 出干净数字(desktop 不再被 out/ 灌水;eval/analysis 不再被 scripts/ 灌水)。后续任务全部用它做前后对比。

- [x] root `package.json` devDependencies 加 `"@vitest/coverage-v8": "^2.1.9"`,scripts 加 `"coverage": "npm run coverage --workspaces --if-present"`;各包(除 corpus-tools/log-pipeline 可选)加 `"coverage": "vitest run --coverage"`。
- [x] 各包 vitest.config.ts 的 `test` 块加:

```ts
coverage: {
  provider: "v8",
  reporter: ["text-summary", "json-summary"],
  include: ["src/**"],
  exclude: ["src/**/*.d.ts"],
},
```

desktop 额外确认 include 只有 `src/**`(排除 out/、dev/、qa/、scripts/);parser 的 vitest.config 加 coverage 时在 config 注释里写明 parseBudget 与插桩不兼容。

- [x] 验证:`(cd packages/desktop && npx vitest run --coverage 2>&1 | tail -8)` 总行覆盖应从 9% 跳到 ~80%(灌水消除),`git status` 无未预期文件。
- [x] Commit:`chore(test): coverage 度量基建 —— v8 provider + 各包 include src/**,分母剔除构建产物/脚本`

### Task 1: criticalMoments 补测(最大盲区)

**Files:**

- Create: `packages/analysis/test/context.criticalMoments.test.ts`

**Interfaces:**

- Consumes: `identifyCriticalMoments(isHealer, cooldowns, enemyCDTimeline, friendlyDeaths, healingGaps, panicDefensives, overlappedDefensives, ccTrinketSummaries, peakDamagePressure5s, durationSeconds, friends, matchStartMs, owner?)`、`buildDeathRootCauseTrace`、`getEnemyStateAtTime`、`getOwnerCDsAvailable`、`findContributingDeath`、`buildKillMomentFields`、`DEATH_CC_LOOKBACK_S`(全部 export 自 `src/context/criticalMoments.ts`);`loadLegacyMatchFixture()`(test/helpers/legacyFixture)。
- Produces: 该文件行覆盖 ≥60%。

- [x] 测试骨架(agy 按此扩全,合成输入按各接口最小构造):

```ts
import { loadLegacyMatchFixture } from "./helpers/legacyFixture";
import {
  identifyCriticalMoments,
  buildDeathRootCauseTrace,
  getEnemyStateAtTime,
  getOwnerCDsAvailable,
} from "../src/context/criticalMoments";

const match = loadLegacyMatchFixture();
const friends = Object.values(match.units).filter(
  (u) => u.reaction === 1 && u.info,
);

// fixture 无玩家死亡 → 合成 friendlyDeaths 数组驱动死亡类时刻
describe("identifyCriticalMoments", () => {
  it("无死亡无 gap → 空 moments、constrainedTrade=false", () => {
    /* 全空输入 */
  });
  it("注入 1 条 friendlyDeath → 产出 death moment,时间在渲染网格上", () => {
    /* … */
  });
  it("死亡 + 匹配的 healingGap/panicDefensive → 角色归因正确", () => {
    /* … */
  });
  it("ConstrainedTrade 门:burst≥5 + 换CD + 短局 + 后随死亡 → true", () => {
    /* … */
  });
});
describe("buildDeathRootCauseTrace / getEnemyStateAtTime / getOwnerCDsAvailable", () => {
  it("死亡回溯窗口 = DEATH_CC_LOOKBACK_S,越界事件不进 trace", () => {
    /* … */
  });
  it("getEnemyStateAtTime 在无数据时刻返回空态而非抛", () => {
    /* … */
  });
});
```

- [x] agy exec 实现(从 repo 根跑;prompt 给上面骨架 + 文件路径 + 「先读 criticalMoments.ts 与 testHelpers.ts 再写;跑 `npm test --workspace=packages/analysis` 直到绿」)。
- [x] Claude 审查:读回全文件;检查断言不是「跑通即过」的空断言(必须锚定具体值/结构);跑 analysis 全测试 + coverage,记录 criticalMoments.ts 前后数字(7.61% → ___)。
- [x] `npm run typecheck && npx eslint . --quiet`。
- [x] Commit:`test(analysis): criticalMoments 注入式补测 —— 7.61% → <实测>%`

### Task 2: matchTimelineSections 五个 emitter 补测

**Files:**

- Create: `packages/analysis/test/context.timelineSections.test.ts`

**Interfaces:**

- Consumes: `emitRotPressureEntries` / `emitDmgSpikeEntries` / `emitManaMarkerEntries` / `emitFriendlyDeathEntries<S>` / `emitEnemyDeathEntries<S>`(均为 params-object 纯 emitter,export 自 `src/context/matchTimelineSections.ts`)。
- Produces: 该文件行覆盖 ≥80%。

- [x] 每个 emitter 至少三例:空输入 → 空输出;单事件 → 条目字段逐一断言(时间用 fmtTime 渲染网格值);阈值边界(rot pressure 恰好不过门 / 恰好过门)。泛型 `<S>` 的两个 death emitter 用最小 S 桩。
- [x] agy exec 实现 → Claude 审查(同 Task 1 标准)→ 门禁 → 记录前后数字(53.46% → ___)。
- [x] Commit:`test(analysis): timelineSections emitters 补测 —— 53.46% → <实测>%`

### Task 3: resourceSnapshot 补测

**Files:**

- Create: `packages/analysis/test/context.resourceSnapshot.test.ts`

**Interfaces:**

- Consumes: `countActiveAtonements`、`buildPlayerLoadout`、`chargesReadyCount`、`computeReadyNames`、`computeOnCDDisplayNames`、`buildResourceSnapshot(ResourceSnapshotParams)`、`buildJsonSituationSnapshot`(export 自 `src/context/resourceSnapshot.ts`)。
- Produces: 该文件行覆盖 ≥80%。

- [x] 纯计数函数(atonement/charges/ready)合成 aura/cast 输入直测边界(0 个、过期、并发);`buildResourceSnapshot` 与 `buildJsonSituationSnapshot` 用真实 fixture 的 units 驱动 + 断言快照含 HP/资源字段且与同秒渲染网格一致(门规谓词即规范:采样时刻必须 floor 到渲染秒)。
- [x] agy exec 实现 → Claude 审查 → 门禁 → 前后数字(58.11% → ___)。
- [x] Commit:`test(analysis): resourceSnapshot 补测 —— 58.11% → <实测>%`

### Task 4: matchNarrative.buildMatchArc 补测(不碰 deprecated 的 buildMatchFlow)

**Files:**

- Create: `packages/analysis/test/context.matchNarrative.test.ts`

**Interfaces:**

- Consumes: `buildMatchArc`(export 自 `src/context/matchNarrative.ts`;`buildMatchFlow` 已 @deprecated,不测,建议后续单独删除)。
- Produces: buildMatchArc 全分支覆盖;文件 ≥55%。

- [x] 用例:无 burst 无死亡 → 输出仍有 MATCH 骨架;单 burst + CD trade → 因果顺序(Opening→Post-Trade)断言;burst 后随死亡 → 死亡段归入对应 burst 段;时间戳全部 fmtTime 网格。
- [x] agy exec 实现 → Claude 审查 → 门禁 → 前后数字(20.65% → ___)。
- [x] Commit:`test(analysis): buildMatchArc 补测 —— 20.65% → <实测>%(buildMatchFlow 弃测待删)`

### Task 5: eval 审计器补测(judgeSpotAudit + calibrateAuditor 纯部分)

**Files:**

- Create: `packages/eval/test/provenance.test.ts` 已存在 → Create `packages/eval/test/auditors.test.ts`
- Modify: `packages/eval/src/provenance/calibrateAuditor.ts`(仅把内部 claim 腐蚀纯函数 export,如 `corruptClaim`;不动 agy 子进程编排)

**Interfaces:**

- Consumes: `extractSpotAuditCases(...)`(judgeSpotAudit.ts);calibrateAuditor.ts 内部的 timeShift/numberDistort/语义反转腐蚀函数(本任务导出)。
- Produces: judgeSpotAudit ≥80%;calibrateAuditor ≥40%(子进程编排明确不测,注释说明)。

- [x] 腐蚀函数测试即种植缺陷校准的单元版:`"HP dropped at 1:22"` → timeShift 产出 `2:22` 且 note 说明;无数字纯文本 claim → 语义反转回退不抛(终审 F3 行为);numberDistort 只动数字 token。`extractSpotAuditCases` 用合成 judge 归档目录(tmp 目录内造最小文件树)驱动。
- [x] agy exec 实现 → Claude 审查(重点:export 重构无行为变化——`git diff` 里生产文件只允许 `function` → `export function`)→ 门禁 → 前后数字(0%/0% → _**/**_)。
- [x] Commit:`test(eval): 审计器纯函数补测 —— judgeSpotAudit 0→<实测>%,calibrateAuditor 0→<实测>%`

---

## 明确不做(YAGNI,审计已裁定)

- eval `scripts/`(37 个 CLI,工作流按次实跑)、`abCompareStats.main()`、log-pipeline CLI 入口、corpus-tools scripts、desktop `preload`(薄包装,E2E 兜)。
- desktop main 进程(index/ipc/workerHost/exportImage):E2E + electron-vite build 层兜底,electron mock 成本高收益低,留 backlog。
- timelineHelpers.ts (61.6%) / matchTimeline.ts (64.7%):边际收益低,若 Task 1–4 顺带拉高则赚到,不单列。
- coverage 阈值 CI 门:先积累两周稳定数字再定阈值,本计划不加。

## Self-Review 记录

- 六个任务与审计建议一一对应(基建/criticalMoments/sections/snapshot/narrative/eval 审计器);无 TBD;接口签名均从源码核对(criticalMoments.ts:445、resourceSnapshot.ts:304、matchNarrative.ts:17/150、calibrateAuditor.ts:74)。
- 已知风险:identifyCriticalMoments 的输入是上游分析产物(IMajorCooldownInfo 等),合成构造成本高——agy 实现时优先复用 `test/ported/testHelpers.ts` 的现成构造器。
