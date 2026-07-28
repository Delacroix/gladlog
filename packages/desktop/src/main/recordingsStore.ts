import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

/** 时间窗关联容差:录像起点晚于开场是常态(日志滞后),判据是重叠而非包含。 */
export const TOLERANCE_MS = 60_000;

export interface RecordingEntry {
  videoPath: string;
  /** StartRecord 墙钟 epoch ms —— 回放端的对齐锚点。 */
  startedAt: number;
  stoppedAt: number;
  matchId: string | null;
}

/** 录像索引(独立于 matchStore —— 其自愈路径会 rmSync 整场目录,录像绝不能同住)。
 * ndjson 一行一条;写回(关联/清理)整文件原子重写(tmp + rename)。 */
export class RecordingsStore {
  constructor(private dir: string) {}
  private indexPath(): string {
    return join(this.dir, "recordings.ndjson");
  }

  list(): RecordingEntry[] {
    try {
      return readFileSync(this.indexPath(), "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as RecordingEntry);
    } catch {
      return [];
    }
  }

  private rewrite(entries: RecordingEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexPath()}.tmp`;
    writeFileSync(
      tmp,
      entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length ? "\n" : ""),
    );
    renameSync(tmp, this.indexPath());
  }

  add(entry: RecordingEntry): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.indexPath(), JSON.stringify(entry) + "\n");
  }

  /** 时间窗重叠关联;命中即写回。多录像重叠取 startedAt 离开场最近的一条。
   * DOUBLE_START 连场共用一段录像时先到的 meta 得手,后到的落空 —— 一期接受。 */
  associate(meta: {
    id: string;
    startTime: number;
    endTime: number;
  }): RecordingEntry | null {
    const entries = this.list();
    const candidates = entries.filter(
      (e) =>
        e.matchId === null &&
        e.startedAt <= meta.endTime + TOLERANCE_MS &&
        e.stoppedAt >= meta.startTime - TOLERANCE_MS,
    );
    if (candidates.length === 0) return null;
    const hit = candidates.sort(
      (a, b) =>
        Math.abs(a.startedAt - meta.startTime) -
        Math.abs(b.startedAt - meta.startTime),
    )[0]!;
    hit.matchId = meta.id;
    this.rewrite(entries);
    return hit;
  }

  getForMatch(matchId: string): RecordingEntry | null {
    return this.list().find((e) => e.matchId === matchId) ?? null;
  }

  prune(keepCount: number): { deleted: number } {
    if (keepCount <= 0) return { deleted: 0 };
    const entries = this.list().sort((a, b) => b.startedAt - a.startedAt);
    const keep = entries.slice(0, keepCount);
    const drop = entries.slice(keepCount);
    for (const e of drop) {
      try {
        if (existsSync(e.videoPath)) unlinkSync(e.videoPath);
      } catch {
        /* 文件被占用等 —— 行照删,下次 prune 不再追这个文件 */
      }
    }
    if (drop.length > 0) this.rewrite(keep);
    return { deleted: drop.length };
  }
}
