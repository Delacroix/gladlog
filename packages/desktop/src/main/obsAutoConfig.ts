import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** OBS (28+, with obs-websocket built in) stores its server configuration in a
 * fixed local JSON file: port, password, and whether it is enabled. Reading it
 * directly saves the user from copying the password out of OBS by hand (real-
 * machine feedback). Read-only, never write — OBS rewrites the whole file on
 * exit, so any external write gets silently clobbered. */
export interface ObsWsDetected {
  found: boolean;
  configPath?: string;
  enabled?: boolean;
  /**
   * Honest tri-state modeling (2026-07-31 audit #21 item5): `true`/`false` =
   * explicitly read from the config file; `"unknown"` = the field is missing
   * or not a boolean (schema drift across OBS versions, etc.), which must NOT
   * be treated as "password required" — the old `!== false` implementation
   * misread a missing field as "password required". For how the consumer
   * (the autoConfig handler in ipc.ts) treats unknown, see
   * resolveAutoConfigPassword / authUnknownHint.
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
      /* try the next candidate */
    }
  }
  return { found: false };
}

/**
 * The least-surprising choice in the unknown state: connect with whatever
 * password we read rather than forcing it empty. The basis is that
 * obs-websocket-js's identify() only hashes with this password when the
 * server's Hello actually carries an authentication challenge (see
 * `if (authentication && password)` in the obs-websocket-js dist sources under
 * node_modules) — so when auth is off, an extra password field is simply
 * ignored and cannot cause the perverse "auth wasn't even on, yet we can't
 * connect" outcome. Only when `auth_required === false` is read explicitly do
 * we definitively clear the password (there, sending one is pure surplus, and
 * omitting it is the honest "this genuinely needs no password").
 */
export function resolveAutoConfigPassword(d: ObsWsDetected): string | null {
  if (d.authRequired === false) return null;
  return d.password ?? null;
}

/**
 * When a connection fails in the unknown state, hand the user a plain-language
 * clue — we never managed to read the auth state, and a bare "connection
 * failed / auth error" easily makes people think the address is wrong. The
 * true/false states need no such hint (either a password is definitely
 * required and was sent, or it is definitely not needed).
 */
export function authUnknownHint(
  authRequired: ObsWsDetected["authRequired"],
  ok: boolean,
): string | undefined {
  return authRequired === "unknown" && !ok
    ? "OBS 鉴权状态未知(配置字段缺失或格式有变),可能需要密码;已尝试携带读到的密码连接"
    : undefined;
}
