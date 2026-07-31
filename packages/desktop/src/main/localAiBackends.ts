import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyCliModelName } from "../shared/aiModels";
import { detectLocalCliCached, type LocalCliTool } from "./cliDetect";
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

/**
 * A CLI runner: spawn `file` with `args` (NO shell — args are an array, so
 * match data in the prompt can never be interpreted by a shell), write `stdin`,
 * resolve stdout. Non-zero exit / spawn error / timeout reject.
 */
export type Runner = (
  file: string,
  args: string[],
  stdin: string,
) => Promise<string>;

// exported so tests can feed a mock child process directly (multi-byte UTF-8
// chunk-boundary regression test) without going through the Runner seam that
// every other test in this file uses to bypass defaultRun entirely.
export const defaultRun: Runner = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const isWinBatch =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const child = isWinBatch
      ? spawn("cmd.exe", ["/c", file, ...args], {
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    // Buffer 累积、结束时一次性 decode —— 逐块 `+= d.toString()` 会在多字节
    // UTF-8 字符(中文等)跨 chunk 边界被切开时各自解出 U+FFFD 乱码
    // (300 盘 agy 模拟真实撞见,生产 aiLanguage 默认 zh)。
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => outChunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.from(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
      const cmd = opts?.cmd || (await requireCli("claude"));
      const out = await run(
        cmd,
        ["-p", "--output-format", "text", "--model", params.model],
        joinPrompt(params),
      );
      yield { delta: out };
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
 */
export function codexClientFactory(opts?: {
  cmd?: string;
  run?: Runner;
}): AnthropicLike {
  const run = opts?.run ?? defaultRun;
  return {
    async *stream(params) {
      const cmd = opts?.cmd || (await requireCli("codex"));
      const outFile = join(
        tmpdir(),
        `gladlog-codex-${process.pid}-${++codexTmpSeq}.txt`,
      );
      let stdout: string;
      try {
        stdout = await run(
          cmd,
          [
            "exec",
            "-",
            "-m",
            params.model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "-o",
            outFile,
          ],
          joinPrompt(params),
        );
        let delta = stdout;
        try {
          delta = readFileSync(outFile, "utf-8");
        } catch {
          // -o 文件缺失(旧版本 codex 不认识该参数等)—— 回退用 stdout。
        }
        yield { delta };
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

// agy 只能经 argv 传 prompt(无 stdin/文件通道),Windows CreateProcess
// 命令行上限 32767 字符 —— 留余量给 flags 与模型全名。经 cmd.exe /c 跑
// .cmd/.bat 时上限更低(8191),按实际 spawn 的文件分档
// (agy flash 复核 #4)。超限走文件中转,不是报错(见 agyClientFactory)。
const WIN_ARGV_PROMPT_LIMIT = 30_000;
const WIN_BATCH_PROMPT_LIMIT = 7_000;

/** win32 上该文件能经 argv 安全携带的 prompt 上限;非 win → null(不限)。 */
function winPromptLimit(
  platform: NodeJS.Platform,
  file: string,
): number | null {
  if (platform !== "win32") return null;
  return /\.(cmd|bat)$/i.test(file)
    ? WIN_BATCH_PROMPT_LIMIT
    : WIN_ARGV_PROMPT_LIMIT;
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
      const cmd = opts?.cmd || (await requireCli("agy"));
      // win32 超命令行上限:prompt 落盘,--print 换成一句读文件引导语,
      // --add-dir 把临时目录并入 agy 工作区(sandbox 下已实测可读)。
      // 真机验证 2026-07-29:MARKER 探针经文件中转精确返回。
      const limit = winPromptLimit(platform, cmd);
      let promptFile: string | null = null;
      let printArg = prompt;
      const extraArgs: string[] = [];
      if (limit !== null && prompt.length > limit) {
        promptFile = join(
          tmpdir(),
          `gladlog-agy-prompt-${process.pid}-${++agyTmpSeq}.txt`,
        );
        writeFileSync(promptFile, prompt, "utf-8");
        printArg = `Read the file at ${promptFile} in full and treat its entire contents as your prompt. Follow it directly; do not mention the file or describe it.`;
        extraArgs.push("--add-dir", tmpdir());
      }
      try {
        const out = await run(
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
        );
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
