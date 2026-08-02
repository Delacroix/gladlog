# 问教练:对局内 AI 聊天(coach chat)设计

日期:2026-08-02 · 状态:待用户审
参与决策:用户拍板逐条见「拍板记录」节。

## 目标

在战报里给用户一个聊天框,围绕**当前对局/回合**向 AI 教练自由追问
(「为什么说我 1:20 该开减伤?」「敌方牧师开局在干嘛?」),AI 带着完整
对局上下文与已产出的分析结论作答,可连续多轮、有记忆、关掉重开能续聊。

## 核心机制:聊天 = resume 分析调用的 CLI session

**不单独播种上下文。**「AI 分析」那次 CLI 调用本身(完整 findings prompt +
模型输出的结论)就是天然的会话上下文 —— 聊天直接 resume 那个 session,
每轮只发新问题。由此推出两条硬前置(用户拍板):

1. **仅本地 CLI 后端支持聊天**(claudeCli / agy / codex);Anthropic API 与
   DeepSeek 后端不支持,聊天卡显示引导文案。
2. **必须先用同一个 CLI agent 完成本回合的 AI 分析**才能开聊 —— 跨 agent
   无法复用 session。未满足时聊天卡整体变为提示态:「开始 AI 分析后才能
   对话」(含旧缓存无 session id 的情况,重新分析即修复)。

### 三 CLI 的 session 接口(2026-08-02 本机实测确认)

| CLI       | 分析时捕获/指定 session                                                        | 续聊(只发新问题)                                     |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| claudeCli | 分析调用加 `--session-id <我们生成的 UUID>`(id 自己定,无需解析输出)            | `claude -p --resume <id> <新问题>`                   |
| agy       | 分析调用改 `--output-format json`,从返回信封取 `conversation_id`(实测字段存在) | `agy --print <新问题> --conversation <id> --sandbox` |
| codex     | 分析调用加 `--json`(JSONL 事件流含 session id;最终回答仍走 `-o` 文件)          | `codex exec resume <id> <新问题>`                    |

统一抽象(封在 `localAiBackends.ts`,复用现有 Runner/超时/子进程追踪/
win32 spill 机制):

```ts
// 分析侧:现有 AnthropicLike.stream 增加可选 session 捕获
// 聊天侧:
continueChat(backend, sessionId, question, model): Promise<string>
```

## 分析链路改动(捕获 session id)

- `run()`(main/analysis.ts)经 CLI 后端跑分析时捕获 session id,写入该次
  分析的槽(analysis-v2 slot 新增可选字段 `sessionId`)。API 后端无此字段。
- claudeCli:每次分析调用生成新 UUID 传 `--session-id`。**bad-json 重试
  (attempt 2)必须换新 UUID**(同 id 二次播种会撞已存在的 session)。
- agy:分析调用切到 `--output-format json`,解析信封 `{conversation_id,
status, response}`,`response` 才进 parseModelJsonArray;`status` 非
  SUCCESS 按现有错误路径处理。信封解析失败回退当纯文本(旧行为),此时
  无 session id、聊天门槛照常拦住 —— 分析主流程绝不因 session 捕获失败而失败。
- codex:加 `--json`,session id 从 JSONL 事件流解析;回答仍取 `-o` 文件,
  stdout 不再作回退源(JSONL 非纯文本)。解析不到 id 同上:分析照常成功。
- deepen(深挖)保持现状独立单发调用,不进 session、不捕获。

## 聊天服务与落盘

- main 侧新增 chat 服务(analysis.ts 模式:服务 + ipc.ts handler + preload
  两处):`chat.send({matchId, question})`、`chat.get(matchId)`、
  `chat.cancel(matchId)`。
- 落盘 `<matchDir>/coachChat.<lang>.json`:

```ts
{ version: 1,
  threads: { [cliBackend]: {
    sessionId: string,          // 初值 = 分析槽捕获的 id;自愈后更新
    model: string,              // 随分析槽,续聊沿用
    messages: [{role: "user"|"assistant", content, at}],
  } } }
```

- **每 CLI 各一条线程**:切换 CLI = 切换显示的线程(各自历史独立);当前
  CLI 无线程时,首条消息从该 CLI 的分析槽取 sessionId 建线程。
- 事实源永远是我们的落盘线程史;CLI session 只是句柄。
- 写盘 tmp+rename 原子替换(现有缓存惯例);同场同时只允许一条消息在飞
  (in-flight Set 幂等守卫,windowAnalysis 先例);与批量分析/手动分析
  互不干扰(不同通道、不写 analysis 缓存)。
- 语言:线程文件按当前 aiLanguage 分档,门槛检查也查当前语言的分析缓存
  (session 里的系统提示语言随分析,天然一致)。

## 自愈:resume 失败重播种

session 文件归各 CLI 管,可能过期/被清。续聊报错时走两段自愈:
`chat.send` 返回 `need-reseed`,renderer 此时才用与分析同源的
`buildAnalysisInput` 重建 richContext(平时发送不构建、不传,省 CPU),
连同已有 findings 摘要 + 本线程既往对话拼成种子再调一次
`chat.send({…, seed})` —— main 开新 session(claudeCli 新 UUID /
agy·codex 从输出捕获),更新线程 sessionId 后重发当前问题。自愈一次仍
失败才把该条消息标失败。消息不丢。

## UI(战报右栏,AI 分析卡下方新卡「问教练」)

状态机(整卡互斥四态):

1. **不支持后端**(当前后端非 CLI):引导文案「对话教练需要本地 CLI 后端」
   - 指去设置。
2. **未就绪**(当前 CLI 无本回合分析缓存,或缓存无 sessionId):提示
   「开始 AI 分析后才能对话」—— 用户按分析卡的「AI 分析」跑完即解锁。
3. **可聊**:消息列表(用户右/教练左)+ 输入框 + 发送;顶部小字标当前
   CLI 与模型(如 `claude · sonnet`)。CLI 输出天然整段返回(非流式),
   在飞时显示「教练思考中…」+ 停止按钮。
4. **单条失败**:该条标「发送失败 · 重试」,重试重发同一问题(先走自愈)。

v1 纯文本渲染(法术名保持英文);不做时间点跳转 chips、不做跨对局聊天
(二期);shuffle 每回合独立聊天。

## 错误处理

- 停止按钮:杀该次 CLI 调用(activeChildren 定点版),半截回答不落盘。
- 超时沿用 CLI 后端 300s 上限。
- 聊天回答是自由文本,不走 findings 审计门 —— 卡底部固定一行小字
  「回答基于日志推理,可能有误」(诚实伦理)。

## 测试

- main 服务单测(桩 Runner):三 CLI 播种/续聊参数正确、agy json 信封解析
  (含 status 非 SUCCESS / 信封解析失败回退)、codex JSONL id 提取、resume
  失败自愈换新 session、线程按 CLI 隔离、门槛判定(无分析/无 sessionId/
  API 后端)、落盘形状与并发守卫、claudeCli 重试换 UUID。
- renderer 组件测试(桩 bridge):四态显隐、发送/在飞/失败重试、切后端切线程。
- **真机 smoke(收官前提)**:claude CLI 真分析一盘 → 真 resume 聊一轮;
  agy 同(session 行为桩不出来,占位符纪律教训)。
- 全仓门禁 `npm run presubmit`;聊天卡影响战报布局则走视觉基线配方。

## 非目标(YAGNI,明确不做)

- API 后端聊天(含任何「API 全史重发」形态)—— 用户拍板不支持。
- 跨对局/全局聊天、时间点跳转 chips、聊天答案结构化审计、codex resume 之外
  的 session 高级功能、聊天内容进错题本/聚合。

## 拍板记录

- 聊天对象 = AI 教练围绕对局追问(非角色扮演/非真人社交)。
- 每盘一个,入口在战报;对话落盘续聊。
- 仅本地 CLI 支持;有状态 session,不做无状态全量重发。
- 三 CLI 一视同仁(agy/codex 原生 session 实测确认)。
- 聊天前置 = 同一 CLI agent 已完成本回合 AI 分析(复用分析 session)。

## 风险与开放点

- agy/codex 分析输出格式切换(json/JSONL)动的是**现有分析主链路**,是
  本设计风险最高的一步 —— 实现计划里必须先行单测覆盖 + 真机各 smoke 一次。
- CLI session 的磁盘占用/过期策略我们不管理(归各 CLI);自愈路径兜底。
- 续聊缺省**传**与线程记录一致的 `--model`(与播种同源);若实测某 CLI
  resume 时不接受该参数再去掉 —— 方向定死,只留兼容性开关。
