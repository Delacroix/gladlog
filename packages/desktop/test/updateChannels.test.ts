import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Drift guard, same shape as diagnosticLevel.test.ts's "upstream invariant
 * codes" test: an IPC channel name is a string literal shared by three files
 * that never import each other, so a typo type-checks fine and only shows up
 * at runtime as a button that does nothing.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf-8");

describe("自动更新 IPC 频道名三处一致(设计文档 §4.4)", () => {
  const ipc = read("src/main/ipc.ts");
  const mainIndex = read("src/main/index.ts");
  const preload = read("src/preload/index.ts");

  it("main 侧注册三个 handle、index 侧推送 state 并把日志接进 electron-log", () => {
    for (const ch of [
      "gladlog:update:getState",
      "gladlog:update:check",
      "gladlog:update:install",
    ]) {
      expect(ipc).toContain(`ipcMain.handle("${ch}"`);
    }
    expect(mainIndex).toContain(`webContents.send("gladlog:update:state"`);
    // §4.2: without this line electron-updater keeps its default `console`
    // logger (AppUpdater.js:179) and the "Checking for update" / "Found
    // version X" lines never reach ~/Library/Logs/gladlog/main.log — which is
    // the only evidence channel the §6.2 dummy-release verification reads.
    // No trailing semicolon in the match: a structural-typing cast on the
    // right-hand side must still satisfy this guard.
    expect(mainIndex).toContain("autoUpdater.logger = log");
  });

  it("preload 把四个频道全部接出去", () => {
    for (const ch of [
      "gladlog:update:getState",
      "gladlog:update:check",
      "gladlog:update:install",
      "gladlog:update:state",
    ]) {
      expect(preload).toContain(`"${ch}"`);
    }
  });
});
