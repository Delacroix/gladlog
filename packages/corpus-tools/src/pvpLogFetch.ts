import { CombatUnitSpec } from "@gladlog/parser-compat";

import type { DetailedMatchStub } from "./feedClient";

export type SpecRole = "recorder" | "any";

const SPEC_NAME_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(CombatUnitSpec).filter(([k]) => k !== "None"),
);

/**
 * 解析 SPEC 参数:逗号分隔,每项为数字 specId("264")或 CombatUnitSpec 枚举名
 * ("Shaman_Restoration"),返回 specId 字符串数组。未知名字直接抛错并列出合法名,
 * 不做模糊猜测——拼错专精静默拉回全量 feed 比报错贵得多。
 */
export function parseSpecArg(arg: string): string[] {
  const out: string[] = [];
  for (const raw of arg.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (/^\d+$/.test(item)) {
      out.push(item);
      continue;
    }
    const id = SPEC_NAME_TO_ID[item];
    if (!id) {
      throw new Error(
        `unknown spec "${item}"; use a numeric specId or one of: ${Object.keys(SPEC_NAME_TO_ID).join(", ")}`,
      );
    }
    out.push(id);
  }
  return out;
}

/**
 * wowarenalogs 服务端 comp 索引编码:specId **字符串字典序**排序后 `_` 连接
 * (["263","1468"] → "1468_263",不是数值序)。子集也被预索引,所以 1–2 个 spec
 * 就能命中含该组合的任意队伍。2026-07-29 对 buildQueryHelpers 源码 + 真实请求实证。
 */
export function buildCompQueryString(specIds: string[]): string {
  return [...specIds].sort().join("_");
}

/**
 * 客户端 spec 细筛。服务端 compQueryString 只保证「某一队含这些 spec」;
 * recorder 语义(上传者本人是该专精,advanced logging 视角最优)必须在客户端
 * 用 playerId 对回 units 再判一次。
 */
export function matchesSpecFilter(
  stub: DetailedMatchStub,
  specIds: string[],
  role: SpecRole,
): boolean {
  if (specIds.length === 0) return true;
  const set = new Set(specIds);
  if (role === "recorder") {
    const recorder = stub.units.find((u) => u.id === stub.playerId);
    return !!recorder && set.has(recorder.spec);
  }
  return stub.units.some((u) => set.has(u.spec));
}

/**
 * Solo Shuffle 一场 6 轮各发一条 ShuffleRoundStub,但 logObjectUrl 指向整场共用的
 * 同一个 GCS 对象——按 logObjectUrl 去重,保留首见 stub,避免同一文件下 6 遍。
 */
export function dedupeByLogObject(
  stubs: DetailedMatchStub[],
): DetailedMatchStub[] {
  const seen = new Set<string>();
  const out: DetailedMatchStub[] = [];
  for (const s of stubs) {
    if (seen.has(s.logObjectUrl)) continue;
    seen.add(s.logObjectUrl);
    out.push(s);
  }
  return out;
}

export interface ManifestPlayer {
  name: string;
  spec: string;
  teamId: string;
  personalRating: number;
}

export interface ManifestEntry {
  id: string;
  typename: string;
  bracket: string;
  fileName: string;
  logObjectUrl: string;
  startTime: number;
  durationInSeconds: number;
  hasAdvancedLogging: boolean;
  playerTeamRating: number;
  playerTeamId: string;
  winningTeamId: string;
  result: number;
  team0MMR: number;
  team1MMR: number;
  recorder: ManifestPlayer | null;
  players: ManifestPlayer[];
  // GCS 对象 meta(下载时捕获)。log 文本时间戳无年份且为上传者本地时区,
  // 重建绝对时间只能靠这几个 header。
  gcsMeta?: {
    wowVersion: string;
    clientTimezone: string;
    clientYear: string;
    startTimeUtc: string;
  };
}

export function stubToManifestEntry(
  stub: DetailedMatchStub,
  fileName: string,
): ManifestEntry {
  const players: ManifestPlayer[] = stub.units
    .filter((u) => u.info != null)
    .map((u) => ({
      name: u.name,
      spec: u.spec,
      teamId: u.info!.teamId,
      personalRating: u.info!.personalRating,
    }));
  const rec = stub.units.find((u) => u.id === stub.playerId);
  const recorder: ManifestPlayer | null = rec
    ? {
        name: rec.name,
        spec: rec.spec,
        teamId: rec.info?.teamId ?? "",
        personalRating: rec.info?.personalRating ?? 0,
      }
    : null;
  return {
    id: stub.id,
    typename: stub.typename,
    bracket: stub.bracket,
    fileName,
    logObjectUrl: stub.logObjectUrl,
    startTime: stub.startTime,
    durationInSeconds: stub.durationInSeconds,
    hasAdvancedLogging: stub.hasAdvancedLogging,
    playerTeamRating: stub.playerTeamRating,
    playerTeamId: stub.playerTeamId,
    winningTeamId: stub.winningTeamId,
    result: stub.result,
    team0MMR: stub.team0MMR,
    team1MMR: stub.team1MMR,
    recorder,
    players,
  };
}
