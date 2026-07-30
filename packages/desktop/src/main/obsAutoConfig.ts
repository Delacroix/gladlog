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
  authRequired?: boolean;
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
      return {
        found: true,
        configPath: p,
        enabled: raw.server_enabled === true,
        authRequired: raw.auth_required !== false,
        port: typeof raw.server_port === "number" ? raw.server_port : 4455,
        password: raw.server_password ?? null,
      };
    } catch {
      /* 下一个候选 */
    }
  }
  return { found: false };
}
