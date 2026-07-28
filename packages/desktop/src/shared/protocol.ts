import type { GladMatch, GladShuffle } from "@gladlog/parser";

export interface FileCheckpoint {
  offset: number; // 已消费完整行尾的字节偏移(安全边界)
  firstLineChecksum: string | null; // 文件首行 sha1 hex;空文件为 null
}

export interface WorkerConfig {
  logsDir: string;
  checkpointsPath: string; // checkpoint registry JSON 的绝对路径
  quarantined: string[]; // 跳过的 fileKey(basename)
  flushIntervalMs: number; // 默认 2000
  quietPeriodMs: number; // 默认 5000
}

export type MainToWorker = { type: "configure"; config: WorkerConfig };

export interface FileStatus {
  fileKey: string;
  offset: number;
  size: number;
  quarantined: boolean;
}

export type WorkerToMain =
  | { type: "match"; fileKey: string; payload: GladMatch }
  | { type: "shuffle"; fileKey: string; payload: GladShuffle }
  | { type: "diagnostic"; fileKey?: string; code: string; detail?: string }
  // 对局生命周期(OBS 录像触发;shuffle 整 lobby 一对 open/close)
  | {
      type: "segmentOpen";
      fileKey: string;
      bracket: string;
      zoneId: string;
      isRated: boolean;
      startTime: number; // 开场行 epoch ms
    }
  | {
      type: "segmentClose";
      fileKey: string;
      endTime: number | null; // 异常闭合(轮转/end)为 null
      aborted: boolean;
    }
  | {
      type: "status";
      watching: boolean;
      logsDir: string;
      files: FileStatus[];
      current?: { fileKey: string; offset: number }; // 正在处理的位置(崩溃归因用)
    };

/** 设置回读时 API key 的掩码值(renderer 与 main 共享的协议常量;
 * renderer 绝不可值引入 main 模块 —— v0.0.4 构建实锤:会把 fs 卷进浏览器包)。 */
export const API_KEY_REDACTED = "__gladlog_api_key_set__";

/** OBS websocket 密码的回读哨兵(同 API_KEY_REDACTED 模式)。 */
export const OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__";
/** OBS 28+ websocket 默认地址(renderer 占位与 main 连接共用,单源)。 */
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455";
