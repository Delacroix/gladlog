import { describe, expect, it } from "vitest";
import { createQuitLifecycleHandler } from "./quitLifecycle";

function fakeEvent() {
  let prevented = false;
  return {
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

describe("createQuitLifecycleHandler", () => {
  it("先 preventDefault 挂起,等 stopRecorder 完成后再 stopHost + quit (C2)", async () => {
    const calls: string[] = [];
    let resolveStop!: () => void;
    const handler = createQuitLifecycleHandler({
      stopRecorder: () =>
        new Promise<void>((res) => {
          calls.push("recorder-stop-start");
          resolveStop = res;
        }),
      stopHost: () => calls.push("host-stop"),
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });

    const e1 = fakeEvent();
    handler.onBeforeQuit(e1);
    expect(e1.prevented).toBe(true);
    // quit() has not been called — the quit flow must not proceed before
    // recorder.stop() finishes
    expect(calls).toEqual(["recorder-stop-start"]);

    resolveStop();
    await handler.waitForIdle();
    expect(calls).toEqual(["recorder-stop-start", "host-stop", "quit"]);
  });

  it("停录卡死时:超时封顶继续 quit,不会把退出流程挂死 (C2)", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => new Promise<void>(() => {}), // never resolves
      stopHost: () => calls.push("host-stop"),
      quit: () => calls.push("quit"),
      timeoutMs: 20,
    });

    handler.onBeforeQuit(fakeEvent());
    await handler.waitForIdle();
    expect(calls).toEqual(["host-stop", "quit"]);
  });

  it("idempotent:清理进行中再来一次 quit 不重入、不重跑清理链 (C2)", async () => {
    const calls: string[] = [];
    let resolveStop!: () => void;
    const handler = createQuitLifecycleHandler({
      stopRecorder: () =>
        new Promise<void>((res) => {
          calls.push("recorder-stop-start");
          resolveStop = res;
        }),
      stopHost: () => calls.push("host-stop"),
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });

    handler.onBeforeQuit(fakeEvent());
    // The user/system issues another quit request before cleanup finishes: it
    // must still preventDefault (cleanup is not done, so the quit cannot be let
    // through) but must not start a second cleanup chain
    const e2 = fakeEvent();
    handler.onBeforeQuit(e2);
    expect(e2.prevented).toBe(true);
    expect(calls).toEqual(["recorder-stop-start"]); // exactly once, no re-entry

    resolveStop();
    await handler.waitForIdle();
    expect(calls).toEqual(["recorder-stop-start", "host-stop", "quit"]);

    // The next before-quit triggered by quit() itself (in real electron
    // app.quit() re-emits it): phase is already finishing, so it must be let
    // through with no preventDefault
    const e3 = fakeEvent();
    handler.onBeforeQuit(e3);
    expect(e3.prevented).toBe(false);
  });

  it("stopRecorder 本身抛错也不卡住退出 (C2)", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => Promise.reject(new Error("obs unreachable")),
      stopHost: () => calls.push("host-stop"),
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });
    handler.onBeforeQuit(fakeEvent());
    await handler.waitForIdle();
    expect(calls).toEqual(["host-stop", "quit"]);
  });

  it("stopHost 同步抛错也不卡住退出、不吞成 unhandled rejection (复核轮, C2)", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => Promise.resolve(),
      stopHost: () => {
        throw new Error("host teardown failed");
      },
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });
    handler.onBeforeQuit(fakeEvent());
    // waitForIdle() not rejecting is itself the proof that finish() caught
    // stopHost's throw (before the fix stopHost had no try/catch and this
    // rejected outright)
    await expect(handler.waitForIdle()).resolves.toBeUndefined();
    expect(calls).toEqual(["quit"]); // quit() still runs; a host error cannot wedge it
  });

  it("#21 item9(红→绿):退出时也调用 stopAiActivity,收掉飞行中的 AI 分析", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => Promise.resolve(),
      stopHost: () => calls.push("host-stop"),
      stopAiActivity: () => calls.push("stop-ai"),
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });
    handler.onBeforeQuit(fakeEvent());
    await handler.waitForIdle();
    expect(calls).toEqual(["stop-ai", "host-stop", "quit"]);
  });

  it("stopAiActivity 未提供(可选)→ 不报错,退出流程照常走完", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => Promise.resolve(),
      stopHost: () => calls.push("host-stop"),
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });
    handler.onBeforeQuit(fakeEvent());
    await expect(handler.waitForIdle()).resolves.toBeUndefined();
    expect(calls).toEqual(["host-stop", "quit"]);
  });

  it("stopAiActivity 同步抛错也不卡住退出(与 stopHost 同款兜底)", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => Promise.resolve(),
      stopHost: () => calls.push("host-stop"),
      stopAiActivity: () => {
        throw new Error("abort failed");
      },
      quit: () => calls.push("quit"),
      timeoutMs: 5000,
    });
    handler.onBeforeQuit(fakeEvent());
    await expect(handler.waitForIdle()).resolves.toBeUndefined();
    expect(calls).toEqual(["host-stop", "quit"]);
  });

  it("stopAiActivity 不参与 timeoutMs 封顶 race:即便 stopRecorder 永不 resolve,stopAiActivity 依旧先于超时被调用", async () => {
    const calls: string[] = [];
    const handler = createQuitLifecycleHandler({
      stopRecorder: () => new Promise<void>(() => {}), // never resolves
      stopHost: () => calls.push("host-stop"),
      stopAiActivity: () => calls.push("stop-ai"),
      quit: () => calls.push("quit"),
      timeoutMs: 20,
    });
    handler.onBeforeQuit(fakeEvent());
    await handler.waitForIdle();
    expect(calls).toEqual(["stop-ai", "host-stop", "quit"]);
  });
});
