import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RecordingsStore } from "./recordingsStore";

const T0 = 1_750_000_000_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-rec-"));
  return { dir, store: new RecordingsStore(dir) };
}
function fakeVideo(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "x");
  return p;
}

describe("RecordingsStore", () => {
  it("add + list 持久化(重开实例仍在)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    store.add({
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 300_000,
      matchId: null,
    });
    expect(new RecordingsStore(dir).list()).toHaveLength(1);
  });

  it("associate:重叠即命中(录像起点晚于开场),写回 matchId", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    // 开场 T0,录像 T0+8s 起(日志滞后)
    store.add({
      videoPath: v,
      startedAt: T0 + 8_000,
      stoppedAt: T0 + 300_000,
      matchId: null,
    });
    const hit = store.associate({
      id: "m1",
      startTime: T0,
      endTime: T0 + 290_000,
    });
    expect(hit?.matchId).toBe("m1");
    expect(store.getForMatch("m1")?.videoPath).toBe(v);
    expect(new RecordingsStore(dir).getForMatch("m1")).not.toBeNull(); // 落盘
  });

  it("associate:窗口不沾边 → null;已关联的不再被抢", () => {
    const { dir, store } = setup();
    store.add({
      videoPath: fakeVideo(dir, "a.mp4"),
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchId: null,
    });
    expect(
      store.associate({
        id: "far",
        startTime: T0 + 10_000_000,
        endTime: T0 + 10_060_000,
      }),
    ).toBeNull();
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    expect(
      store.associate({ id: "m2", startTime: T0, endTime: T0 + 50_000 }),
    ).toBeNull();
  });

  it("prune:按 startedAt 降序保留 N,其余删文件+删行;0 = 不删", () => {
    const { dir, store } = setup();
    const old = fakeVideo(dir, "old.mp4");
    const neu = fakeVideo(dir, "new.mp4");
    store.add({
      videoPath: old,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: null,
    });
    store.add({
      videoPath: neu,
      startedAt: T0 + 10_000,
      stoppedAt: T0 + 10_001,
      matchId: null,
    });
    expect(store.prune(0)).toEqual({ deleted: 0 });
    expect(store.prune(1)).toEqual({ deleted: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(neu)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
