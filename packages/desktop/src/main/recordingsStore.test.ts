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

  it("索引单行损坏:只丢那一行,rewrite 不清空合法历史(agy #2)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    store.add({
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 300_000,
      matchId: null,
    });
    // 模拟断电截断:追加半行 JSON
    appendFileSync(join(dir, "recordings.ndjson"), '{"videoPath":"/tr');
    expect(store.list()).toHaveLength(1);
    // 触发 rewrite(关联命中)后合法行仍在
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 290_000 });
    expect(new RecordingsStore(dir).getForMatch("m1")?.videoPath).toBe(v);
  });

  it("prune:按 startedAt 降序保留 N,其余删文件+删行;0 = 不删", () => {
    const { dir, store } = setup();
    const old = fakeVideo(dir, "old.mp4");
    const neu = fakeVideo(dir, "new.mp4");
    // 两条都是已关联的 matched 录像(I2 之后 keepCount 只管 matched 配额,
    // 孤儿走独立的 ORPHAN_KEEP_CAP —— 用 matchId 非 null 保住这条用例原本
    // 要测的"keepCount 驱动的按新旧保留"语义)。
    store.add({
      videoPath: old,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: "m-old",
    });
    store.add({
      videoPath: neu,
      startedAt: T0 + 10_000,
      stoppedAt: T0 + 10_001,
      matchId: "m-new",
    });
    expect(store.prune(0)).toEqual({ deleted: 0 });
    expect(store.prune(1)).toEqual({ deleted: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(neu)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("associate:覆盖对局窗口更多的候选优先于起点更近的候选(退出重开,I1)", () => {
    const { dir, store } = setup();
    // A:退出前的截断录像 —— startedAt 贴合开场,但 quit 时只录了 60s
    const truncated = fakeVideo(dir, "a-truncated.mp4");
    // B:断线重连后续录的 —— 起点晚了 65s,却盖住了对局结尾
    const covering = fakeVideo(dir, "b-covering.mp4");
    store.add({
      videoPath: truncated,
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchId: null,
    });
    store.add({
      videoPath: covering,
      startedAt: T0 + 65_000,
      stoppedAt: T0 + 310_000,
      matchId: null,
    });
    const hit = store.associate({
      id: "m1",
      startTime: T0,
      endTime: T0 + 300_000,
    });
    // 旧判据(离 startedAt 最近)会选中 truncated(距离 0);新判据按重叠时长
    // (truncated=60s / covering=235s)选中真正盖住对局的 covering。
    expect(hit?.videoPath).toBe(covering);
    expect(store.getForMatch("m1")?.videoPath).toBe(covering);
  });

  it("prune:孤儿不挤占 matched 的保留名额(I2)", () => {
    const { dir, store } = setup();
    const matchedVideo = fakeVideo(dir, "matched.mp4");
    const o1 = fakeVideo(dir, "o1.mp4"); // 最旧的孤儿
    const o2 = fakeVideo(dir, "o2.mp4");
    const o3 = fakeVideo(dir, "o3.mp4"); // 最新的孤儿
    // matched 的 startedAt 最旧 —— 旧的"全体按 startedAt 排序取 keepCount"
    // 策略会把它挤出保留窗口,即使它是唯一已关联真实对局的录像。
    store.add({
      videoPath: matchedVideo,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: "match-1",
    });
    store.add({
      videoPath: o1,
      startedAt: T0 + 1_000,
      stoppedAt: T0 + 1_001,
      matchId: null,
    });
    store.add({
      videoPath: o2,
      startedAt: T0 + 2_000,
      stoppedAt: T0 + 2_001,
      matchId: null,
    });
    store.add({
      videoPath: o3,
      startedAt: T0 + 3_000,
      stoppedAt: T0 + 3_001,
      matchId: null,
    });
    store.prune(1);
    expect(existsSync(matchedVideo)).toBe(true);
    expect(store.getForMatch("match-1")?.videoPath).toBe(matchedVideo);
    // 孤儿保留上限 2:最旧的 o1 被删,o2/o3 留作在途关联候选
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
      videoPath: o1,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: null,
    });
    store.add({
      videoPath: o2,
      startedAt: T0 + 1_000,
      stoppedAt: T0 + 1_001,
      matchId: null,
    });
    store.add({
      videoPath: o3,
      startedAt: T0 + 2_000,
      stoppedAt: T0 + 2_001,
      matchId: null,
    });
    // o1 是三个孤儿里最旧的,会被 ORPHAN_KEEP_CAP=2 选中删除;模拟它被
    // Windows 下的 vod:// 播放占用,unlink 抛错。
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error("EBUSY: resource busy or locked");
    });
    const result = store.prune(10);
    expect(result.deleted).toBe(0);
    expect(existsSync(o1)).toBe(true); // 文件本体没丢
    expect(store.list().some((e) => e.videoPath === o1)).toBe(true); // 索引行还在,下次 prune 重试
  });

  it("prune:未入索引文件只报可见性,绝不删除(I3)", () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "gladlog-rec-"));
    const store = new RecordingsStore(dir, (m) => logs.push(m));
    const indexed = fakeVideo(dir, "indexed.mp4");
    store.add({
      videoPath: indexed,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: "m1",
    });
    // 模拟 OBS 中途崩溃留下的孤儿文件:一行索引都没有
    const stray = fakeVideo(dir, "stray-crash.mp4");
    store.prune(10);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(indexed)).toBe(true);
    expect(logs.join("\n")).toMatch(/1 个未入索引文件/);
  });
});
