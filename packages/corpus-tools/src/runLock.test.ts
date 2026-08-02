import { describe, expect, it } from "vitest";

import {
  isLockStale,
  LOCK_MAX_AGE_MS,
  type LockInfo,
  parseLock,
  serializeLock,
} from "./runLock";

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

describe("锁文件序列化", () => {
  it("可往返", () => {
    const info: LockInfo = { pid: 4242, startedAt: 1_700_000_000_000 };
    expect(parseLock(serializeLock(info))).toEqual(info);
  });
  it("坏内容 → null(当作没有锁)", () => {
    expect(parseLock("")).toBeNull();
    expect(parseLock("垃圾")).toBeNull();
    expect(parseLock('{"pid":"不是数字"}')).toBeNull();
  });
});

describe("isLockStale", () => {
  it("没有锁 → 可以接管", () => {
    expect(isLockStale(null, () => true, NOW)).toBe(true);
  });
  it("持锁进程还活着 → 不可接管(必须退出,防重复下载)", () => {
    expect(
      isLockStale({ pid: 1, startedAt: NOW - 1000 }, () => true, NOW),
    ).toBe(false);
  });
  it("持锁进程已消失 → 陈旧锁,可接管", () => {
    expect(
      isLockStale({ pid: 1, startedAt: NOW - 1000 }, () => false, NOW),
    ).toBe(true);
  });
  it("22 小时的首次全量不会被误杀 —— 主判据是 pid 不是超时", () => {
    const startedAt = NOW - 22 * 60 * 60 * 1000;
    expect(isLockStale({ pid: 1, startedAt }, () => true, NOW)).toBe(false);
  });
  it("超过 48h 无条件接管 —— 挡 pid 复用造成的永久静默停摆", () => {
    const startedAt = NOW - LOCK_MAX_AGE_MS - 1;
    // isAlive returns true (the pid was reused by an unrelated process after
    // a reboot), yet it must still be judged stale
    expect(isLockStale({ pid: 1, startedAt }, () => true, NOW)).toBe(true);
  });
  it("恰好 48h 即达上限", () => {
    expect(
      isLockStale(
        { pid: 1, startedAt: NOW - LOCK_MAX_AGE_MS },
        () => true,
        NOW,
      ),
    ).toBe(true);
  });
  it("时钟回拨(startedAt 在未来)不算陈旧,不因负龄误接管", () => {
    expect(
      isLockStale({ pid: 1, startedAt: NOW + 86_400_000 }, () => true, NOW),
    ).toBe(false);
  });
  it("上限是 48 小时(首次全量 22h 的一倍余量)", () => {
    expect(LOCK_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
  });
});
