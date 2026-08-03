import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { RecordingsStore } from "./recordingsStore";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

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
      schema: 2,
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 300_000,
      matchIds: [],
    });
    expect(new RecordingsStore(dir).list()).toHaveLength(1);
  });

  it("associate:重叠即命中(录像起点晚于开场),写回 matchId", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    // Match starts at T0, recording starts at T0+8s (log lag)
    store.add({
      schema: 2,
      videoPath: v,
      startedAt: T0 + 8_000,
      stoppedAt: T0 + 300_000,
      matchIds: [],
    });
    const hit = store.associate({
      id: "m1",
      startTime: T0,
      endTime: T0 + 290_000,
    });
    expect(hit?.matchIds).toEqual(["m1"]);
    expect(store.getForMatch("m1")?.videoPath).toBe(v);
    expect(new RecordingsStore(dir).getForMatch("m1")).not.toBeNull(); // persisted
  });

  it("associate:窗口不沾边 → null;已关联的分片可被第二场追加", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideo(dir, "a.mp4"),
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchIds: [],
    });
    expect(
      store.associate({
        id: "far",
        startTime: T0 + 10_000_000,
        endTime: T0 + 10_060_000,
      }),
    ).toBeNull();
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    // schema 2: 一段素材可承载多场,第二场不再被拒(设计文档 §4.3)
    expect(
      store.associate({ id: "m2", startTime: T0, endTime: T0 + 50_000 }),
    ).not.toBeNull();
    expect(store.list()[0]!.matchIds).toEqual(["m1", "m2"]);
  });

  it("索引单行损坏:只丢那一行,rewrite 不清空合法历史(agy #2)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    store.add({
      schema: 2,
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 300_000,
      matchIds: [],
    });
    // Simulate truncation from a power loss: append half a JSON line
    appendFileSync(join(dir, "recordings.ndjson"), '{"videoPath":"/tr');
    expect(store.list()).toHaveLength(1);
    // The valid line survives after a rewrite is triggered (association hit)
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 290_000 });
    expect(new RecordingsStore(dir).getForMatch("m1")?.videoPath).toBe(v);
  });

  it("prune:按 startedAt 降序保留 N,其余删文件+删行;0 = 不删", () => {
    const { dir, store } = setup();
    const old = fakeVideo(dir, "old.mp4");
    const neu = fakeVideo(dir, "new.mp4");
    // Both are already-associated matched recordings (since I2, keepCount
    // only governs the matched quota and orphans go through their own
    // ORPHAN_KEEP_CAP -- a non-empty matchIds preserves the "keepCount-driven
    // keep-newest" semantics this test was originally written for).
    store.add({
      schema: 2,
      videoPath: old,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: ["m-old"],
    });
    store.add({
      schema: 2,
      videoPath: neu,
      startedAt: T0 + 10_000,
      stoppedAt: T0 + 10_001,
      matchIds: ["m-new"],
    });
    expect(store.prune(0)).toEqual({ deleted: 0 });
    expect(store.prune(1)).toEqual({ deleted: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(neu)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("associate:覆盖对局窗口更多的候选优先于起点更近的候选(退出重开,I1)", () => {
    const { dir, store } = setup();
    // A: the truncated recording from before the quit -- its startedAt hugs
    // the match start, but only 60s was recorded before quitting
    const truncated = fakeVideo(dir, "a-truncated.mp4");
    // B: recorded after reconnecting -- starts 65s late, but covers the end
    // of the match
    const covering = fakeVideo(dir, "b-covering.mp4");
    store.add({
      schema: 2,
      videoPath: truncated,
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchIds: [],
    });
    store.add({
      schema: 2,
      videoPath: covering,
      startedAt: T0 + 65_000,
      stoppedAt: T0 + 310_000,
      matchIds: [],
    });
    const hit = store.associate({
      id: "m1",
      startTime: T0,
      endTime: T0 + 300_000,
    });
    // The old predicate (nearest startedAt) would pick truncated (distance
    // 0); the new predicate goes by overlap duration (truncated=60s /
    // covering=235s) and picks covering, which actually covers the match.
    expect(hit?.videoPath).toBe(covering);
    expect(store.getForMatch("m1")?.videoPath).toBe(covering);
  });

  it("prune:孤儿不挤占 matched 的保留名额(I2)", () => {
    const { dir, store } = setup();
    const matchedVideo = fakeVideo(dir, "matched.mp4");
    const o1 = fakeVideo(dir, "o1.mp4"); // Oldest orphan
    const o2 = fakeVideo(dir, "o2.mp4");
    const o3 = fakeVideo(dir, "o3.mp4"); // Newest orphan
    // The matched recording has the oldest startedAt -- the old "sort
    // everything by startedAt and take keepCount" strategy would push it out
    // of the keep window, even though it is the only recording associated
    // with a real match.
    store.add({
      schema: 2,
      videoPath: matchedVideo,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: ["match-1"],
    });
    store.add({
      schema: 2,
      videoPath: o1,
      startedAt: T0 + 1_000,
      stoppedAt: T0 + 1_001,
      matchIds: [],
    });
    store.add({
      schema: 2,
      videoPath: o2,
      startedAt: T0 + 2_000,
      stoppedAt: T0 + 2_001,
      matchIds: [],
    });
    store.add({
      schema: 2,
      videoPath: o3,
      startedAt: T0 + 3_000,
      stoppedAt: T0 + 3_001,
      matchIds: [],
    });
    store.prune(1);
    expect(existsSync(matchedVideo)).toBe(true);
    expect(store.getForMatch("match-1")?.videoPath).toBe(matchedVideo);
    // Orphan keep cap is 2: the oldest, o1, is deleted; o2/o3 stay as
    // in-flight association candidates
    expect(existsSync(o1)).toBe(false);
    expect(existsSync(o2)).toBe(true);
    expect(existsSync(o3)).toBe(true);
  });

  it("prune:删除失败(文件被占用)保留索引行,下次重试(I4)", () => {
    const { dir, store } = setup();
    const o1 = fakeVideo(dir, "locked-o1.mp4");
    const o2 = fakeVideo(dir, "o2.mp4");
    const o3 = fakeVideo(dir, "o3.mp4");
    store.add({
      schema: 2,
      videoPath: o1,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: [],
    });
    store.add({
      schema: 2,
      videoPath: o2,
      startedAt: T0 + 1_000,
      stoppedAt: T0 + 1_001,
      matchIds: [],
    });
    store.add({
      schema: 2,
      videoPath: o3,
      startedAt: T0 + 2_000,
      stoppedAt: T0 + 2_001,
      matchIds: [],
    });
    // o1 is the oldest of the three orphans, so ORPHAN_KEEP_CAP=2 selects it
    // for deletion; simulate it being held open by vod:// playback on
    // Windows, making unlink throw.
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error("EBUSY: resource busy or locked");
    });
    const result = store.prune(10);
    expect(result.deleted).toBe(0);
    expect(existsSync(o1)).toBe(true); // The file itself is not lost
    expect(store.list().some((e) => e.videoPath === o1)).toBe(true); // The index line remains; the next prune retries
  });

  it("prune:未入索引文件只报可见性,绝不删除(I3)", () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "gladlog-rec-"));
    const store = new RecordingsStore(dir, (m) => logs.push(m));
    const indexed = fakeVideo(dir, "indexed.mp4");
    store.add({
      schema: 2,
      videoPath: indexed,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: ["m1"],
    });
    // Simulate an orphan file left behind by OBS crashing mid-recording: no
    // index line at all
    const stray = fakeVideo(dir, "stray-crash.mp4");
    store.prune(10);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(indexed)).toBe(true);
    expect(logs.join("\n")).toMatch(/1 个未入索引文件/);
  });
});

describe("RecordingsStore schema 2", () => {
  it("背靠背两场认领同一分片(一期的已知损失,现在修好)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "chunk.mp4");
    store.add({
      schema: 2,
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 600_000,
      matchIds: [],
    });
    expect(
      store.associate({
        id: "m1",
        startTime: T0 + 10_000,
        endTime: T0 + 200_000,
      }),
    ).not.toBeNull();
    expect(
      store.associate({
        id: "m2",
        startTime: T0 + 300_000,
        endTime: T0 + 500_000,
      }),
    ).not.toBeNull();
    expect(store.getForMatch("m1")?.videoPath).toBe(v);
    expect(store.getForMatch("m2")?.videoPath).toBe(v);
    expect(new RecordingsStore(dir).list()[0]!.matchIds).toEqual(["m1", "m2"]);
  });

  it("重复 associate 同一场是幂等的", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideo(dir, "a.mp4"),
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchIds: [],
    });
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    expect(store.list()[0]!.matchIds).toEqual(["m1"]);
  });

  it("老 schema 行读入时惰性升级,不丢关联", () => {
    const { dir } = setup(); // setup() 已建好目录,不要重复 mkdirSync
    writeFileSync(
      join(dir, "recordings.ndjson"),
      JSON.stringify({
        videoPath: "/tmp/old.mp4",
        startedAt: T0,
        stoppedAt: T0 + 1000,
        matchId: "old-match",
      }) +
        "\n" +
        JSON.stringify({
          videoPath: "/tmp/orphan.mp4",
          startedAt: T0,
          stoppedAt: T0 + 1000,
          matchId: null,
        }) +
        "\n",
    );
    const store = new RecordingsStore(dir);
    expect(store.getForMatch("old-match")?.videoPath).toBe("/tmp/old.mp4");
    expect(store.list()[1]!.matchIds).toEqual([]);
    expect(store.list().every((e) => e.schema === 2)).toBe(true);
  });

  it("仍在录的分片(stoppedAt=null)可被关联", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideo(dir, "live.mp4"),
      startedAt: T0,
      stoppedAt: null,
      matchIds: [],
    });
    expect(
      store.associate({
        id: "m1",
        startTime: T0 + 10_000,
        endTime: T0 + 20_000,
      }),
    ).not.toBeNull();
  });
});
