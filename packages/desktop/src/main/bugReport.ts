import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { listAiDebug, type AiDebugEntry } from "./aiDebugLog";

/**
 * 应用内报告 bug(2026-08-02 用户需求):打包三样 —— 该场原始 log
 * (raw.txt)、AI 调用的 prompt/原始返回(aiDebugLog 环形日志,内存中最近
 * 10 次)、用户 comment。落点优先 ~/gladlog-sync/bugreports:那是 Drive
 * 同步盘(跨机日志中继同款通道),写入即自动上传;没有同步盘退
 * userData/bugreports 本地留档。刻意不包含 settings(API key 风险,
 * 脱敏成本 > 价值);PII(玩家名)原样存,口径同 docs/DATA-COMPLIANCE.md。
 */

export interface BugReportInput {
  matchId: string | null;
  /** shuffle 轮号(1 起);普通对局 null。 */
  roundSeq: number | null;
  comment: string;
}

export interface BugReportResult {
  dir: string;
  /** true = 写进了 Drive 同步盘,会自动上传。 */
  synced: boolean;
}

export function resolveBugReportRoot(deps: {
  homeDir: string;
  userDataDir: string;
}): { root: string; synced: boolean } {
  const syncRoot = join(deps.homeDir, "gladlog-sync");
  if (existsSync(syncRoot)) {
    return { root: join(syncRoot, "bugreports"), synced: true };
  }
  return { root: join(deps.userDataDir, "bugreports"), synced: false };
}

export function createBugReport(deps: {
  input: BugReportInput;
  /** userData/matches 根(raw.txt 与 meta 所在)。 */
  matchesDir: string;
  getMeta: (id: string) => unknown | null;
  appVersion: string;
  platform: string;
  homeDir: string;
  userDataDir: string;
  aiEntries?: AiDebugEntry[];
  now?: () => number;
}): BugReportResult {
  const now = deps.now ? deps.now() : Date.now();
  const { root, synced } = resolveBugReportRoot(deps);

  const d = new Date(now);
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
  const time = [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
  const idPart = deps.input.matchId
    ? deps.input.matchId.slice(0, 8)
    : "no-match";
  const dir = join(root, `${stamp}-${time}-${idPart}`);
  mkdirSync(dir, { recursive: true });

  // AI 证据:该场相关的调用优先;没有 matchId 就全量(最多 10 条,内存环)
  const all = deps.aiEntries ?? listAiDebug();
  const aiCalls = deps.input.matchId
    ? all.filter((e) => e.matchId === deps.input.matchId)
    : all;

  const meta = deps.input.matchId ? deps.getMeta(deps.input.matchId) : null;

  writeFileSync(
    join(dir, "report.json"),
    JSON.stringify(
      {
        createdAt: new Date(now).toISOString(),
        appVersion: deps.appVersion,
        platform: deps.platform,
        comment: deps.input.comment,
        matchId: deps.input.matchId,
        roundSeq: deps.input.roundSeq,
        matchMeta: meta,
        aiCalls,
      },
      null,
      2,
    ),
  );

  if (deps.input.matchId) {
    const raw = join(deps.matchesDir, deps.input.matchId, "raw.txt");
    if (existsSync(raw)) {
      try {
        copyFileSync(raw, join(dir, "match-raw.txt"));
      } catch {
        /* raw 拷不动(权限/被占用)不拦整个报告 */
      }
    }
  }

  return { dir, synced };
}
