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

/** 账本加载窗口(天)。比 feed 的 ~7 天留 3 天余量。 */
export const LEDGER_WINDOW_DAYS = 10;

export interface LedgerEntry {
  id: string;
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
    out.push(new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10));
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

/** 已归档 id 集合。**只算 uploaded 为真的** —— 下载成功但上传失败的必须能重来。 */
export function knownIdsFrom(entries: LedgerEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.uploaded).map((e) => e.id));
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
