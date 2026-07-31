import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";

/** 时间窗关联容差:录像起点晚于开场是常态(日志滞后),判据是重叠而非包含。 */
export const TOLERANCE_MS = 60_000;

/** I2 修复:孤儿(未关联)录像的保留上限,与 matched 录像的 keepCount 完全独立
 * 计算——否则孤儿会挤占 keepCount 名额,把真正已关联对局的录像挤没(审计
 * Important #2:prune 原先对全体 entries 不分 matchId 一起按 startedAt 排序)。
 * 取 2:够盖"当前在录的一段 + 刚结束还没等到 associate() 消息的上一段"两个
 * 在途候选,多了纯占盘没有实际用途。 */
const ORPHAN_KEEP_CAP = 2;

export interface RecordingEntry {
  videoPath: string;
  /** StartRecord 墙钟 epoch ms —— 回放端的对齐锚点。 */
  startedAt: number;
  stoppedAt: number;
  matchId: string | null;
}

/** [e.startedAt, e.stoppedAt] 与 [meta.startTime, meta.endTime] 的重叠毫秒数。
 * 字段从建库起就必填,理论上不会缺;这里仍防御性处理老数据/手写坏行缺
 * stoppedAt 的情况,返回 null 让调用方退回"离 startedAt 最近"的旧判据,而不是
 * 把它当 0 重叠错误地排到最后(0 重叠是合法值——两段贴边不沾——不能和"不知道"
 * 混为一谈)。 */
function overlapMs(
  e: RecordingEntry,
  meta: { startTime: number; endTime: number },
): number | null {
  if (typeof e.stoppedAt !== "number") return null;
  const start = Math.max(e.startedAt, meta.startTime);
  const end = Math.min(e.stoppedAt, meta.endTime);
  return Math.max(0, end - start);
}

/** 录像索引(独立于 matchStore —— 其自愈路径会 rmSync 整场目录,录像绝不能同住)。
 * ndjson 一行一条;写回(关联/清理)整文件原子重写(tmp + rename)。 */
export class RecordingsStore {
  constructor(
    private dir: string,
    /** I3:未入索引文件(OBS 崩溃孤儿/用户手动录像)只上报可见性,绝不删——这个
     * 目录是 OBS 自己的输出目录,可能混着用户自己的手动录像,整目录扫描删除
     * 就是重蹈"无脑收尾误停用户录制"那类破坏性操作的覆辙(见 recorder.ts
     * weStartedRecording 的教训)。默认 no-op,生产环境由 main/index.ts 接
     * electron-log。 */
    private log: (msg: string) => void = () => {},
  ) {}
  private indexPath(): string {
    return join(this.dir, "recordings.ndjson");
  }

  list(): RecordingEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.indexPath(), "utf-8");
    } catch {
      return [];
    }
    // 逐行容错:一行损坏(断电截断)只丢那一行 —— 整体 catch 会让下一次
    // rewrite 把全部合法历史清空(agy flash 复核 #2)。
    const out: RecordingEntry[] = [];
    for (const l of raw.split("\n")) {
      if (l.trim() === "") continue;
      try {
        out.push(JSON.parse(l) as RecordingEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
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

  /** 时间窗重叠关联;命中即写回。多候选优先取"覆盖对局时间窗更多"的一条
   * (I1 修复,审计 Important #1)——退出重开场景下:退出前的截断录像 A 的
   * startedAt 可能贴着 meta.startTime(离得"最近"),但只录到了对局开头一
   * 小段就被 quit 掐断;断线重连后续录的 B 起点晚,却真正盖住了对局的结尾。
   * 旧判据"只看 startedAt 离 meta.startTime 最近"会稳定选中真正没用的 A、
   * 把有用的 B 晾在孤儿堆里。重叠时长相同(含都为 0,或双方都缺 stoppedAt
   * 导致 overlapMs 返回 null)才退回旧的"离 startedAt 最近"判据。
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
    const hit = candidates
      .map((e) => ({ e, overlap: overlapMs(e, meta) }))
      .sort((a, b) => {
        const ao = a.overlap ?? -1;
        const bo = b.overlap ?? -1;
        if (bo !== ao) return bo - ao;
        return (
          Math.abs(a.e.startedAt - meta.startTime) -
          Math.abs(b.e.startedAt - meta.startTime)
        );
      })[0]!.e;
    hit.matchId = meta.id;
    this.rewrite(entries);
    return hit;
  }

  getForMatch(matchId: string): RecordingEntry | null {
    return this.list().find((e) => e.matchId === matchId) ?? null;
  }

  /** I3:扫一遍录像目录,把不在索引里的文件(OBS 中途崩溃、连 StopRecord 都
   * 没跑到,一行索引都没留下;或者用户自己在同目录手动录的东西)在 info 级
   * 别报出数量与总体积。刻意不删、也不试图区分"崩溃孤儿"和"用户自己的录
   * 像"——两者从文件系统角度看不出区别,乱猜就是重蹈误删用户数据的覆辙。
   * 没覆盖到的:这条日志只是"让人能看见去手动清",不会自动回收这部分磁盘;
   * 真正能自动兜住的只有 recorder.ts 里"gladlog 自己发起、还记得 startedAt"
   * 的那类孤儿(closeOrphanRecording,走 stopRecord() 拿到的 outputPath 直接
   * 入索引)——OBS 进程本身崩溃重启（不是 websocket 断连）那种连正向证据都
   * 没有的情况,不在本次修复范围内,诚实标注为遗留缺口。 */
  private reportUnindexedFiles(entries: RecordingEntry[]): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const indexed = new Set(entries.map((e) => resolve(e.videoPath)));
    let count = 0;
    let bytes = 0;
    for (const name of names) {
      if (name === "recordings.ndjson" || name.endsWith(".tmp")) continue;
      const p = resolve(join(this.dir, name));
      if (indexed.has(p)) continue;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        count++;
        bytes += st.size;
      } catch {
        /* 扫描和 stat 之间文件消失等竞态 —— 跳过,不影响可见性日志的大致数字 */
      }
    }
    if (count > 0) {
      this.log(
        `[recordings] ${count} 个未入索引文件,共 ${(bytes / 1_000_000).toFixed(1)}MB —— ` +
          `可能是 OBS 崩溃孤儿或用户手动录像,不会自动删除,需人工核查`,
      );
    }
  }

  /** 保留策略(I2/I4 修复,审计 Important #2/#4):
   * - matched(已关联 matchId)与孤儿(matchId===null)分开计算配额——孤儿绝不
   *   挤占 matched 的 keepCount 名额,孤儿自己的配额是固定的 ORPHAN_KEEP_CAP。
   * - 只有 unlink 真正成功(或文件本来就已经不在)才把行从索引里摘掉;删除
   *   失败(如 Windows 下文件正被 vod:// 播放占用)的行原样保留在索引里,
   *   下次 prune 会重试——这既保住了播放中链接不失联,也不会让文件本体因为
   *   索引行被误删而找不回来、永久占盘(I4:旧代码 catch {} 吞掉失败后仍然
   *   在 keep 之外把行 drop 掉,是故意留下的泄漏)。 */
  prune(keepCount: number): { deleted: number } {
    const entries = this.list();
    this.reportUnindexedFiles(entries);
    if (keepCount <= 0) return { deleted: 0 };

    const matched = entries
      .filter((e) => e.matchId !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
    const orphans = entries
      .filter((e) => e.matchId === null)
      .sort((a, b) => b.startedAt - a.startedAt);
    const keepMatched = matched.slice(0, keepCount);
    const keepOrphans = orphans.slice(0, ORPHAN_KEEP_CAP);
    const candidateDrop = [
      ...matched.slice(keepCount),
      ...orphans.slice(ORPHAN_KEEP_CAP),
    ];
    if (candidateDrop.length === 0) return { deleted: 0 };

    let deleted = 0;
    const survivors: RecordingEntry[] = [];
    for (const e of candidateDrop) {
      let removed = true;
      try {
        if (existsSync(e.videoPath)) unlinkSync(e.videoPath);
      } catch {
        // 文件被占用等 —— 不清索引行,下次 prune 重试(I4)
        removed = false;
      }
      if (removed) deleted++;
      else survivors.push(e);
    }
    this.rewrite([...keepMatched, ...keepOrphans, ...survivors]);
    return { deleted };
  }
}
