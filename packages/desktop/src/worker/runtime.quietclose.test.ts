import { appendFileSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { MainToWorker, WorkerToMain } from "../shared/protocol";
import { createWorkerRuntime } from "./runtime";

/** Same line construction as pipeline.lifecycle.test. */
function line(i: number, s: string): string {
  return `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}\n`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(quiet: { closeMs: number; checkMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-runtime-"));
  const file = join(dir, "WoWCombatLog.txt");
  writeFileSync(file, "");
  const msgs: WorkerToMain[] = [];
  let send: ((msg: MainToWorker) => void) | null = null;
  let fsEvent: ((eventType: string, fileName: string) => void) | null = null;
  const rt = createWorkerRuntime({
    transport: {
      post: (m) => msgs.push(m),
      onMessage: (cb) => {
        send = cb;
      },
    },
    // Don't use the real fs.watch: the test fabricates its own events, so
    // platform differences can't make it flaky
    watchFn: ((_dir: string, cb: (e: string, f: string) => void) => {
      fsEvent = cb;
      return { close() {} };
    }) as never,
    segmentQuietCloseMs: quiet.closeMs,
    quietCheckIntervalMs: quiet.checkMs,
  });
  const configure = () =>
    send!({
      type: "configure",
      config: {
        logsDir: dir,
        checkpointsPath: join(dir, "cp.json"),
        quarantined: [],
        flushIntervalMs: 10,
        quietPeriodMs: 10,
      },
    });
  const closes = () => msgs.filter((m) => m.type === "segmentClose");
  return {
    dir,
    file,
    msgs,
    rt,
    configure,
    closes,
    fsEvent: (name: string) => fsEvent?.("change", name),
  };
}

describe("段静默超时(打完了 END 不落盘 → 录像只剩 40 分钟阀的修复)", () => {
  it("开着的段超过阈值无新字节 → 合成 aborted segmentClose,且不重复发", async () => {
    const t = setup({ closeMs: 80, checkMs: 20 });
    appendFileSync(t.file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    t.configure(); // the initial flush consumes START and opens the segment
    expect(t.msgs.filter((m) => m.type === "segmentOpen")).toHaveLength(1);
    expect(t.closes()).toHaveLength(0);

    await sleep(200); // silence exceeding the threshold
    expect(t.closes()).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);

    await sleep(150); // still silent: close must not be emitted repeatedly
    expect(t.closes()).toHaveLength(1);
    t.rt.dispose();
  });

  it("数据持续增长时不触发;段正常 END 后计时器也不再多嘴", async () => {
    const t = setup({ closeMs: 120, checkMs: 20 });
    appendFileSync(t.file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    t.configure();
    // Simulate a match in progress: new bytes land every 40ms (< closeMs)
    for (let i = 1; i <= 4; i++) {
      await sleep(40);
      appendFileSync(t.file, line(i, "SPELL_CAST_SUCCESS,x,y"));
      t.fsEvent("WoWCombatLog.txt");
      await sleep(20); // wait for the flushIntervalMs tick to consume them
    }
    // while the file is growing, the silence valve stays out of it
    expect(t.closes()).toHaveLength(0);

    appendFileSync(t.file, line(9, "ARENA_MATCH_END,1,30,1500,1501"));
    t.fsEvent("WoWCombatLog.txt");
    await sleep(40);
    expect(t.closes()).toEqual([expect.objectContaining({ aborted: false })]);

    await sleep(200); // segment already closed: the silence timer stays quiet
    expect(t.closes()).toHaveLength(1);
    t.rt.dispose();
  });

  it("静默 close 后迟到的真 END 仍照常入库(parser 状态未被动过)", async () => {
    const t = setup({ closeMs: 60, checkMs: 15 });
    appendFileSync(t.file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    t.configure();
    await sleep(150);
    expect(t.closes()).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);

    // WoW only flushes the END much later (e.g. right before the next match
    // starts): the match must still be produced as usual
    appendFileSync(t.file, line(30, "ARENA_MATCH_END,1,30,1500,1501"));
    t.fsEvent("WoWCombatLog.txt");
    await sleep(40);
    expect(t.msgs.filter((m) => m.type === "match")).toHaveLength(1);
    // The real close is still emitted (the recorder already stopped, so it is
    // absorbed as a no-op)
    expect(t.closes()).toHaveLength(2);
    expect(t.closes()[1]).toMatchObject({ aborted: false });
    t.rt.dispose();
  });
});
