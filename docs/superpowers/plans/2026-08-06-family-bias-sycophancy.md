# Family Bias + Sycophancy (Sub-project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land reusable experimental facilities for D1 (2×2 diff-in-diff family bias) and D2 (sycophancy 30 challenges) (DeepSeek driven, diff-in-diff stats, challenge builder), acceptance experiments run by orchestrator personally.

**Architecture:** All purely on eval side. DeepSeek uses OpenAI compatible chat completions (mirrors `packages/desktop/src/main/deepseekClient.ts` request pattern, key reads `~/.config/gladlog-dev/deepseek.key`, read only no print); blind eval pool reuses `blindAbPool` (responses-s/responses-d as control/treatment arms); stats reuses `abCompareStats`'s `BOOTSTRAP_SEED` single source.

**Tech Stack:** TypeScript, vitest; network calls don't go into unit tests (pure prompt construction/stats functions are testable). Absolutely no `tsc -b`; when worktree guard blocks npm/npx, run directly with `node_modules/.bin/vitest` (proven pattern from previous tasks).

## Global Constraints

- key 文件内容绝不进日志/报告/commit;
- 判官盲评:判官 prompt 不提回复来源,回复文本无模型署名;
- 统计常量单源:bootstrap 种子 import `BOOTSTRAP_SEED`,不复制;
- spec `docs/superpowers/specs/2026-08-06-family-bias-sycophancy-design.md` 为准;
- 不动产品代码、不动 predicate-index(无新共享谓词)。

---

### Task 1: DeepSeek 驱动(eval 侧)

**Files:**

- Create: `packages/eval/src/family/deepseekDriver.ts`
- Test: `packages/eval/test/deepseekDriver.test.ts`

**Interfaces:**

- Produces:
  - `readDeepseekKey(): string`(`~/.config/gladlog-dev/deepseek.key`,trim;缺文件抛带路径的错)
  - `buildResponderMessages(promptText: string): ChatMessage[]`(把 coaching prompt 原样作为 user 消息;system 消息与产品 `deepseekClient.ts` 的分析路径一致——先读该文件再定,报告里注明取了哪段)
  - `buildJudgeMessages(rubricText: string, promptText: string, responseText: string): ChatMessage[]`(单条内嵌:rubric 全文 + 待评 prompt + 待评回复 + 「输出仅 score JSON」指令;不提回复来源)
  - `callDeepseek(messages, opts?): Promise<string>`(fetch `https://api.deepseek.com/chat/completions`,model `deepseek-chat`,`max_tokens: 8192`,temperature 与产品一致;指数退避重试 3 次)
  - `parseScoreObject(raw: string): unknown | null`(容错解析单个 JSON 对象:剥 markdown 围栏/前后噪声;与 `parseModelJsonArray` 同精神但目标是对象——先查该函数能否直接复用,能则薄封装)
- 单测只测纯函数(messages 构造、parseScoreObject 的围栏/噪声用例);`callDeepseek`/`readDeepseekKey` 不进单测。

**Steps:**

- [ ] 失败测试 → 红 → 实现 → 绿 → eval 套件全绿 + typecheck → Commit `feat(eval): DeepSeek 驱动 —— responder/judge 消息构造 + 容错对象解析`

### Task 2: D1 双差分统计 + CLI

**Files:**

- Create: `packages/eval/src/family/familyBias.ts`;`packages/eval/scripts/familyBias.ts`
- Test: `packages/eval/test/familyBias.test.ts`

**Interfaces:**

- Consumes: Task 1 驱动;`abCompareStats` 的 `BOOTSTRAP_SEED`;`blindAbPool` 产出的 `blind/mapping.json` 结构(读现有代码对齐字段)。
- Produces(纯函数,CLI 只做 IO):
  - `diffInDiff(cells: {sjSr, djSr, sjDr, djDr}: PerItemScores[][], dims): 每维 {familyBias, ci95, harshness}`——familyBias = (S判(S回)−D判(S回)) − (S判(D回)−D判(D回)),按 prompt 配对 bootstrap(seed 单源);harshness = mean(S判−D判) 全体。
  - `accuracyVerdictBreakdown(...)`:两族判官 factAudit verdict 计数对比(verified/refuted/unsupported 总数与均值)。
- CLI 子命令:
  - `--gen-responses --ab <abId>`:对 `ab/<abId>/prompts/` 逐个调 DeepSeek responder,写 `responses-d/`(已存在的跳过,断点续跑);
  - `--judge-d --ab <abId>`:对 `blind/items/` 逐件调 DeepSeek 判官(rubric 读 `docs/commands/eval-baseline.md` Step 3 节选,与 sonnet 判官同一契约文本),写 `blind/scores-d/<blindId>.json`(带 `judgeModel: "deepseek-chat"`);已存在跳过;
  - `--stats --ab <abId>`:读 mapping + `blind/scores/`(S判)+ `blind/scores-d/`(D判),按臂×判官分 4 格,打印双差分表 + 严宽度 + accuracy verdict 对比,写 `family-stats.json`。
- 单测:合成 4 格分数验证 diffInDiff 的符号与配对逻辑(含已知注入偏差的仿真:给 S判(S回) 全体 +0.5,familyBias 应≈+0.5 且 CI 不含零);accuracyVerdictBreakdown 计数。

**Steps:**

- [ ] 失败测试 → 红 → 实现 → 绿 → 套件+typecheck → Commit `feat(eval): familyBias 2×2 双差分 —— responder/judge/stats 三子命令`

### Task 3: D2 谄媚挑战构造 + 判分 + CLI

**Files:**

- Create: `packages/eval/src/family/sycophancy.ts`;`packages/eval/scripts/sycophancyEval.ts`
- Test: `packages/eval/test/sycophancy.test.ts`

**Interfaces:**

- Produces(纯函数):
  - `buildChallenges(scoreFiles, mapping, opts {seed, count: 30, minMatches: 10})`:从 factAudit **verified** 条目定种子采样,两种取反模板(时间戳平移 ±40s / 断然否认发生),输出 `{id, blindId, claim, challengeText}[]`;采样保证覆盖 ≥minMatches 个不同 matchId,不足如实报错;
  - `buildCoachSimPrompt(promptText, responseText, challengeText): string`(教练续聊模拟的完整输入;不透露评测);
  - `buildSycoJudgeMessages(responseText, challengeText, coachReply): ChatMessage[]`(D 判官用;三分类 {holds|caves|hedges} + 一句依据,输出 JSON);同构的 sonnet 判官指示文本 `SYCO_JUDGE_INSTRUCTIONS` export(orchestrator 派子代理用,与 D 判官同判据文本——单源:D 判官消息由该文本组装);
  - `sycoStats(sClassifications, dClassifications)`:缴械率/含糊率/双判一致率(Cohen 简单一致即可)+ 不一致清单。
- CLI 子命令:`--build --ab <abId> --out <dir>`;`--judge-d --dir <dir>`(对 coach-replies 逐个 D 判);`--stats --dir <dir>`。
- 单测:取反模板确定性(同种子同输出)、时间平移的分秒进位、覆盖场数守卫、sycoStats 计数与一致率。

**Steps:**

- [ ] 失败测试 → 红 → 实现 → 绿 → 套件+typecheck → Commit `feat(eval): sycophancy 挑战构造+双族判分 —— build/judge-d/stats 三子命令`

### Task 4: 验收实验(orchestrator 亲跑,不派实现子代理)

- [ ] D1:`blindAbPool` 以 responses-s(现成 planted-accuracy control 回复)/responses-d(--gen-responses 产出)建 100 件盲池 → 派 100 个 sonnet 判官子代理(A 同款模板,写 `blind/scores/`)→ `--judge-d` 跑 100 件 → `--stats`;判分完整性 200/200、accuracy 零失配核对。
- [ ] D2:`--build` 出 30 挑战 → 派 30 个 sonnet 教练模拟子代理 → 30 个 sonnet 分类判官(用 `SYCO_JUDGE_INSTRUCTIONS`)+ `--judge-d` 30 件 → `--stats`。
- [ ] 报告写 `ab/2026-08-06-family-bias/report.md` 与 `ab/2026-08-06-sycophancy/report.md`;spec 验收节写回实测数字;SDD 台账收尾。

## Self-review

- spec 覆盖:D1 材料/盲评/指标(Task 2+4)、D2 构造/模拟/分类/指标(Task 3+4)、落点四文件全对应;验收表四行由 Task 4 产数。
- 无占位符;类型/命名跨任务一致(ChatMessage、blindId、abId)。
- 风险注记:planted-accuracy control 回复 = halo 臂 O 的 50 份——D1 直接以其 prompts/responses 为 S 臂,无需重跑 responder;若 DeepSeek API 频控,--gen-responses/--judge-d 有断点续跑。
