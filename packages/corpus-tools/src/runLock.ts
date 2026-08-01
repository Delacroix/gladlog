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
 * 能不能接管这把锁。
 *
 * 用「持锁 pid 是否还活着」而不是超时时间做判据:首次全量跑 22 小时,任何
 * 合理的超时都会误杀正常运行的实例。isAlive 由调用方注入(生产用
 * `process.kill(pid, 0)`),便于单测。
 */
export function isLockStale(
  info: LockInfo | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!info) return true;
  return !isAlive(info.pid);
}
