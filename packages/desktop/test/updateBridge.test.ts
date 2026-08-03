// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import type { UpdateState } from "../src/main/updater";
import {
  dismissVersionNotice,
  fetchUpdateState,
  hasUpdateSurface,
  requestUpdateCheck,
  requestUpdateInstall,
  resolveVersionNotice,
  subscribeUpdateState,
} from "../src/renderer/src/update/updateBridge";

function installStub(stub: Record<string, unknown>) {
  (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = stub;
}

beforeEach(() => {
  installStub({});
});

describe("updateBridge 对缺失 bridge 面免疫", () => {
  it("桩里没有 update 面时:读状态给 null,订阅给一个能调的退订,check/install 不抛", async () => {
    expect(hasUpdateSurface()).toBe(false);
    expect(await fetchUpdateState()).toBe(null);
    const off = subscribeUpdateState(() => {});
    expect(() => off()).not.toThrow();
    await expect(requestUpdateCheck()).resolves.toBeUndefined();
    await expect(requestUpdateInstall()).resolves.toBeUndefined();
  });

  it("桩里有 update 面时:透传状态、转发推送、退订能落到底层", async () => {
    let pushed: ((s: UpdateState) => void) | null = null;
    let offCount = 0;
    let checked = 0;
    let installed = 0;
    installStub({
      update: {
        getState: async (): Promise<UpdateState> => ({
          phase: "ready",
          version: "0.1.20",
        }),
        check: async () => {
          checked += 1;
        },
        install: async () => {
          installed += 1;
        },
        onState: (cb: (s: UpdateState) => void) => {
          pushed = cb;
          return () => {
            offCount += 1;
          };
        },
      },
    });
    expect(hasUpdateSurface()).toBe(true);
    expect(await fetchUpdateState()).toEqual({
      phase: "ready",
      version: "0.1.20",
    });
    const seen: UpdateState[] = [];
    const off = subscribeUpdateState((s) => seen.push(s));
    pushed!({ phase: "checking" });
    expect(seen).toEqual([{ phase: "checking" }]);
    off();
    expect(offCount).toBe(1);
    await requestUpdateCheck();
    await requestUpdateInstall();
    expect([checked, installed]).toEqual([1, 1]);
  });
});

describe("§4.7 更新留痕:lastSeenVersion 比对", () => {
  function stubSettings(lastSeenVersion: string | null, version = "0.1.20") {
    const saved: Array<Record<string, unknown>> = [];
    installStub({
      app: { getVersion: async () => version },
      settings: {
        get: async () => ({ lastSeenVersion }),
        save: async (p: Record<string, unknown>) => {
          saved.push(p);
          return {};
        },
      },
    });
    return saved;
  }

  it("首次启动(lastSeenVersion=null)不报喜,静默记住当前版本", async () => {
    const saved = stubSettings(null);
    expect(await resolveVersionNotice()).toBe(null);
    expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
  });

  it("版本变了 → 返回当前版本,且此时不写回(等用户点掉才写)", async () => {
    const saved = stubSettings("0.1.19");
    expect(await resolveVersionNotice()).toBe("0.1.20");
    expect(saved).toEqual([]);
  });

  it("同版本 → null,不写回", async () => {
    const saved = stubSettings("0.1.20");
    expect(await resolveVersionNotice()).toBe(null);
    expect(saved).toEqual([]);
  });

  it("点掉留痕 → 写回 lastSeenVersion", async () => {
    const saved = stubSettings("0.1.19");
    await dismissVersionNotice("0.1.20");
    expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
  });

  it("桩里连 settings/app 面都没有 → null,不抛", async () => {
    expect(await resolveVersionNotice()).toBe(null);
    await expect(dismissVersionNotice("0.1.20")).resolves.toBeUndefined();
  });
});
