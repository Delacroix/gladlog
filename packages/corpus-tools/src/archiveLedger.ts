/**
 * 归档账本:记录哪些场次已经**确认上传**到 Drive。
 *
 * 按天分片、只加载最近 LEDGER_WINDOW_DAYS 天:超过 feed 7 天窗口的比赛不可能
 * 再出现在扫描结果里,去重根本不需要查全部历史。这让内存里只有约 5.6 万条,
 * 而不是逐年累积的几百万条。
 *
 * 账本与上传到 Drive 的 index.jsonl 是同一份数据的两个视图 —— 账本是超集
 * (多一个 uploaded 状态),index 由 toIndexLine 导出。
 */

import type { GcsMeta } from "./pvpLogFetch";

/** 账本加载窗口(天)。比 feed 的 ~7 天留 3 天余量。 */
export const LEDGER_WINDOW_DAYS = 10;

/**
 * epoch ms → UTC 日期键 `YYYY-MM-DD`。**格式化只此一份**。
 *
 * 账本分片名(`recentDateKeys` → `ledgerShardPath`)与暂存/Drive 目录名
 * (`archivePlan.matchDateKey`)必须逐字一致 —— 两处各写一份 `toISOString().slice(0,10)`
 * 时,任何一边改了(本机时区、补零、分隔符)都会让「今天的分片」与「今天的暂存目录」
 * 对不上,去重直接失效:已归档的场次查不到账本条目 → 全部重下。
 * UTC 而非本机时区:归档要跨机器可复现。
 */
export function dateKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface LedgerEntry {
  id: string;
  /**
   * 该场对应的 GCS 日志对象 URL —— 去重的**第二把钥匙**。
   *
   * Solo Shuffle 一场 6 轮共享同一个 logObjectUrl 但 6 个 id 各不相同
   * (见 pvpLogFetch.ts 的 dedupeByLogObject)。只按 id 去重时:跨页边界会把
   * 同一对象下两遍、存成两个文件名;跨运行时 offset 位移导致「首见轮次」变了,
   * 该 id 不在账本 → 整场重下、Drive 上再多一份。`fetchPvpLogs.ts:114-116,151`
   * 早就用 have/haveLogs 双键去重,归档器必须搬齐这一半。
   */
  logObjectUrl: string;
  dateKey: string;
  bracket: string;
  startTime: number;
  playerTeamRating: number;
  team0MMR: number;
  team1MMR: number;
  playerTeamId: string;
  winningTeamId: string;
  durationInSeconds: number;
  /** 场上全员 specId。日志正文里有,但存一份省得为查专精解压整个文件。 */
  specs: string[];
  /** 已归档文件的压缩字节数。 */
  bytes: number;
  /**
   * 下载时捕获的 GCS 对象 meta(`x-goog-meta-*` 四个字段)。
   *
   * **必存**:日志正文的时间戳没有年份、且是上传者本地时区,重建绝对时间只能靠
   * 这几个 header(见 `docs/DATA-COMPLIANCE.md` §4)。而 GCS 对象约 30 天后就消失,
   * 归档时不存,以后再也拿不到 —— `fetchPvpLogs.ts` 早就存进 manifest 了,归档器
   * 拿的是同一个 `raw.header()`,必须一并存下。
   *
   * 可选:老账本行没有这个字段;字段各自也可选(老上传客户端/CDN 剥离 header 时
   * 缺失,`buildGcsMeta` 会把缺的键整个省掉而不是写成空串)。
   */
  gcsMeta?: GcsMeta;
  /** 只有确认上传成功才为 true —— 记早了就是永久丢一场。 */
  uploaded: boolean;
}

export function ledgerShardPath(ledgerRoot: string, dateKey: string): string {
  return `${ledgerRoot}/${dateKey}.jsonl`;
}

/** 最近 days 天的 dateKey,含今天,新到旧。 */
export function recentDateKeys(todayMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(dateKeyOf(todayMs - i * 86_400_000));
  }
  return out;
}

export function serializeEntry(e: LedgerEntry): string {
  return JSON.stringify(e);
}

/**
 * 解析一个分片。坏行跳过而不是抛错 —— 进程被 kill 时最后一行可能只写了一半,
 * 让一行残缺毁掉整天的去重信息,代价是那天全部重下。
 */
export function parseShard(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LedgerEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/**
 * 本轮扫描该跳过哪些场次,按 id 与 logObjectUrl **双键**返回。
 *
 * 收两类:
 * 1. `uploaded` 为真的 —— 已确认在 Drive 上。
 * 2. `stagedIds` 里的 —— 本地暂存目录里还躺着该场的 .txt.gz。这类的 uploaded
 *    仍是 false(上传失败才会留下),但字节已经在本地了,再下一遍纯属白花上游
 *    志愿者项目的流量 —— 而预冲刷注释里写明「不白白再花对方一次流量」正是此意,
 *    只认 uploaded:true 会让这条保护恰在最需要时(上传持续失败时)失效。
 *
 * 单纯「下载成功但上传失败且暂存已被清掉」的场次不在此列,必须允许重下。
 */
export function knownKeysFrom(
  entries: LedgerEntry[],
  stagedIds: ReadonlySet<string> = new Set(),
): { ids: Set<string>; logUrls: Set<string> } {
  const ids = new Set<string>();
  const logUrls = new Set<string>();
  for (const e of entries) {
    if (!e.uploaded && !stagedIds.has(e.id)) continue;
    ids.add(e.id);
    // 老账本行没有这个字段;空串进集合会把所有缺字段的 stub 一并判为已知。
    if (e.logObjectUrl) logUrls.add(e.logObjectUrl);
  }
  return { ids, logUrls };
}

/** 已归档 id 集合。**只算 uploaded 为真的** —— 下载成功但上传失败的必须能重来。 */
export function knownIdsFrom(entries: LedgerEntry[]): Set<string> {
  // 谓词单源:与 knownKeysFrom 共用同一条判据,别再写第二遍 filter。
  return knownKeysFrom(entries).ids;
}

/**
 * 同一 id 只保留最后一条(保持首次出现的顺序)。
 *
 * 分片是 append-only:同一场先写一条 uploaded:false(用于崩溃后认出遗留暂存),
 * 上传确认后再写一条 uploaded:true。不折叠的话 index 会出现重复行。
 */
export function latestById(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  const order: string[] = [];
  for (const e of entries) {
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  return order.map((id) => byId.get(id)!);
}

/** 导出给 Drive 的 index 行:去掉本地状态字段。 */
export function toIndexLine(e: LedgerEntry): string {
  const { uploaded: _uploaded, ...rest } = e;
  return JSON.stringify(rest);
}

/**
 * 把本地这一批并进**云端已有的** index.jsonl,而不是用本地视图覆盖它。
 *
 * 本地账本只保留最近 10 天,且换机/丢账本/改 ARCHIVE_ROOT 后就是空的。若只按
 * 本地重建后 copy 覆盖,任何被重新触碰的日期,其云端 index 会被截断成只剩新批次 ——
 * .txt.gz 本身还在(上传用 copy 不用 sync),但从索引里消失,等同于查不到。
 *
 * 云端行原样保留(不重新序列化,避免字段版本差异导致的无谓改写),同 id 以本地为准。
 */
export function mergeIndexLines(
  remoteText: string,
  local: LedgerEntry[],
): string {
  const byId = new Map<string, string>();
  for (const line of remoteText.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as { id?: unknown };
      if (typeof o?.id === "string") byId.set(o.id, s);
    } catch {
      // 坏行跳过:与 parseShard 同样的理由,一行残缺不该毁掉整天的索引
    }
  }
  for (const e of local) byId.set(e.id, toIndexLine(e));
  if (byId.size === 0) return "";
  return [...byId.values()].join("\n") + "\n";
}
