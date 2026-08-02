import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyCliModelName } from "../shared/aiModels";
import {
  detectLocalCliCached,
  probeCliVersionCached,
  type CliVersionProbe,
  type LocalCliTool,
} from "./cliDetect";
import type { AnthropicLike } from "./ai";

// `claude -p` carries agentic overhead and is slow on big prompts (minutes);
// agy/Gemini is much faster. Generous ceiling so a real completion can land.
const TIMEOUT_MS = 300_000;
// codex -o 临时文件名的自增序号:同一 main 进程可能并发两次 stream(onRunAll
// 同时触发 analysis + compare 是真实场景),纯 Date.now()+pid 在同一毫秒内
// 会撞名互踩 —— 加计数器保证同进程内唯一,Date.now() 因此可以去掉。
let codexTmpSeq = 0;
// agy 超限 prompt 落盘的临时文件序号,唯一性理由同上。
let agyTmpSeq = 0;

// agy/codex 落盘的临时文件(完整对局 prompt / 模型回复)各自专用子目录,
// 而不是整个 OS 临时目录 —— 2026-07-31 审计 Important:此前 agy 的
// `--add-dir tmpdir()` 把 agy sandbox 的读权限授权到整个 OS 临时目录(任何
// 其他程序、其他用户的临时文件都在授权范围内),而 agy 只需要读自己这一
// 个 prompt 文件。P0 修复(见上方大注释)已让落盘成为 win32 .cmd/.bat 的
// **恒定路径**(不再按长度分档),这个过宽授权此后每次 Windows agy 调用
// 都会命中,收窄的价值随之从"极端情况"变成"每次都生效"。
// exported so tests can assert --add-dir narrows to this exact path (not
// tmpdir()) and can plant/inspect files in it directly.
export const AGY_PROMPT_SPILL_DIR = join(tmpdir(), "gladlog-agy-prompts");
// codex 的 -o 输出文件由 codex 自身进程写入(不是本文件 writeFileSync 的),
// 拿不到"我们写文件时设 mode"这道保护,专用子目录 + 目录本身的限制权限
// (POSIX 上 0o700 拒绝其他用户遍历进目录,不管目录里文件各自的 mode 是
// 什么)是这条通路上唯一能收的口子。
export const CODEX_OUT_SPILL_DIR = join(tmpdir(), "gladlog-codex-out");

// 每个 spill 子目录本进程只 sweep 一次(module 内首次落盘时触发,不是
// import 时就做 IO —— 测试大量 import 这个模块从不落盘,不该背这个开销/
// 副作用)。
const sweptSpillDirs = new Set<string>();
// 陈旧判据:agy --print-timeout 110s、codex 整体 TIMEOUT_MS 300s,一次正常
// 调用的 spill 文件生命周期是"函数调用期间"这个量级,1 小时是几十倍余量
// ——超过这个岁数的文件只可能是上一个进程被杀 / 崩溃,没跑到 finally 清理
// 就退出留下的遗留(完整对局 prompt,含比赛数据)。
const STALE_SPILL_MS = 60 * 60 * 1000;

/**
 * 确保 spill 子目录存在(尽量以 0o700 创建,仅当前用户可进)并清扫其中
 * 超过 STALE_SPILL_MS 的陈旧文件——上一个进程崩溃/被杀留下的、没有 finally
 * 兜底清理机会的对局 prompt。每个目录每个进程只做一次(见 sweptSpillDirs),
 * 调用方在每次落盘前调用,开销可忽略。全程 best-effort:任何一步失败都不
 * 应该阻塞正常的 AI 调用流程,顶多下次进程再扫一遍。
 *
 * exported so tests can drive it directly against a throwaway directory
 * (planting a backdated stale file + a fresh one) without depending on
 * agyClientFactory/codexClientFactory's internal spill timing.
 */
export function ensureSpillDirSwept(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // 目录已存在、或平台不支持该 mode——不影响后续 writeFileSync,继续。
  }
  if (sweptSpillDirs.has(dir)) return;
  sweptSpillDirs.add(dir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > STALE_SPILL_MS) unlinkSync(p);
    } catch {
      // 并发清理/权限问题:best-effort,跳过这一个文件。
    }
  }
}

/**
 * A CLI runner: spawn `file` with `args` (NO shell — args are an array, so
 * match data in the prompt can never be interpreted by a shell), write `stdin`,
 * resolve stdout. Non-zero exit / spawn error / timeout reject.
 *
 * `opts.signal`(可选第 4 参):调用方(coach chat 续聊)可传 AbortSignal 中止
 * 飞行中的调用——defaultRun SIGKILL 子进程并 reject `new Error("aborted")`;
 * 既有调用点/测试桩不传第 4 参照常工作(可选参数,签名向后兼容)。
 */
export type Runner = (
  file: string,
  args: string[],
  stdin: string,
  opts?: { signal?: AbortSignal },
) => Promise<string>;

// win32 上,resolve 出来的 CLI 二进制若是 .cmd/.bat(npm 全局安装的常见
// shim 形态),Node 近期版本对 `spawn(file, args)` 直接跑 .cmd/.bat 会抛
// EINVAL(CVE-2024-27980 的修复动作,逼你显式 `shell: true` 才能跑)——
// 这也是 defaultRun 手工 `spawn("cmd.exe", ["/c", file, ...args])` 包一层
// 的原因。但 cmd.exe 会把 Node 用 argv 数组按 MSVCRT 惯例拼好的那行命令
// **重新解析一遍**:`&`/`|` 断成两条命令、`^` 转义、`%NAME%` 展开环境
// 变量、不平衡的 `"` 让后续参数边界整体错位——这跟 Node 构造 CreateProcess
// 命令行时假设的引用惯例完全是两套语法,argv 数组的“一个元素=一个参数”
// 边界在 cmd.exe 眼里不成立。
//
// agy 后端此前把完整 prompt(对局文本,HP 百分比含 `%`,几乎必中)经
// `--print <prompt>` 塞进这条 argv,7000 字符以内直接不落盘——本质是本地
// 命令注入/可靠性隐患(2026-07-31 审计 Critical)。修法两道,双保险:
//   1) agyClientFactory:win32 上只要 resolve 到 .cmd/.bat,恒走落盘中转
//      (winPromptLimit 对 .cmd/.bat 恒为 0,不再按 7000 字符分档)——argv
//      只装 gladlog 自己写的临时文件路径 + 固定英文引导语,不再有任何
//      对局/模型可控文本进 argv。
//   2) defaultRun 的 .cmd/.bat 分支额外过 assertNoWindowsCmdMetacharacters
//      兜底:万一以后哪次改动又把不受控内容塞回 argv,直接抛错而不是带
//      着注入风险硬跑。
// 没有改用 `spawn(file, args, { shell: true })` 替代手工 cmd.exe 包装:
// Node 内部对 `shell: true` 在 Windows 上的转义规则,这台 mac 上验证不了
// 真实 cmd.exe 行为,换一套不可审计的隐式转义并不比“显式包装 + 显式守卫”
// 更安全,故维持手工包装 + 显式校验。
//
// claudeCliClientFactory/codexClientFactory 在 win32 上同样可能落到这条
// .cmd 分支(claude/codex 的 npm 全局安装同样常见 .cmd shim),但两者
// argv 只有固定 flag 字符串 + 调用方传入的模型名(`params.model`,来自
// UI 的白名单下拉,不是模型生成文本)+ codex 的 `-o` 临时文件路径
// (gladlog 自己 `join(tmpdir(), ...)` 拼出来)——prompt 本体走 stdin,
// 不经 argv。两者不受本条影响,守卫仍会覆盖到但预期恒过。
const WIN_CMD_METACHAR_RE = /[&|^%<>]/;

/** 见上方大注释:defaultRun 手工包 cmd.exe 时的 argv 兜底校验。 */
export function assertNoWindowsCmdMetacharacters(
  args: string[],
  file: string,
): void {
  for (const arg of args) {
    if (WIN_CMD_METACHAR_RE.test(arg)) {
      throw new Error(
        `内部错误:传给 ${file}(经 cmd.exe 执行的 .cmd/.bat)的参数含 cmd.exe ` +
          `元字符(& | ^ % < > 之一)——cmd.exe 重新解析 argv 时会把它当命令 ` +
          `语法而非字面文本,已拒绝执行。这类内容必须先落盘,argv 只传文件路径。`,
      );
    }
    if ((arg.match(/"/g) ?? []).length % 2 !== 0) {
      throw new Error(
        `内部错误:传给 ${file}(经 cmd.exe 执行的 .cmd/.bat)的参数含不平衡的 ` +
          `双引号——cmd.exe 重新解析时会让后续参数边界整体错位,已拒绝执行。`,
      );
    }
  }
}

// exported so tests can feed a mock child process directly (multi-byte UTF-8
// chunk-boundary regression test) without going through the Runner seam that
// every other test in this file uses to bypass defaultRun entirely.
//
// quitLifecycle #21 item9:退出时也要能收掉飞行中的 CLI 子进程,而不是
// 只指望宿主进程死掉后它们自然变成孤儿——完整性起见,追踪当前活跃的
// child,退出钩子调用 killAllCliChildren() 一次性 SIGKILL 全部。
const activeChildren = new Set<ReturnType<typeof spawn>>();

/** quitLifecycle 退出钩子调用:SIGKILL 所有仍在飞行中的 CLI 子进程。 */
export function killAllCliChildren(): void {
  for (const c of activeChildren) {
    try {
      c.kill("SIGKILL");
    } catch {
      // best-effort:退出流程不能因为这里报错而卡住。
    }
  }
}

export const defaultRun: Runner = (file, args, stdin, opts) =>
  new Promise((resolve, reject) => {
    // 调用时已 abort:不 spawn,直接 reject——续聊 UI 快速连续切换/卸载时
    // 常见,不该留一个永远不会被观测到结果的子进程在飞。
    if (opts?.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const isWinBatch =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    if (isWinBatch) assertNoWindowsCmdMetacharacters(args, file);
    const child = isWinBatch
      ? spawn("cmd.exe", ["/c", file, ...args], {
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    // Buffer 累积、结束时一次性 decode —— 逐块 `+= d.toString()` 会在多字节
    // UTF-8 字符(中文等)跨 chunk 边界被切开时各自解出 U+FFFD 乱码
    // (300 盘 agy 模拟真实撞见,生产 aiLanguage 默认 zh)。
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      activeChildren.delete(child);
      reject(new Error("aborted"));
    };
    if (opts?.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => outChunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.from(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      opts?.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      opts?.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(Buffer.concat(outChunks).toString("utf8"));
      else
        reject(
          new Error(
            `${file} exited ${code}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 300)}`,
          ),
        );
    });
    child.stdin.end(stdin);
  });

/**
 * 自动检测(PATH + 常见安装目录,见 cliDetect.ts),检测不到抛中文明确
 * 错误 —— 以前返回裸命令名,失败要到 spawn 时才冒一个 ENOENT,用户完全
 * 看不懂;现在错误直接指去设置页。
 */
async function requireCli(tool: LocalCliTool): Promise<string> {
  const path = await detectLocalCliCached(tool);
  if (path) return path;
  // node 缺失不能指去「命令路径」:那格填的是 agy 脚本/二进制,填成 node
  // 路径会被当成 agy 直调二进制,拿 --print 参数起 node 直接报参数错
  // (agy flash 复核 #5)。
  if (tool === "node") {
    throw new Error(
      "未检测到 node(.mjs 包装脚本模式需要 Node.js):请安装 Node.js,或清空命令路径改用自动检测的 agy 直调",
    );
  }
  throw new Error(
    `未检测到 ${tool} 命令:请先安装,或在 设置 → AI 分析 → 命令路径 填写完整路径`,
  );
}

/**
 * 解析 CLI 路径 + 顺手踢一次版本探测(仅自动检测路径;手填命令路径
 * 时无"检测到的版本"概念,不探测——见 withVersionHint 对 versionProbe
 * 为 null 时的处理)。审计 #21 item6。
 */
async function resolveCliWithVersionProbe(
  tool: LocalCliTool,
  explicitCmd?: string,
): Promise<{ cmd: string; versionProbe: Promise<CliVersionProbe> | null }> {
  if (explicitCmd) return { cmd: explicitCmd, versionProbe: null };
  const cmd = await requireCli(tool);
  return { cmd, versionProbe: probeCliVersionCached(tool, cmd) };
}

/**
 * 调用失败时,把版本探测结果(「检测到的 X 版本 Y」或「版本探测失败」)
 * 附到错误信息里,给用户一条"可能版本不兼容"的归因线索,而不是只有裸
 * stderr。`versionProbe` 为 null(手填命令路径,没走自动检测)时原样
 * 抛出,不附加。轻量提示,不做版本闸门/兼容矩阵。
 *
 * exported so tests can drive the threading behavior directly (with a
 * hand-built versionProbe promise) without exercising the full
 * requireCli auto-detect chain, which would otherwise spawn real
 * subprocesses in unit tests.
 */
export async function withVersionHint<T>(
  fn: () => Promise<T>,
  tool: LocalCliTool,
  versionProbe: Promise<CliVersionProbe> | null,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 用户主动取消(defaultRun 的 AbortSignal 处理 reject 出的裸
    // Error("aborted"))原样抛出,不附版本提示——continueCliChat 走的是
    // 生产默认自动检测路径(input.cmd 未手填),versionProbe 非 null,
    // 若不在此短路,"aborted" 会被重写成
    // "aborted(检测到的 X 版本 Y,可能版本不兼容)",下游任何依赖
    // err.message === "aborted" 精确匹配来区分"用户取消"与"真实调用
    // 失败"的逻辑都会失效(教练聊天可中止这一体验的核心目的因此被
    // 自身错误包装层削弱)。coach-chat task-5 review 修复。
    if (msg === "aborted") throw e instanceof Error ? e : new Error(msg);
    if (!versionProbe) throw e instanceof Error ? e : new Error(msg);
    const probe = await versionProbe;
    const hint = probe.ok
      ? `检测到的 ${tool} 版本 ${probe.version}`
      : "版本探测失败";
    throw new Error(`${msg}(${hint},可能版本不兼容)`);
  }
}

// 本地 CLI 后端没有独立 system 通道:system 拼接在 prompt 最前。
const joinPrompt = (params: {
  system?: string;
  messages: { content: string }[];
}): string =>
  [params.system, ...params.messages.map((m) => m.content)]
    .filter((s): s is string => !!s)
    .join("\n");

/** `claude -p --output-format text`, prompt on stdin, stdout = clean completion. */
export function claudeCliClientFactory(opts?: {
  cmd?: string;
  run?: Runner;
}): AnthropicLike {
  const run = opts?.run ?? defaultRun;
  return {
    async *stream(params) {
      const { cmd, versionProbe } = await resolveCliWithVersionProbe(
        "claude",
        opts?.cmd,
      );
      const sessionArgs = params.sessionIdHint
        ? ["--session-id", params.sessionIdHint]
        : [];
      const out = await withVersionHint(
        () =>
          run(
            cmd,
            [
              "-p",
              "--output-format",
              "text",
              "--model",
              params.model,
              ...sessionArgs,
            ],
            joinPrompt(params),
          ),
        "claude",
        versionProbe,
      );
      yield { delta: out };
      if (params.sessionIdHint) yield { sessionId: params.sessionIdHint };
    },
  };
}

/**
 * `codex exec - -m <model> --sandbox read-only --skip-git-repo-check
 * --ephemeral -o <tmpfile>`, prompt on stdin.
 *
 * Why a `-o` tmpfile instead of reading stdout: codex's stdout interleaves
 * agent/tool-call log lines with the final answer, so naively taking stdout
 * would hand the prompt-quality gates a blob full of noise instead of a
 * clean completion (the same shape of bug the `stripAgyHeader` fix above
 * addresses for agy, just worse — codex's log isn't a single strippable
 * header line). `-o <file>` writes exactly the final response with nothing
 * else, so that's the primary source; stdout is only a fallback for older/
 * different codex builds that don't honor `-o`, not the intended path.
 *
 * 回退判据是"文件读取是否成功",不是"文件内容是否非空"——模型合法返回
 * 空串是可能的,把它当"文件无效"会转而把混着 agent 日志的脏 stdout 当
 * 回复吐给上游,比空回复更糟。只有 readFileSync 本身抛错(文件不存在,
 * 例如旧版本 codex 不认识 `-o`)才回退 stdout。
 *
 * captureSession 时 args 含 --json 且不含 --ephemeral,stdout 是 JSONL
 * 而非人类文本,解析抓 session id,回答仍取 -o 文件。-o 文件读不出时
 * delta 为空串(不回退脏 stdout)。
 */
export function codexClientFactory(opts?: {
  cmd?: string;
  run?: Runner;
}): AnthropicLike {
  const run = opts?.run ?? defaultRun;
  return {
    async *stream(params) {
      const { cmd, versionProbe } = await resolveCliWithVersionProbe(
        "codex",
        opts?.cmd,
      );
      ensureSpillDirSwept(CODEX_OUT_SPILL_DIR);
      const outFile = join(
        CODEX_OUT_SPILL_DIR,
        `gladlog-codex-${process.pid}-${++codexTmpSeq}.txt`,
      );
      const sessionArgs = params.captureSession ? ["--json"] : ["--ephemeral"];
      let stdout: string;
      try {
        stdout = await withVersionHint(
          () =>
            run(
              cmd,
              [
                "exec",
                "-",
                "-m",
                params.model,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                ...sessionArgs,
                "--color",
                "never",
                "-o",
                outFile,
              ],
              joinPrompt(params),
            ),
          "codex",
          versionProbe,
        );
        let delta = params.captureSession ? "" : stdout;
        try {
          delta = readFileSync(outFile, "utf-8");
        } catch {
          // -o 文件缺失(旧版本 codex 不认识该参数等)
          // captureSession 时不回退(stdout 是 JSONL,不是人类文本)
          // 非 captureSession 时回退 stdout
          if (!params.captureSession) {
            delta = stdout;
          }
        }
        yield { delta };
        if (params.captureSession) {
          const sid = parseCodexSessionId(stdout);
          if (sid) yield { sessionId: sid };
        }
      } finally {
        try {
          unlinkSync(outFile);
        } catch {
          // best-effort 清理;文件本就可能不存在。
        }
      }
    },
  };
}

/** Strip agy's leading `[agy-run] …` header line. */
export function stripAgyHeader(s: string): string {
  const nl = s.indexOf("\n");
  return nl !== -1 && s.startsWith("[agy-run]") ? s.slice(nl + 1) : s;
}

/** codex `--json` JSONL 事件流里的会话 id:逐行 JSON.parse,取第一个
 * `session_id` 或 `thread_id` 形如 UUID 的值;整流解析不出返回 null。 */
export function parseCodexSessionId(stdoutJsonl: string): string | null {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const line of stdoutJsonl.split("\n")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["session_id", "thread_id"]) {
        const v = obj[key];
        if (typeof v === "string" && UUID_RE.test(v)) return v;
      }
    } catch {
      /* 非 json 行跳过 */
    }
  }
  return null;
}

/** agy `--output-format json` 信封:{conversation_id, status, response, …}。
 * 整体 parse 失败(旧版本 agy / 输出被截)返回 null —— 调用方回退纯文本,
 * 分析主流程绝不因 session 捕获失败而失败(coach chat spec)。 */
export function parseAgyJsonEnvelope(stdout: string): {
  conversationId: string | null;
  status: string | null;
  response: string;
} | null {
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof obj.response !== "string") return null;
    return {
      conversationId:
        typeof obj.conversation_id === "string" ? obj.conversation_id : null,
      status: typeof obj.status === "string" ? obj.status : null,
      response: obj.response,
    };
  } catch {
    return null;
  }
}

// agy 只能经 argv 传 prompt(无 stdin/文件通道),.exe 直接 spawn(无
// cmd.exe 重新解析,见上方 assertNoWindowsCmdMetacharacters 大注释)时
// 沿用 Windows CreateProcess 命令行上限 32767 字符、留余量给 flags 与
// 模型全名 → 30K。
//
// .cmd/.bat 恒为 0(下方 winPromptLimit):曾经按 7000 字符
// (WIN_BATCH_PROMPT_LIMIT,agy flash 复核 #4 量出的 cmd.exe 命令行实测
// 上限档位)分档,7000 字符以内的 prompt 直接进 argv —— 这正是 2026-07-31
// 审计 Critical 的本地命令注入隐患本体,已改为恒落盘,不再按长度分档。
const WIN_ARGV_PROMPT_LIMIT = 30_000;

/** win32 上该文件能经 argv 安全携带的 prompt 上限;非 win → null(不限)。 */
function winPromptLimit(
  platform: NodeJS.Platform,
  file: string,
): number | null {
  if (platform !== "win32") return null;
  // .cmd/.bat 经 cmd.exe 重新解析 argv,恒 0 → 任何非空 prompt 都落盘,
  // argv 不再携带任何对局/模型可控文本。
  return /\.(cmd|bat)$/i.test(file) ? 0 : WIN_ARGV_PROMPT_LIMIT;
}

/** legacy .mjs 包装模式超限仍直接报错(dev-only 通路,不值得再造中转)。 */
function assertWinPromptFits(
  platform: NodeJS.Platform,
  file: string,
  prompt: string,
): void {
  const limit = winPromptLimit(platform, file);
  if (limit !== null && prompt.length > limit) {
    throw new Error(
      `agy 后端经命令行传入 prompt,本次 ${prompt.length} 字符超出 Windows 命令行上限(约 32K):请改用 Claude CLI 或 Anthropic API 后端`,
    );
  }
}

/**
 * agy 后端。默认直接 spawn `agy` 二进制(自动检测路径):
 * `agy --print <prompt> --model <全名> --print-timeout 110s --new-project --sandbox`
 * ——不依赖任何包装脚本,装了 agy 的机器开箱即用。
 *
 * `--new-project`:不带它 agy 会静默复用上一个 project 并把 cwd 重置到
 * 那个树的根;`--sandbox`:只读问答,不该有任何写权限。
 *
 * 兼容:命令路径手填 `.mjs` 结尾(或测试注入 script)→ 走旧的
 * `node agy-run.mjs ask` 包装模式,输出剥 `[agy-run]` 头行。
 */
export function agyClientFactory(opts?: {
  cmd?: string;
  node?: string;
  script?: string;
  run?: Runner;
  /** 测试注入;生产走 process.platform。 */
  platform?: NodeJS.Platform;
}): AnthropicLike {
  const run = opts?.run ?? defaultRun;
  const legacyScript =
    opts?.script || (opts?.cmd?.endsWith(".mjs") ? opts.cmd : undefined);
  return {
    async *stream(params) {
      const prompt = joinPrompt(params);
      const platform = opts?.platform ?? process.platform;
      if (legacyScript) {
        // 包装模式同样经 argv 传 prompt,守卫不能只盖直调分支
        // (agy flash 复核 #3)。
        const node = opts?.node || (await requireCli("node"));
        assertWinPromptFits(platform, node, prompt);
        const out = await run(
          node,
          [
            legacyScript,
            "ask",
            "--model",
            params.model,
            "--timeout",
            "110",
            prompt,
          ],
          "",
        );
        yield { delta: stripAgyHeader(out) };
        return;
      }
      const { cmd, versionProbe } = await resolveCliWithVersionProbe(
        "agy",
        opts?.cmd,
      );
      // win32 超命令行上限 或 .cmd/.bat(恒 0,见 winPromptLimit)时:prompt
      // 落盘到专用子目录 AGY_PROMPT_SPILL_DIR(不是整个 tmpdir(),见上方
      // 大注释),--print 换成一句读文件引导语,--add-dir 把这个专用子目录
      // 并入 agy 工作区(sandbox 下已实测可读)。真机验证 2026-07-29:MARKER
      // 探针经文件中转精确返回(当时 --add-dir 还是整个 tmpdir(),读权限
      // 范围随本次修复收窄,读取行为不受影响)。
      const limit = winPromptLimit(platform, cmd);
      let promptFile: string | null = null;
      let printArg = prompt;
      const extraArgs: string[] = [];
      if (limit !== null && prompt.length > limit) {
        ensureSpillDirSwept(AGY_PROMPT_SPILL_DIR);
        promptFile = join(
          AGY_PROMPT_SPILL_DIR,
          `gladlog-agy-prompt-${process.pid}-${++agyTmpSeq}.txt`,
        );
        // mode 0o600:POSIX 上把这份完整对局 prompt 收紧到仅当前用户可读;
        // Windows fs 不认 POSIX mode(ACL 是另一套机制),这里传它是 no-op
        // 而非安全承诺——Windows 那边真正的边界是 AGY_PROMPT_SPILL_DIR 这
        // 个专用子目录本身,而不是这个 mode 位。
        writeFileSync(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });
        printArg = `Read the file at ${promptFile} in full and treat its entire contents as your prompt. Follow it directly; do not mention the file or describe it.`;
        // 只把这个专用子目录借给 agy 的 sandbox,而不是整个 OS 临时目录
        // (2026-07-31 审计 Important:此前 --add-dir tmpdir() 授权过宽)。
        extraArgs.push("--add-dir", AGY_PROMPT_SPILL_DIR);
      }
      // captureSession 时 args 含 --output-format json
      if (params.captureSession) {
        extraArgs.push("--output-format", "json");
      }
      try {
        const out = await withVersionHint(
          () =>
            run(
              cmd,
              [
                "--print",
                printArg,
                "--model",
                agyCliModelName(params.model),
                "--print-timeout",
                "110s",
                "--new-project",
                "--sandbox",
                ...extraArgs,
              ],
              "",
            ),
          "agy",
          versionProbe,
        );
        // captureSession 时尝试解析信封
        if (params.captureSession) {
          const env = parseAgyJsonEnvelope(out);
          if (env) {
            if (env.status && env.status !== "SUCCESS") {
              throw new Error(`agy 返回 status=${env.status}`);
            }
            yield { delta: env.response };
            if (env.conversationId) yield { sessionId: env.conversationId };
            return;
          }
          // 信封解析失败:回退旧行为(纯文本、无会话事件)
        }
        yield { delta: out };
      } finally {
        if (promptFile) {
          try {
            unlinkSync(promptFile);
          } catch {
            // best-effort 清理
          }
        }
      }
    },
  };
}

export type CliChatBackend = "claudeCli" | "agy" | "codex";

/**
 * 教练续聊(coach chat 第二轮及以后):用播种阶段捕获的会话 id 续接同一个
 * CLI 会话,而不是重新起一次完整对局分析。三家 CLI 各自的续聊参数形态与
 * seed 路径不同(claude `--resume`、agy `--conversation` 且不带
 * `--new-project`、codex `exec resume <id> -`),但落盘中转/清理/版本提示
 * 等基础设施与 seed 路径同源复用(spill 目录、winPromptLimit、
 * withVersionHint),不重新发明一套。
 *
 * `opts.signal`(经 Runner 第 4 参透传给 defaultRun):调用方可中止飞行中的
 * 续聊请求(用户切走/取消提问)。
 */
export async function continueCliChat(input: {
  backend: CliChatBackend;
  cmd?: string;
  sessionId: string;
  question: string;
  model: string;
  signal?: AbortSignal;
  run?: Runner;
}): Promise<string> {
  const run = input.run ?? defaultRun;
  const opts = { signal: input.signal };
  if (input.backend === "claudeCli") {
    const { cmd, versionProbe } = await resolveCliWithVersionProbe(
      "claude",
      input.cmd,
    );
    return withVersionHint(
      () =>
        run(
          cmd,
          [
            "-p",
            "--output-format",
            "text",
            "--model",
            input.model,
            "--resume",
            input.sessionId,
          ],
          input.question,
          opts,
        ),
      "claude",
      versionProbe,
    );
  }
  if (input.backend === "agy") {
    const { cmd, versionProbe } = await resolveCliWithVersionProbe(
      "agy",
      input.cmd,
    );
    // 问题也可能超 win argv 上限:复用 spill(与播种同一套守卫)
    const platform = process.platform;
    const limit = winPromptLimit(platform, cmd);
    let promptFile: string | null = null;
    let printArg = input.question;
    const extraArgs: string[] = [];
    if (limit !== null && input.question.length > limit) {
      ensureSpillDirSwept(AGY_PROMPT_SPILL_DIR);
      promptFile = join(
        AGY_PROMPT_SPILL_DIR,
        `gladlog-agy-chat-${process.pid}-${++agyTmpSeq}.txt`,
      );
      writeFileSync(promptFile, input.question, {
        encoding: "utf-8",
        mode: 0o600,
      });
      printArg = `Read the file at ${promptFile} in full and treat its entire contents as your prompt. Follow it directly; do not mention the file or describe it.`;
      extraArgs.push("--add-dir", AGY_PROMPT_SPILL_DIR);
    }
    try {
      const out = await withVersionHint(
        () =>
          run(
            cmd,
            [
              "--print",
              printArg,
              "--model",
              agyCliModelName(input.model),
              "--print-timeout",
              "110s",
              "--conversation",
              input.sessionId,
              "--sandbox",
              ...extraArgs,
            ],
            "",
            opts,
          ),
        "agy",
        versionProbe,
      );
      return stripAgyHeader(out);
    } finally {
      if (promptFile) {
        try {
          unlinkSync(promptFile);
        } catch {
          /* best-effort */
        }
      }
    }
  }
  // codex
  const { cmd, versionProbe } = await resolveCliWithVersionProbe(
    "codex",
    input.cmd,
  );
  ensureSpillDirSwept(CODEX_OUT_SPILL_DIR);
  const outFile = join(
    CODEX_OUT_SPILL_DIR,
    `gladlog-codex-chat-${process.pid}-${++codexTmpSeq}.txt`,
  );
  try {
    const stdout = await withVersionHint(
      () =>
        run(
          cmd,
          [
            "exec",
            "resume",
            input.sessionId,
            "-",
            "-m",
            input.model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--color",
            "never",
            "-o",
            outFile,
          ],
          input.question,
          opts,
        ),
      "codex",
      versionProbe,
    );
    try {
      return readFileSync(outFile, "utf-8");
    } catch {
      return stdout; // 旧版本 codex 不认 -o:回退 stdout
    }
  } finally {
    try {
      unlinkSync(outFile);
    } catch {
      /* best-effort */
    }
  }
}
