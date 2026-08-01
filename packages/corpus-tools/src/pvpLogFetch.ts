import { CombatUnitSpec } from "@gladlog/parser-compat";

import type { DetailedMatchStub } from "./feedClient";

export type SpecRole = "recorder" | "any";

export const KNOWN_BRACKETS = ["2v2", "3v3", "Rated Solo Shuffle"] as const;
export type Bracket = (typeof KNOWN_BRACKETS)[number];

/**
 * BRACKET 校验:服务端只认这三档,拼错值(如 "Ratad Solo Shuffle")过去会
 * 静默查出空结果而非报错。比照既有 SPEC/SPEC_ROLE「拼错就报错、不做模糊
 * 纠正」的原则——同一类坑,同一类修法。
 */
export function isKnownBracket(value: string): value is Bracket {
  return (KNOWN_BRACKETS as readonly string[]).includes(value);
}

/**
 * 分页节流谓词:是否该在抓取这一页前先歇一下(见 fetchPvpLogs.ts 顶部
 * PAGE_SLEEP_MS 的礼貌性注释)。首页(page===0)不必空等——前面没有更早的
 * 请求需要错开,首次调用也不该白白拖慢启动。
 */
export function shouldSleepBeforePage(page: number): boolean {
  return page > 0;
}

/**
 * 下载节流谓词:是否该在下载这一场之前先歇一下。语义与 shouldSleepBeforePage
 * 同构(第一次不空等),但**额度独立** —— feed 查询打的是对方 Firestore 读,
 * 单场 log 下载打的是 GCS 出口带宽(单场可达 ~30MB),两者代价不同量级,
 * 必须分开计。见 fetchPvpLogs.ts 的 DOWNLOAD_SLEEP_MS 与
 * docs/DATA-COMPLIANCE.md 的「采集自律」。
 */
export function shouldSleepBeforeDownload(downloadsDone: number): boolean {
  return downloadsDone > 0;
}

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
  // 重建绝对时间只能靠这几个 header。字段各自可选:老上传客户端/CDN 剥离
  // header 时该字段缺失,缺失必须是"没这个键"而不是空字符串——空字符串
  // 对将来的绝对时间重建消费者是无信号的地雷(读的人分不清"确认为空"和
  // "没采到"),旧 manifest(字段都是 "" 的历史数据)仍按 string 兼容读取。
  gcsMeta?: {
    wowVersion?: string;
    clientTimezone?: string;
    clientYear?: string;
    startTimeUtc?: string;
  };
}

/**
 * GCS 返回头里可用来核验完整性的字节数:优先 x-goog-stored-content-length
 * (GCS 存储对象的原始大小,不受 transfer-encoding 影响),兜底 content-length。
 * 都拿不到(某些代理/测试 fetch 不回传)时返回 undefined——上层不做字节判据,
 * 不能把"没有 header"误判成"截断"。
 */
export function expectedByteLength(headers: {
  contentLength?: string;
  storedContentLength?: string;
}): number | undefined {
  const raw = headers.storedContentLength || headers.contentLength;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface GcsMetaHeaders {
  wowVersion: string;
  clientTimezone: string;
  clientYear: string;
  startTimeUtc: string;
}

export interface GcsMetaResult {
  meta: NonNullable<ManifestEntry["gcsMeta"]>;
  missingFields: string[];
}

/**
 * 把 4 个 `x-goog-meta-*` header 值(header 缺失时上游按约定传 ""）转成
 * manifest 要写的 gcsMeta 形状:确实拿到的字段照写,拿不到的字段**整个键都
 * 不写**(而不是写成 ""),让"缺失"与"确认为空字符串"在数据里可区分——将来
 * 绝对时间重建消费者才不会把静默的空串误判成"这台客户端就是没时区"。
 * 同时把缺失的字段名收集出来,供调用方打一行 warn(老上传客户端/CDN 剥离
 * header 都会触发,值得留痕但不是致命错误,不中断下载)。
 */
export function buildGcsMeta(headers: GcsMetaHeaders): GcsMetaResult {
  const meta: NonNullable<ManifestEntry["gcsMeta"]> = {};
  const missingFields: string[] = [];
  const entries: Array<[keyof GcsMetaHeaders, string]> = [
    ["wowVersion", headers.wowVersion],
    ["clientTimezone", headers.clientTimezone],
    ["clientYear", headers.clientYear],
    ["startTimeUtc", headers.startTimeUtc],
  ];
  for (const [key, value] of entries) {
    if (value === "") {
      missingFields.push(key);
    } else {
      meta[key] = value;
    }
  }
  return { meta, missingFields };
}

export interface CompletenessResult {
  ok: boolean;
  reason?: string;
}

/**
 * 下载完整性判据(与门规同一原则:锚在能验证的事实上,不能只查一个哨兵子串)。
 *
 * 1. ARENA_MATCH_START 必须在——起码是这个对局的日志。
 * 2. ARENA_MATCH_END 必须在——Solo Shuffle 6 轮共享同一个 log 对象,但 segmenter.ts
 *    实证:轮次切换只发新的 ARENA_MATCH_START,只有整场(6 轮全部打完)结束时才发
 *    唯一一次 ARENA_MATCH_END(IN_SHUFFLE 状态收到 END 才 flush shuffleCallback)。
 *    完整 SS payload 与普通对局同构地以 END 收尾,判据不必按 bracket 分支。
 * 3. 字节数核验(更硬的判据,防子串判据被"截断点恰好在两个哨兵之间"绕过):
 *    若拿到 GCS 侧的期望字节数,下载文本的 UTF-8 字节长度必须严格相等。
 *
 * HTTP 200 但连接中途断流(30MB log 常见)会在 (2) 或 (3) 被拦下,不写文件/不进
 * manifest/不进 dedup 集合——feed 只留 ~7 天,下次运行还能重试;一旦写进 dedup 集合
 * 就永久跳过,而 stub 过期后再也补不回来。
 */
export function checkPayloadCompleteness(
  text: string,
  expectedBytes: number | undefined,
): CompletenessResult {
  if (!text.includes("ARENA_MATCH_START")) {
    return { ok: false, reason: "missing ARENA_MATCH_START" };
  }
  if (!text.includes("ARENA_MATCH_END")) {
    return { ok: false, reason: "missing ARENA_MATCH_END" };
  }
  if (expectedBytes !== undefined) {
    const actual = Buffer.byteLength(text, "utf8");
    if (actual !== expectedBytes) {
      return {
        ok: false,
        reason: `byte length mismatch: expected ${expectedBytes}, got ${actual}`,
      };
    }
  }
  return { ok: true };
}

/**
 * manifest 按 id 去重写入(而非无条件 push):文件被手动删除但 manifest 行残留时,
 * 重下会产生同 id 的第二条记录。同 id 命中就地替换,否则追加。原地修改传入数组
 * (脚本沿用同一个 `manifest` 变量落盘),同时返回它方便链式/测试断言。
 */
export function upsertManifestEntry(
  manifest: ManifestEntry[],
  entry: ManifestEntry,
): ManifestEntry[] {
  const idx = manifest.findIndex((e) => e.id === entry.id);
  if (idx === -1) {
    manifest.push(entry);
  } else {
    manifest[idx] = entry;
  }
  return manifest;
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
