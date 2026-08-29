import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  type AtomicFsOps,
  atomicWriteFileSync,
  RENAME_RETRY_DELAY_MS,
  renameWithRetrySync,
} from "../src/shared/atomicWrite";

function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** In-memory fs whose rename fails `failTimes` times with `code`. */
function fakeOps(code: string, failTimes: number) {
  const files = new Map<string, string>();
  const log: string[] = [];
  let failures = 0;
  const ops: AtomicFsOps = {
    writeFileSync: (p, d) => {
      files.set(p, String(d));
      log.push(`write ${p}`);
    },
    renameSync: (from, to) => {
      log.push(`rename ${from} -> ${to}`);
      if (failures < failTimes) {
        failures++;
        throw errnoError(code);
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlinkSync: (p) => {
      log.push(`unlink ${p}`);
      if (!files.delete(p)) throw errnoError("ENOENT");
    },
    sleep: (ms) => log.push(`sleep ${ms}`),
  };
  return { ops, files, log };
}

describe("atomicWriteFileSync", () => {
  it("真实 fs:写 tmp 后 rename 覆盖目标,不留 tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-aw-"));
    const p = join(dir, "x.json");
    atomicWriteFileSync(p, "one");
    atomicWriteFileSync(p, "two");
    expect(readFileSync(p, "utf-8")).toBe("two");
    expect(() => readFileSync(`${p}.tmp`)).toThrow();
  });

  it("首次 rename EPERM(Windows 目标被占用)→ unlink 目标、等 50ms、重试一次成功", () => {
    const { ops, files, log } = fakeOps("EPERM", 1);
    files.set("/a", "old");
    atomicWriteFileSync("/a", "new", ops);
    expect(files.get("/a")).toBe("new");
    expect(files.has("/a.tmp")).toBe(false);
    expect(log).toEqual([
      "write /a.tmp",
      "rename /a.tmp -> /a",
      "unlink /a",
      `sleep ${RENAME_RETRY_DELAY_MS}`,
      "rename /a.tmp -> /a",
    ]);
  });

  it.each(["EBUSY", "EEXIST", "EACCES"])("%s 也走重试", (code) => {
    const { ops, files } = fakeOps(code, 1);
    atomicWriteFileSync("/a", "new", ops);
    expect(files.get("/a")).toBe("new");
  });

  it("重试仍失败 → 删 tmp 并抛出原错误", () => {
    const { ops, files } = fakeOps("EPERM", 2);
    expect(() => atomicWriteFileSync("/a", "new", ops)).toThrow(/EPERM/);
    expect(files.has("/a.tmp")).toBe(false);
  });

  it("非锁类错误(ENOSPC)不重试,直接抛", () => {
    const { ops, log } = fakeOps("ENOSPC", 1);
    expect(() => atomicWriteFileSync("/a", "new", ops)).toThrow(/ENOSPC/);
    expect(log.filter((l) => l.startsWith("rename"))).toHaveLength(1);
  });

  it("目标不存在时 unlink 的 ENOENT 被吞,重试照常", () => {
    const { ops, files } = fakeOps("EPERM", 1);
    expect(() => renameWithRetrySync("/src", "/dst", ops)).not.toThrow();
    // /src never existed in the fake either, so the retry "moves" undefined —
    // only the control flow matters here.
    expect(files.has("/src")).toBe(false);
  });
});
