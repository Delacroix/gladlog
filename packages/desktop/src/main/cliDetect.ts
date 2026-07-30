import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import { BACKEND_CLI_TOOL, type AiBackend } from "../shared/aiModels";

const execFileP = promisify(execFile);

/** 可检测的本地 CLI;node 仅供 agy 的 .mjs 兼容模式(手填包装脚本
 *  路径时)解析解释器,不对应任何后端。后端 → 工具名的映射在
 *  shared/aiModels.ts 的 BACKEND_CLI_TOOL(renderer 文案共用)。 */
export type LocalCliTool = "claude" | "agy" | "codex" | "node";

export interface CliDetectDeps {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  /** PATH 查找(mac 走 login shell,win 走 where);测试注入。 */
  pathLookup?: (tool: string) => Promise<string | null>;
}

/**
 * PATH 之外的常见安装位置兜底。打包后的 GUI 应用(尤其 mac 从 Dock 启动、
 * win 从资源管理器启动)不一定继承用户 shell 的 PATH,所以 PATH 查不到
 * 不等于没装 —— 按各工具的主流装法逐个探测。
 */
export function wellKnownCliCandidates(
  tool: LocalCliTool,
  opts: {
    platform: NodeJS.Platform;
    home: string;
    env: Record<string, string | undefined>;
  },
): string[] {
  // 按目标平台选分隔符(不能用宿主平台的 join:单测在 mac 上拼 win 路径)
  const j = opts.platform === "win32" ? win32.join : posix.join;
  if (opts.platform === "win32") {
    return [
      // claude/agy 原生安装器与 npm 全局两种装法
      j(opts.home, ".local", "bin", `${tool}.exe`),
      ...(opts.env.APPDATA ? [j(opts.env.APPDATA, "npm", `${tool}.cmd`)] : []),
    ];
  }
  return [
    j(opts.home, ".local", "bin", tool),
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
  ];
}

/**
 * 从 PATH 查找命令的 stdout 里挑出真正的可执行路径。login shell 的
 * .zprofile/.zshrc 可能往 stdout 吐横幅/nvm 加载提示(agy flash 复核 #2),
 * 裸 trim 会把「Welcome!\n/opt/homebrew/bin/claude」整串当路径 → ENOENT。
 * 判据:绝对路径 + basename 以工具名开头(claude/claude.exe/claude.cmd)+
 * 文件确实存在。
 */
export function pickCliPathFromLookupOutput(
  stdout: string,
  tool: string,
  opts: { platform: NodeJS.Platform; exists: (p: string) => boolean },
): string | null {
  const isWin = opts.platform === "win32";
  const isAbs = isWin ? /^[A-Za-z]:[\\/]/ : /^\//;
  const base = isWin ? win32.basename : posix.basename;
  return (
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          isAbs.test(l) &&
          base(l).toLowerCase().startsWith(tool.toLowerCase()) &&
          opts.exists(l),
      ) ?? null
  );
}

function defaultPathLookup(
  tool: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): Promise<string | null> {
  const pick = (stdout: string) =>
    pickCliPathFromLookupOutput(stdout, tool, { platform, exists });
  if (platform === "win32") {
    // Windows 无登录 shell 概念,用 where 找绝对路径(npm 全局装的是
    // claude.cmd,裸名 spawn 会 ENOENT)。
    return execFileP("where", [tool])
      .then((r) => pick(r.stdout))
      .catch(() => null);
  }
  // 打包后的 mac GUI 应用不继承 shell PATH,借用户 login shell 解析。
  const shell = env.SHELL || "/bin/zsh";
  return execFileP(shell, ["-lc", `command -v ${tool}`])
    .then((r) => pick(r.stdout))
    .catch(() => null);
}

/**
 * 自动检测本地 CLI 的绝对路径:PATH 优先,常见安装目录兜底,都没有 → null。
 * 由调用方决定 null 的语义(后端抛明确错误 / 设置页显示「未检测到」)。
 */
export async function detectLocalCli(
  tool: LocalCliTool,
  deps?: CliDetectDeps,
): Promise<string | null> {
  const platform = deps?.platform ?? process.platform;
  const home = deps?.home ?? homedir();
  const env = deps?.env ?? process.env;
  const exists = deps?.exists ?? existsSync;
  const lookup =
    deps?.pathLookup ??
    ((t: string) => defaultPathLookup(t, platform, env, exists));

  const fromPath = await lookup(tool);
  if (fromPath) return fromPath;
  for (const c of wellKnownCliCandidates(tool, { platform, home, env })) {
    if (exists(c)) return c;
  }
  return null;
}

// 分析热路径的缓存:同一次进程内不反复起 shell。设置页的检测 IPC 走
// fresh(不读不写缓存)—— 用户刚装完 CLI 回到设置页应立即看到变化。
const detected = new Map<LocalCliTool, Promise<string | null>>();
export function detectLocalCliCached(
  tool: LocalCliTool,
): Promise<string | null> {
  let p = detected.get(tool);
  if (!p) {
    p = detectLocalCli(tool).then((r) => {
      // 失败不缓存(agy flash 复核 #6):用户装好 CLI 后下一次分析直接
      // 可用,不必先绕道设置页/重启;代价只是缺装期间每次多一个 shell 查找。
      if (r === null) detected.delete(tool);
      return r;
    });
    detected.set(tool, p);
  }
  return p;
}

/** 设置页 IPC:按后端检测,总是 fresh。非本地后端 → null。 */
export async function detectCliForBackend(
  backend: string,
): Promise<{ path: string | null }> {
  const tool = BACKEND_CLI_TOOL[backend as AiBackend];
  if (!tool) return { path: null };
  const path = await detectLocalCli(tool);
  // 检测成功顺手刷新缓存:设置页看到的与后续分析实际用的保持一致。
  // 失败同样不缓存(与 detectLocalCliCached 的语义一致)。
  if (path) detected.set(tool, Promise.resolve(path));
  else detected.delete(tool);
  return { path };
}
