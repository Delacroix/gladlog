import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  promises as fsp,
} from "fs";
import { join } from "path";
import { slimMatchParams } from "@gladlog/parser";
import { Worker } from "worker_threads";
import type { GladMatch, GladShuffle } from "@gladlog/parser";

interface CacheEntry {
  id: string;
  data: unknown;
}

/** 存档 doc 形态的瘦身入口:match 直瘦,shuffle 逐轮瘦。返回是否有实际改动。 */
function slimStoredDoc(doc: unknown): boolean {
  const data = (doc as { data?: { rounds?: unknown[]; units?: unknown } })
    ?.data;
  if (!data) return false;
  let changed = false;
  if (Array.isArray(data.rounds)) {
    for (const r of data.rounds)
      if ((r as { units?: unknown }).units)
        changed =
          slimMatchParams(r as Parameters<typeof slimMatchParams>[0]) ||
          changed;
  } else if (data.units) {
    changed = slimMatchParams(data as Parameters<typeof slimMatchParams>[0]);
  }
  return changed;
}

class MatchLruCache {
  private entries: CacheEntry[] = [];

  get(id: string): unknown | undefined {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    const entry = this.entries[idx]!;
    this.entries.splice(idx, 1);
    this.entries.unshift(entry);
    return entry.data;
  }

  set(id: string, data: unknown): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.entries.splice(idx, 1);
    }
    this.entries.unshift({ id, data });
    if (this.entries.length > 2) {
      this.entries.pop();
    }
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * 流式取第 n 行(0-based,行界=\n,与 `content.split("\n")[n]` 逐字节等价,
 * 含 CRLF 文件行尾 \r 原样保留)。旧实现整读 raw.txt 再 split —— 为取一行
 * 付「中位 12MB / max 74MB 读入 + 全文件切分」的主线程冻结与瞬时垃圾
 * (2026-07-26 审计);这里按 1MB 块扫 \n(UTF-8 里 \n 单字节,跨块安全),
 * 命中即早停。行号越界返回 null(等价 split 的 undefined)。
 */
export async function readNthLine(
  filePath: string,
  n: number,
): Promise<string | null> {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let newlines = 0;
    let collecting = n === 0;
    const parts: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break; // EOF:collecting 中=文件末行无 \n
      const view = buf.subarray(0, bytesRead);
      let pos = 0;
      while (pos <= view.length) {
        const nl = view.indexOf(0x0a, pos);
        if (collecting) {
          const end = nl === -1 ? view.length : nl;
          parts.push(Buffer.from(view.subarray(pos, end)));
          if (nl !== -1) return Buffer.concat(parts).toString("utf-8");
          break; // 行未完,续读下一块
        }
        if (nl === -1) break; // 本块无更多行首
        newlines++;
        pos = nl + 1;
        if (newlines === n) collecting = true;
      }
    }
    return collecting ? Buffer.concat(parts).toString("utf-8") : null;
  } finally {
    await fh.close();
  }
}

function parseMatchFileInWorker(filePath: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const code = `
      const { parentPort, workerData } = require('worker_threads');
      const { readFileSync } = require('fs');
      try {
        const content = readFileSync(workerData.filePath, 'utf8');
        const parsed = JSON.parse(content);
        parentPort.postMessage({ success: true, data: parsed });
      } catch (err) {
        parentPort.postMessage({ success: false, error: err.message });
      }
    `;
    const worker = new Worker(code, {
      eval: true,
      workerData: { filePath },
    });
    worker.on("message", (msg) => {
      if (msg.success) {
        resolve(msg.data);
      } else {
        resolve(null);
      }
      worker.terminate();
    });
    worker.on("error", () => {
      resolve(null);
      worker.terminate();
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        resolve(null);
      }
    });
  });
}

export interface StoredMatchMeta {
  id: string;
  kind: "match" | "shuffle";
  bracket: string;
  zoneId: string;
  startTime: number;
  endTime: number;
  result: string;
  storedAt: number;
  // ── 富行字段(2026-07-17 backlog #7)——全部 optional,旧索引行缺字段时
  //    列表回退纯文本样式;旧数据可用 rebuildIndex() 一次性回填。──
  durationS?: number;
  /** 己方队平均个人评分;无评分数据时 null。 */
  avgRating?: number | null;
  /** [己方, 敌方] 两组专精(只存渲染需要的 id,不存名字)。 */
  teams?: Array<Array<{ specId: number; classId: number }>>;
  /** 记录者角色名(多角色战绩区分;旧行缺字段 → 重建索引回填)。 */
  playerName?: string;
  /** 记录者本人个人评分(评分曲线用;队均 avgRating 保留兜底)。 */
  playerRating?: number | null;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

interface RosterUnitLike {
  kind?: string;
  name?: string;
  specId?: number;
  classId?: number;
  info?: { teamId?: number; personalRating?: number } | null;
}

/** 从对局 doc 提炼富行字段(store 时全量 doc 在手,零额外 IO)。 */
function metaExtras(src: {
  startTime: number;
  endTime: number;
  playerTeamId?: number;
  playerId?: string;
  units?: Record<string, RosterUnitLike>;
}): Pick<
  StoredMatchMeta,
  "durationS" | "avgRating" | "teams" | "playerName" | "playerRating"
> {
  const durationS = Math.max(
    0,
    Math.round((src.endTime - src.startTime) / 1000),
  );
  const own: Array<{ specId: number; classId: number }> = [];
  const foe: Array<{ specId: number; classId: number }> = [];
  const ratings: number[] = [];
  for (const u of Object.values(src.units ?? {})) {
    if (u.kind !== "Player" || !u.info) continue;
    const entry = { specId: u.specId ?? 0, classId: u.classId ?? 0 };
    if (u.info.teamId === src.playerTeamId) {
      own.push(entry);
      if (
        typeof u.info.personalRating === "number" &&
        u.info.personalRating > 0
      )
        ratings.push(u.info.personalRating);
    } else {
      foe.push(entry);
    }
  }
  const avgRating = ratings.length
    ? Math.round(ratings.reduce((s, r) => s + r, 0) / ratings.length)
    : null;
  // 记录者本人:角色名(多角色区分)+ 个人评分(曲线不再吃队均)
  const recorder = src.playerId ? src.units?.[src.playerId] : undefined;
  const playerName = recorder?.name;
  const playerRating =
    typeof recorder?.info?.personalRating === "number" &&
    recorder.info.personalRating > 0
      ? recorder.info.personalRating
      : null;
  return { durationS, avgRating, teams: [own, foe], playerName, playerRating };
}

export class MatchStore {
  private index = new Map<string, StoredMatchMeta>();
  private now: () => number;
  private lru = new MatchLruCache();

  constructor(
    private rootDir: string,
    opts?: { now?: () => number },
  ) {
    this.now = opts?.now ?? Date.now;
    mkdirSync(rootDir, { recursive: true });
  }

  private indexPath = () => join(this.rootDir, "_index.ndjson");

  private appendIndexLine(meta: StoredMatchMeta): void {
    appendFileSync(this.indexPath(), JSON.stringify(meta) + "\n");
  }

  private rewriteIndex(): void {
    const tmp = this.indexPath() + ".tmp";
    writeFileSync(
      tmp,
      [...this.index.values()].map((m) => JSON.stringify(m)).join("\n") +
        (this.index.size ? "\n" : ""),
    );
    renameSync(tmp, this.indexPath());
  }

  init(): StoredMatchMeta[] {
    this.index.clear();
    this.lru.clear();
    // 1) Fast path: one read of the append-only index (dedup by id, last wins).
    try {
      const raw = readFileSync(this.indexPath(), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const meta = JSON.parse(line) as StoredMatchMeta;
          if (typeof meta.id === "string") this.index.set(meta.id, meta);
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch {
      /* 无索引文件 → 下面迁移 */
    }
    // 2) Reconcile with the per-dir source of truth (cheap: dir NAMES only).
    //    Use Sets so reconciliation is O(N), not O(N^2).
    let names: string[] = [];
    try {
      names = readdirSync(this.rootDir);
    } catch {
      /* 空 */
    }
    const nameSet = new Set(
      names.filter((n) => !n.startsWith(".") && !n.startsWith("_")),
    );
    const indexedDirs = new Set(
      [...this.index.values()].map((m) => safeName(m.id)),
    );
    let repaired = false;
    // Recover dirs present on disk but missing from the index (crash between
    // dir write and index append).
    for (const name of nameSet) {
      if (indexedDirs.has(name)) continue;
      try {
        const meta = JSON.parse(
          readFileSync(join(this.rootDir, name, "meta.json"), "utf-8"),
        ) as StoredMatchMeta;
        if (typeof meta.id === "string") {
          this.index.set(meta.id, meta);
          this.appendIndexLine(meta);
          repaired = true;
        }
      } catch {
        /* 损坏目录 → 跳过 */
      }
    }
    // Drop index entries whose dir is gone.
    for (const [id] of [...this.index]) {
      if (!nameSet.has(safeName(id))) {
        this.index.delete(id);
        repaired = true;
      }
    }
    // No index file at all → write one (migration); or repair.
    if (!existsSync(this.indexPath()) || repaired) this.rewriteIndex();
    return this.list();
  }

  store(item: GladMatch | GladShuffle): {
    stored: boolean;
    meta: StoredMatchMeta | null;
  } {
    let id: string;
    let meta: StoredMatchMeta;
    let data: unknown;
    if (item.kind === "shuffle") {
      const first = item.rounds[0];
      if (!first) return { stored: false, meta: null };
      id = first.id;
      meta = {
        id,
        kind: "shuffle",
        bracket: first.bracket,
        zoneId: first.zoneId,
        startTime: item.startTime,
        endTime: item.endTime,
        result: String(item.result),
        storedAt: this.now(),
        // 阵容取首回合(shuffle 每回合换边,首回合即入场名单);时长取全程。
        ...metaExtras(first as unknown as Parameters<typeof metaExtras>[0]),
        durationS: Math.max(
          0,
          Math.round((item.endTime - item.startTime) / 1000),
        ),
      };
      data = {
        ...item,
        rawLines: undefined,
        rounds: item.rounds.map((r) => ({ ...r, rawLines: undefined })),
      };
    } else {
      id = item.id;
      meta = {
        id,
        kind: "match",
        bracket: item.bracket,
        zoneId: item.zoneId,
        startTime: item.startTime,
        endTime: item.endTime,
        result: String(item.result),
        storedAt: this.now(),
        ...metaExtras(item as unknown as Parameters<typeof metaExtras>[0]),
      };
      data = { ...item, rawLines: undefined };
    }
    if (this.index.has(id)) {
      // Already indexed — dedup, UNLESS the on-disk meta.json is missing or
      // corrupt: then fall through and re-write to self-heal the files.
      let intact = false;
      try {
        JSON.parse(
          readFileSync(join(this.rootDir, safeName(id), "meta.json"), "utf-8"),
        );
        intact = true;
      } catch {
        /* missing or corrupt → recover */
      }
      if (intact) return { stored: false, meta: this.index.get(id)! };
    }

    const dirName = safeName(id);
    const finalDir = join(this.rootDir, dirName);
    const tmpDir = join(this.rootDir, `.tmp-${dirName}`);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "meta.json"), JSON.stringify(meta, null, 2));
    writeFileSync(
      join(tmpDir, "match.json"),
      JSON.stringify({
        schemaVersion: 1,
        storedAt: meta.storedAt,
        kind: meta.kind,
        data,
      }),
    );
    writeFileSync(join(tmpDir, "raw.txt"), item.rawLines.join("\n") + "\n");
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(tmpDir, finalDir);
    this.index.set(id, meta);
    this.appendIndexLine(meta);
    return { stored: true, meta };
  }

  /**
   * 用户主动触发的一次性回填(DevPanel 按钮):逐目录读 match.json,重提炼
   * 富行字段并重写 meta.json + 索引。旧行缺字段是常态(渲染回退),不自动跑。
   *
   * 解析在 worker(旧同步版逐场 readFileSync+JSON.parse 全在 main 主线程,
   * 按实测分布 794 场 ≈ 83GB 读盘 + 6-10 分钟纯冻结,点一下=应用死机,
   * 2026-07-26 审计);main 只付结构化克隆 + metaExtras,场与场之间天然
   * await 让位。IPC invoke 语义不变(handler 本来就返回 Promise)。
   */
  async rebuildIndex(): Promise<{ updated: number; failed: number }> {
    this.lru.clear();
    let updated = 0;
    let failed = 0;
    for (const [id, meta] of [...this.index]) {
      try {
        const doc = (await parseMatchFileInWorker(
          join(this.rootDir, safeName(id), "match.json"),
        )) as { kind: string; data: Record<string, unknown> } | null;
        if (!doc) {
          failed++;
          continue;
        }
        const src =
          doc.kind === "shuffle"
            ? (doc.data as { rounds?: unknown[] }).rounds?.[0]
            : doc.data;
        if (!src) {
          failed++;
          continue;
        }
        const next: StoredMatchMeta = {
          ...meta,
          ...metaExtras(src as Parameters<typeof metaExtras>[0]),
        };
        if (doc.kind === "shuffle") {
          next.durationS = Math.max(
            0,
            Math.round((meta.endTime - meta.startTime) / 1000),
          );
        }
        writeFileSync(
          join(this.rootDir, safeName(id), "meta.json"),
          JSON.stringify(next, null, 2),
        );
        this.index.set(id, next);
        updated++;
      } catch {
        failed++;
      }
    }
    this.rewriteIndex();
    return { updated, failed };
  }

  list(): StoredMatchMeta[] {
    return [...this.index.values()].sort((a, b) => b.startTime - a.startTime);
  }

  page(opts: { before?: number; limit: number }): StoredMatchMeta[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit || 0)));
    const before = Number.isFinite(opts.before as number)
      ? (opts.before as number)
      : Infinity;
    return this.list()
      .filter((m) => m.startTime < before)
      .slice(0, limit);
  }

  async get(id: string): Promise<unknown | null> {
    if (!this.index.has(id)) return null;
    const cached = this.lru.get(id);
    if (cached !== undefined) return cached;
    try {
      const data = await parseMatchFileInWorker(
        join(this.rootDir, safeName(id), "match.json"),
      );
      if (data !== null) {
        // 旧肥档就地瘦身(2026-07-25 内存事故):params 13+ 长尾占 doc 53%,
        // 单场 shuffle 442MB → 解析对象 2-4GB。与 compose 出厂路径共用
        // slimMatchParams(补 crit 物化再裁);幂等,新档重跑零改动。
        // LRU 与发往 renderer 的都是瘦档;磁盘文件不动(重写留给显式迁移)。
        let slimmed = false;
        try {
          slimmed = slimStoredDoc(data);
        } catch {
          /* 瘦身失败不拦加载 */
        }
        this.lru.set(id, data);
        // 自愈回写:下次打开直接解析瘦档(异步、原子改名、失败不吭声)。
        if (slimmed) {
          const target = join(this.rootDir, safeName(id), "match.json");
          const tmp = `${target}.slim-tmp`;
          void (async () => {
            try {
              const { writeFile, rename } = await import("node:fs/promises");
              await writeFile(tmp, JSON.stringify(data));
              await rename(tmp, target);
            } catch {
              /* best-effort */
            }
          })();
        }
      }
      return data;
    } catch {
      return null;
    }
  }

  /**
   * B2 溯源深链:事件 lineIndex → raw.txt 原始行。
   * lineIndex 是解析时段内下标(shuffle 为轮内下标);整场 raw.txt 的偏移
   * 由前序各轮 linesTotal 累加 —— 与 compose 拼接 rawLines 的顺序同源
   * (rounds 顺序 + 末尾 ARENA_MATCH_END 行,末行不影响前缀偏移)。
   */
  async rawLine(
    id: string,
    opts: { roundSeq?: number | null; lineIndex: number },
  ): Promise<{ line: string; fileLine: number } | null> {
    if (!this.index.has(id)) return null;
    if (!Number.isInteger(opts.lineIndex) || opts.lineIndex < 0) return null;
    try {
      let offset = 0;
      if (opts.roundSeq != null) {
        const doc = (await this.get(id)) as {
          data?: { rounds?: { sequenceNumber: number; linesTotal: number }[] };
        } | null;
        const rounds = doc?.data?.rounds;
        if (!Array.isArray(rounds)) return null;
        for (const r of rounds) {
          if (r.sequenceNumber < opts.roundSeq) offset += r.linesTotal;
        }
      }
      const fileLine = offset + opts.lineIndex;
      const line = await readNthLine(
        join(this.rootDir, safeName(id), "raw.txt"),
        fileLine,
      );
      return line === null || line === "" ? null : { line, fileLine };
    } catch {
      return null;
    }
  }
}
