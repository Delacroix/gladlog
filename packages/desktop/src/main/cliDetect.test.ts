import { describe, expect, it } from "vitest";
import {
  detectCliForBackend,
  detectLocalCli,
  wellKnownCliCandidates,
} from "./cliDetect";

const WIN = {
  platform: "win32" as const,
  home: "C:\\Users\\u",
  env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
};
const MAC = { platform: "darwin" as const, home: "/Users/u", env: {} };

describe("wellKnownCliCandidates", () => {
  it("win32:原生安装器 .local\\bin\\*.exe 与 npm 全局 *.cmd 都在候选里", () => {
    const c = wellKnownCliCandidates("claude", WIN);
    expect(c).toContain("C:\\Users\\u\\.local\\bin\\claude.exe");
    expect(c).toContain("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd");
  });
  it("win32:无 APPDATA 时不产出 npm 候选(不拼 undefined 路径)", () => {
    const c = wellKnownCliCandidates("agy", { ...WIN, env: {} });
    expect(c).toEqual(["C:\\Users\\u\\.local\\bin\\agy.exe"]);
  });
  it("mac:~/.local/bin、homebrew、/usr/local/bin 兜底", () => {
    expect(wellKnownCliCandidates("agy", MAC)).toEqual([
      "/Users/u/.local/bin/agy",
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ]);
  });
});

describe("detectLocalCli", () => {
  it("PATH 命中优先,不再探测目录", async () => {
    const probed: string[] = [];
    const p = await detectLocalCli("claude", {
      ...MAC,
      pathLookup: async () => "/from/path/claude",
      exists: (x) => {
        probed.push(x);
        return true;
      },
    });
    expect(p).toBe("/from/path/claude");
    expect(probed).toEqual([]);
  });
  it("PATH 查不到时按候选顺序探测,返回第一个存在的", async () => {
    const p = await detectLocalCli("agy", {
      ...MAC,
      pathLookup: async () => null,
      exists: (x) => x === "/opt/homebrew/bin/agy",
    });
    expect(p).toBe("/opt/homebrew/bin/agy");
  });
  it("PATH 与目录都没有 → null(由调用方给明确错误)", async () => {
    const p = await detectLocalCli("codex", {
      ...WIN,
      pathLookup: async () => null,
      exists: () => false,
    });
    expect(p).toBeNull();
  });
});

describe("detectCliForBackend", () => {
  it("非本地后端(anthropic)→ path: null,不做任何检测", async () => {
    expect(await detectCliForBackend("anthropic")).toEqual({ path: null });
  });
  it("未知字符串 → path: null(渲染层传错也不炸)", async () => {
    expect(await detectCliForBackend("nonsense")).toEqual({ path: null });
  });
});
