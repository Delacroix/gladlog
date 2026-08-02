import { appendFileSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { MainToWorker, WorkerToMain } from "../shared/protocol";
import { createWorkerRuntime } from "./runtime";

/** 与 pipeline.lifecycle.test 同款行构造。 */
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
    // 不用真 fs.watch:测试自己捏事件,免得平台差异抖动
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
    t.configure(); // 初始 flush 消费 START,段打开
    expect(t.msgs.filter((m) => m.type === "segmentOpen")).toHaveLength(1);
    expect(t.closes()).toHaveLength(0);

    await sleep(200); // 静默超过阈值
    expect(t.closes()).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);

    await sleep(150); // 继续静默:不能反复发 close
    expect(t.closes()).toHaveLength(1);
    t.rt.dispose();
  });

  it("数据持续增长时不触发;段正常 END 后计时器也不再多嘴", async () => {
    const t = setup({ closeMs: 120, checkMs: 20 });
    appendFileSync(t.file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    t.configure();
    // 模拟对局进行中:每 40ms 有新字节落盘(< closeMs)
    for (let i = 1; i <= 4; i++) {
      await sleep(40);
      appendFileSync(t.file, line(i, "SPELL_CAST_SUCCESS,x,y"));
      t.fsEvent("WoWCombatLog.txt");
      await sleep(20); // 等 flushIntervalMs tick 消费
    }
    expect(t.closes()).toHaveLength(0); // 增长期间静默阀不动手

    appendFileSync(t.file, line(9, "ARENA_MATCH_END,1,30,1500,1501"));
    t.fsEvent("WoWCombatLog.txt");
    await sleep(40);
    expect(t.closes()).toEqual([expect.objectContaining({ aborted: false })]);

    await sleep(200); // 段已闭合:静默计时器不再补发
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

    // WoW 迟迟才把 END flush 出来(比如下一场开打前):match 必须照常产出
    appendFileSync(t.file, line(30, "ARENA_MATCH_END,1,30,1500,1501"));
    t.fsEvent("WoWCombatLog.txt");
    await sleep(40);
    expect(t.msgs.filter((m) => m.type === "match")).toHaveLength(1);
    // 真 close 照发(recorder 侧已停录,no-op 消化)
    expect(t.closes()).toHaveLength(2);
    expect(t.closes()[1]).toMatchObject({ aborted: false });
    t.rt.dispose();
  });
});
