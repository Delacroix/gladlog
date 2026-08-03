import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
} from "../shared/updateSchedule";
import {
  createUpdaterService,
  evaluateGate,
  type UpdaterBackend,
  type UpdaterEnv,
  type UpdateState,
} from "./updater";

function winEnv(over: Partial<UpdaterEnv> = {}): UpdaterEnv {
  return {
    platform: "win32",
    isPackaged: true,
    execDir: "C:\\Users\\x\\AppData\\Local\\Programs\\gladlog",
    readDir: () => ["gladlog.exe", "Uninstall gladlog.exe", "resources"],
    testFeed: undefined,
    ...over,
  };
}

describe("evaluateGate", () => {
  it("非 packaged → dev,且优先于其它门(非法 testFeed 也不抛)", () => {
    expect(
      evaluateGate(
        winEnv({
          isPackaged: false,
          platform: "darwin",
          testFeed: "garbage",
        }),
      ),
    ).toEqual({ ok: false, reason: "dev" });
  });

  it("packaged + win32 + 有卸载器 → 放行,生产 feed", () => {
    expect(evaluateGate(winEnv())).toEqual({ ok: true, feed: null });
  });

  it("非 win32 → platform(mac ad-hoc 签名过不了 Squirrel 校验)", () => {
    expect(evaluateGate(winEnv({ platform: "darwin" }))).toEqual({
      ok: false,
      reason: "platform",
    });
  });

  it("win32 但目录里没有卸载器(zip 绿色版)→ portable", () => {
    expect(
      evaluateGate(winEnv({ readDir: () => ["gladlog.exe", "resources"] })),
    ).toEqual({ ok: false, reason: "portable" });
  });

  it("卸载器判据是扫模式:改了 productName 依然认得", () => {
    expect(
      evaluateGate(winEnv({ readDir: () => ["Uninstall gladlog-next.exe"] })),
    ).toEqual({ ok: true, feed: null });
    // 相近但不是 NSIS 卸载器的文件名不许误判为安装版
    expect(
      evaluateGate(
        winEnv({ readDir: () => ["Uninstaller.exe", "unins000.exe"] }),
      ),
    ).toEqual({ ok: false, reason: "portable" });
  });

  it("目录读不出来 → 按 portable 处理,不抛", () => {
    expect(
      evaluateGate(
        winEnv({
          readDir: () => {
            throw new Error("ENOENT");
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "portable" });
  });

  it("testFeed 合法 → 跳过 platform 与 portable 两道门,返回 feed", () => {
    expect(
      evaluateGate(
        winEnv({
          platform: "darwin",
          readDir: () => [],
          testFeed: "mingjianliu/gladlog-update-test",
        }),
      ),
    ).toEqual({
      ok: true,
      feed: { owner: "mingjianliu", repo: "gladlog-update-test" },
    });
  });

  it("testFeed 非法 → 抛错,绝不静默回落到生产 feed", () => {
    for (const bad of ["", "garbage", "owner/", "/repo", "a/b/c"]) {
      expect(() => evaluateGate(winEnv({ testFeed: bad }))).toThrow(
        /GLADLOG_UPDATER_TEST_FEED/,
      );
    }
  });
});
