import type { GladMatch, GladShuffle } from "@gladlog/parser";

export interface FileCheckpoint {
  offset: number; // byte offset past the last fully consumed line (safe boundary)
  firstLineChecksum: string | null; // sha1 hex of the file's first line; null for an empty file
}

export interface WorkerConfig {
  logsDir: string;
  checkpointsPath: string; // absolute path of the checkpoint registry JSON
  quarantined: string[]; // skipped fileKeys (basename)
  flushIntervalMs: number; // default 2000
  quietPeriodMs: number; // default 5000
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
  // Match lifecycle (drives OBS recording; a shuffle lobby gets one open/close
  // pair for the whole lobby)
  | {
      type: "segmentOpen";
      fileKey: string;
      bracket: string;
      zoneId: string;
      isRated: boolean;
      startTime: number; // epoch ms of the opening line
    }
  | {
      type: "segmentClose";
      fileKey: string;
      endTime: number | null; // null on an abnormal close (log rotation / end)
      aborted: boolean;
    }
  | {
      type: "status";
      watching: boolean;
      logsDir: string;
      files: FileStatus[];
      current?: { fileKey: string; offset: number }; // position being processed (for crash attribution)
    };

/** Masked value returned when settings are read back (a protocol constant shared
 * by renderer and main; the renderer must never value-import a main module --
 * proven by the v0.0.4 build: it drags fs into the browser bundle). */
export const API_KEY_REDACTED = "__gladlog_api_key_set__";

/** Read-back sentinel for the OBS websocket password (same pattern as
 * API_KEY_REDACTED). */
export const OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__";
/** Read-back sentinel for the DeepSeek API key (same pattern as
 * API_KEY_REDACTED). */
export const DEEPSEEK_KEY_REDACTED = "__gladlog_deepseek_key_set__";
/** Default OBS 28+ websocket address (single-source, shared by the renderer
 * placeholder and the main-process connection). */
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455";
