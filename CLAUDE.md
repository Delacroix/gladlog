# gladlog

## 门规谓词即规范(shared-predicate rule)

分析代码(`packages/analysis`)与验证门(`packages/eval` 的 positioningScan/qualityCheck/layerA 审计)对**同一个事实**(HP、距离、LoS、时间点)必须共享**同一个谓词**:同一常量、同一采样函数、同一容差,且**锚定在渲染值上**——prompt 渲染 `fmtTime`(向下取整秒),门规重新解析渲染文本,所以分析内部的小数秒/原始时刻在写入 prompt 前必须先 floor 到渲染网格再做任何门规会复算的判定。

违反此规则的历史代价:2026-07 全量审计中 5 个独立 bug 全是这一类(HP 采样半径不一致、有界 vs 无界回溯、插值 vs raw vs 非同时刻采样对 LoS、小数秒 vs 渲染秒扫描网格)。修法永远是让分析消费门规的谓词,不是反过来放松门规。共享点示例:`cooldowns.ts` 的 `HP_SAMPLE_RADIUS_MS`;`positionSampling.ts` 的 `LOS_SWEEP_SLACK_S`/`LOS_SWEEP_GAP_MS` —— `positioningScan.ts` 的 `TIME_SLACK_SECONDS`/`POSITION_MAX_GAP_MS` 现在直接是它们的别名(结构性耦合,比「必须相等」更硬)。注意两个例子**结构不同**:前者门规侧压根没有对应常量,靠重新解析已渲染的 prompt 文本来验 —— 「共享谓词」不总是等于「共享常量」。

新增任何"分析断言 X、门规验证 X"的配对时:谓词放一处 export,两边 import;做不到时写断言相等的单测,别靠注释。

**现有谓词在哪,查 [`docs/predicate-index.md`](docs/predicate-index.md)**(70 条,配 `packages/eval/test/predicateIndex.test.ts` 的一致性测试:符号改名/移动会打红 CI)。索引不只收分析↔门规:2026-08-04 起也收 desktop renderer **内部**两个消费方判同一事实的情况(「战报 UI」一节),判据同样是「一个事实一个谓词」。写新代码前先查表 —— 这条规则不缺,缺的一直是索引:2026-08-01 有人读过本节、当天仍手抄了两处谓词。该索引上线时当场查出 5 处在册违规,**当天全部关闭**(4 处改共享 export、1 处查明并非重复);文档的「尚未统一」一节现为空,新发现的重复登记到那里。

## 修复要给前后数字(verification rule)

声称某个 bug「修好了」时,附**同一判据下的前后数字**(如「A 类同秒 HP 矛盾 26/50 场 → 0/50」)。
给不出就明说给不出——**读代码 + 一份有说服力的 commit message 不算验证**。

2026-07-20 的代价:`3cd5342` 按「统一 HP 采样半径」修同秒 HP 矛盾,根因写得头头是道,
进了 main;后来实测 **26/50 → 26/50,一个数没动**(半径只控制接受/拒绝,不改变取到的
样本值,真根因是查询时刻不在渲染网格)。同日 `dbe61bd` 又因**只查一个样本就外推整类**
把 D 类误判为「记号歧义」,被独立评审用反例推翻(`c820ad4`)。

配套:判据优先做成**确定性文本检查并固化进门规**(`packages/eval/src/quality/promptQualityCheck.ts`
的 `hardFailures`,现有六类:友方死亡覆盖 / 百分位单调 / 同秒 HP 一致 / 窗口时长自洽 / 冷却台账一致 /
快照事实一致 `checkSnapshotFactsConsistency`),不要留一次性脚本——它随会话消失,下次回归没人挡。

## 文档双语成对(bilingual docs rule)

以下 12 篇文档**英文是正名、中文带 `.zh-CN` 后缀**,两版内容必须等价 —— 改任一边就同步改另一边,做不到就先别改:

`README.md` · `CHANGELOG.md` · `docs/user-guide.md` · `docs/FAQ.md` ·
`docs/setup-windows-claude-cli.md` · `docs/developer-guide.md` ·
`docs/BUILD-WINDOWS.md` · `docs/verifiability-roadmap.md` ·
`docs/DATA-COMPLIANCE.md` · `docs/pvp-log-archive.md` ·
`docs/architecture.md` · `docs/predicate-index.md`

**包级 README 同理**:凡是存在 `packages/<pkg>/README.zh-CN.md` 的,`README.md` 就是正名,两版必须等价(现有:`analysis`、`desktop`)。`corpus-tools/README.md` 目前仍是中文单版,属历史遗留,哪天补英文版就一并纳入本规则。

每篇 H1 正下方一行语言条(当前语言加粗不带链接,另一语言是链接);互链**同语言闭环** —— 英文篇之间指英文文件,中文篇之间指 `.zh-CN.md`,别跨语言指。新增用户文档也照这个来。

## 常用

- 类型检查:`npm run typecheck`(绝不 `tsc -b`,会往 src 吐 .js)。
- desktop push 前:`npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet`——**真正的缺口是 lint 范围**:CI 跑 `eslint .` 覆盖全仓,而只扫 `packages/desktop/src` 会漏掉 `test/`、`qa/`、`dev/`、`scripts/`(连挂过三次)。typecheck 本地与 CI 看的是同一批文件(都走 `tsconfig.json`,`include` 已覆盖 src/test/dev/qa),不是缺口。工程约定见 `.claude/skills/desktop-dev`。
- eval 工作流:`/eval-baseline`(找问题)→ `/eval-ab`(验证修复)→ `/calibrate-judge`(判分前校准)→ `/pipeline-audit`(全语料审计)。产物在 `$GLADLOG_EVAL_HOME`(默认 `~/code/gladlog-eval-private`)。
