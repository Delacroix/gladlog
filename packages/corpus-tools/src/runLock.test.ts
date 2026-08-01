import { describe, expect, it } from "vitest";

import {
  isLockStale,
  type LockInfo,
  parseLock,
  serializeLock,
} from "./runLock";

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
    expect(isLockStale(null, () => true)).toBe(true);
  });
  it("持锁进程还活着 → 不可接管(必须退出,防重复下载)", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => true)).toBe(false);
  });
  it("持锁进程已消失 → 陈旧锁,可接管", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => false)).toBe(true);
  });
});
