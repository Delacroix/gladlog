/**
 * 运行锁。调度是每 6 小时一次,而首次全量跑约 22 小时 —— 不加锁会有多个实例
 * 同时扫同一段 feed、重复下载同一批文件,白白多花对方的流量。
 */

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export function serializeLock(info: LockInfo): string {
  return JSON.stringify(info);
}

export function parseLock(text: string): LockInfo | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.pid !== "number" || typeof o?.startedAt !== "number") {
      return null;
    }
    return { pid: o.pid, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/**
 * 锁的绝对年龄上限。超过这个岁数无条件接管,**不问 pid 死活**。
 *
 * 为什么需要:pid 判据挡不住 pid 复用。SIGKILL/断电留下锁文件 → 机器重启 →
 * 内核从低位重新分配 pid → 旧 pid 被某个无关进程占用 → isAlive 判真 → 这把锁
 * 永不释放。此后每轮只打印「已有归档进程在跑」就退出,连「本次新增 0 场」的
 * 告警都走不到,而 feed 只留 7 天 —— 静默一周就是永久丢一周数据。
 *
 * 48h:首次全量约 22 小时,留一倍余量。此后仍活着的实例被接管,代价是短暂并发,
 * 远小于永久停摆。
 */
export const LOCK_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * 能不能接管这把锁。
 *
 * 主判据是「持锁 pid 是否还活着」而不是超时:首次全量跑 22 小时,任何合理的
 * 超时都会误杀正常运行的实例。startedAt 只作为 pid 复用的兜底(见
 * LOCK_MAX_AGE_MS)。isAlive 由调用方注入(生产用 `process.kill(pid, 0)`),便于单测。
 */
export function isLockStale(
  info: LockInfo | null,
  isAlive: (pid: number) => boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!info) return true;
  // 时钟回拨会让 age 为负 —— 负数不该被当成「很老」,按不陈旧处理。
  const age = nowMs - info.startedAt;
  if (age >= LOCK_MAX_AGE_MS) return true;
  return !isAlive(info.pid);
}
