import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** OBS(28+ 内置 obs-websocket)把服务器配置存在本机固定 JSON:
 * 端口/密码/是否启用。直接读它,用户就不用去 OBS 里抄密码(真机反馈)。
 * 只读不写 —— OBS 退出时会回写整个文件,外部写入会被静默clobber。 */
export interface ObsWsDetected {
  found: boolean;
  configPath?: string;
  enabled?: boolean;
  /**
   * 三态诚实建模(2026-07-31 审计 #21 item5):`true`/`false` = 配置文件
   * 里显式读到;`"unknown"` = 字段缺失或不是布尔值(OBS 版本升级 schema
   * 漂移等),不当作"需要密码"处理——旧实现 `!== false` 会把缺失字段
   * 误判成"需要密码"。消费端(ipc.ts 的 autoConfig handler)对 unknown
   * 的处理见 resolveAutoConfigPassword/authUnknownHint。
   */
  authRequired?: boolean | "unknown";
  port?: number;
  password?: string | null;
}

export function obsWebsocketConfigCandidates(opts?: {
  platform?: NodeJS.Platform;
  appData?: string | undefined;
  home?: string;
}): string[] {
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? homedir();
  const rel = join(
    "obs-studio",
    "plugin_config",
    "obs-websocket",
    "config.json",
  );
  if (platform === "win32") {
    const appData = opts ? opts.appData : (process.env["APPDATA"] ?? undefined);
    return appData ? [join(appData, rel)] : [];
  }
  if (platform === "darwin")
    return [join(home, "Library", "Application Support", rel)];
  return [join(home, ".config", rel)];
}

export function detectObsWebsocket(
  candidates: string[] = obsWebsocketConfigCandidates(),
  read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): ObsWsDetected {
  for (const p of candidates) {
    try {
      const raw = JSON.parse(read(p)) as {
        server_enabled?: boolean;
        auth_required?: boolean;
        server_port?: number;
        server_password?: string;
      };
      const authRequired: boolean | "unknown" =
        raw.auth_required === true
          ? true
          : raw.auth_required === false
            ? false
            : "unknown";
      return {
        found: true,
        configPath: p,
        enabled: raw.server_enabled === true,
        authRequired,
        port: typeof raw.server_port === "number" ? raw.server_port : 4455,
        password: raw.server_password ?? null,
      };
    } catch {
      /* 下一个候选 */
    }
  }
  return { found: false };
}

/**
 * unknown 态时"least-surprising"选择:带着已读到的密码去连,而不是强行
 * 留空。依据是 obs-websocket-js 的 identify() 只有服务端 Hello 真正带
 * authentication challenge 时才会用这个密码算 hash(见
 * node_modules/obs-websocket-js dist 源码 `if (authentication && password)`)
 * ——鉴权没开时,多带一个密码字段会被直接忽略,不会造成"其实没开鉴权却
 * 连不上"的反效果。只有显式读到 `auth_required === false` 时才确定清空
 * 密码(此时带密码纯属多余,不带才是诚实的"这就是不需要密码")。
 */
export function resolveAutoConfigPassword(d: ObsWsDetected): string | null {
  if (d.authRequired === false) return null;
  return d.password ?? null;
}

/**
 * unknown 态下连接失败时,给用户补一句人话线索——鉴权状态本来就没读明白,
 * 裸报连接失败/认证错误容易让人误以为地址错了。true/false 态无需这句
 * (要么明确需要密码且已带上,要么明确不需要)。
 */
export function authUnknownHint(
  authRequired: ObsWsDetected["authRequired"],
  ok: boolean,
): string | undefined {
  return authRequired === "unknown" && !ok
    ? "OBS 鉴权状态未知(配置字段缺失或格式有变),可能需要密码;已尝试携带读到的密码连接"
    : undefined;
}
