import { describe, expect, it, vi } from "vitest";

import { createWowProcessWatch, WOW_PROCESS_NAMES } from "./wowProcessWatch";

describe("WOW_PROCESS_NAMES (复核 M8)", () => {
  it("覆盖三个已知客户端进程名", () => {
    expect(WOW_PROCESS_NAMES).toEqual([
      "Wow.exe",
      "WowClassic.exe",
      "WowT.exe",
    ]);
  });
});

describe("createWowProcessWatch", () => {
  it("默认 intervalMs 为 2000ms(与 arenacoach 同款)", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValue(false);
      const w = createWowProcessWatch({
        probe,
        onUp: () => {},
        onDown: () => {},
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1999);
      expect(probe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(1);
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("probe 为 true → onUp 只触发一次,后续 tick 不重复触发", async () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const onDown = vi.fn();
      const probe = vi.fn().mockResolvedValue(true);
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp,
        onDown,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(onUp).toHaveBeenCalledTimes(1);
      expect(onDown).not.toHaveBeenCalled();
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("单次 miss 不触发 onDown;紧接着恢复 up 也不算 down(抖动防护)", async () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const onDown = vi.fn();
      let up = true;
      const probe = vi.fn(async () => up);
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp,
        onDown,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // tick1: up -> onUp
      expect(onUp).toHaveBeenCalledTimes(1);
      up = false;
      await vi.advanceTimersByTimeAsync(1000); // tick2: miss 1
      expect(onDown).not.toHaveBeenCalled();
      up = true;
      await vi.advanceTimersByTimeAsync(1000); // tick3: recovers before miss 2
      expect(onDown).not.toHaveBeenCalled();
      expect(onUp).toHaveBeenCalledTimes(1); // no duplicate onUp -- state never actually flipped
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续 2 次 miss 才触发 onDown", async () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const onDown = vi.fn();
      let up = true;
      const probe = vi.fn(async () => up);
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp,
        onDown,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // up
      up = false;
      await vi.advanceTimersByTimeAsync(1000); // miss 1
      expect(onDown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000); // miss 2 -> down
      expect(onDown).toHaveBeenCalledTimes(1);
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("单次探测异常不触发任何状态变化", async () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const onDown = vi.fn();
      let call = 0;
      const probe = vi.fn(async () => {
        call++;
        if (call === 2) throw new Error("probe blew up");
        return true;
      });
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp,
        onDown,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // tick1: up -> onUp
      await vi.advanceTimersByTimeAsync(1000); // tick2: throws -> no change
      expect(onUp).toHaveBeenCalledTimes(1);
      expect(onDown).not.toHaveBeenCalled();
      // tick3 confirms the exception didn't corrupt missStreak into an
      // early false-positive down either.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onDown).not.toHaveBeenCalled();
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() 后不再轮询", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValue(true);
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp: () => {},
        onDown: () => {},
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000);
      const callsBeforeStop = probe.mock.calls.length;
      w.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(probe.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() 是幂等的:重复调用不会产生第二个定时器(不会双倍探测)", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValue(false);
      const w = createWowProcessWatch({
        probe,
        intervalMs: 1000,
        onUp: () => {},
        onDown: () => {},
      });
      w.start();
      w.start();
      w.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe).toHaveBeenCalledTimes(1);
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
