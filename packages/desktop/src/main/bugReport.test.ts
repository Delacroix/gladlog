import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { createBugReport, resolveBugReportRoot } from "./bugReport";

const T0 = 1_750_000_000_000;

function setup(withSyncDir: boolean) {
  const home = mkdtempSync(join(tmpdir(), "gladlog-bug-home-"));
  const userData = mkdtempSync(join(tmpdir(), "gladlog-bug-ud-"));
  if (withSyncDir) mkdirSync(join(home, "gladlog-sync"));
  const matchesDir = join(userData, "matches");
  mkdirSync(join(matchesDir, "m1"), { recursive: true });
  writeFileSync(join(matchesDir, "m1", "raw.txt"), "RAW LOG LINES\n");
  return { home, userData, matchesDir };
}

const AI = [
  {
    kind: "analysis",
    matchId: "m1",
    at: T0,
    model: "x",
    prompt: "P1",
    raw: "R1",
  },
  {
    kind: "analysis",
    matchId: "m2",
    at: T0,
    model: "x",
    prompt: "P2",
    raw: "R2",
  },
] as never[];

describe("bugReport(2026-08-02 用户需求)", () => {
  it("有 gladlog-sync:落同步盘 bugreports(写入即上传),打包 raw + 本场 AI 证据 + comment", () => {
    const { home, userData, matchesDir } = setup(true);
    const r = createBugReport({
      input: { matchId: "m1", roundSeq: 3, comment: "教练又乱怪我" },
      matchesDir,
      getMeta: (id) => (id === "m1" ? { bracket: "3v3" } : null),
      appVersion: "0.1.19",
      platform: "win32",
      homeDir: home,
      userDataDir: userData,
      aiEntries: AI,
      now: () => T0,
    });
    expect(r.synced).toBe(true);
    expect(r.dir.startsWith(join(home, "gladlog-sync", "bugreports"))).toBe(
      true,
    );
    const report = JSON.parse(readFileSync(join(r.dir, "report.json"), "utf8"));
    expect(report.comment).toBe("教练又乱怪我");
    expect(report.roundSeq).toBe(3);
    expect(report.matchMeta).toEqual({ bracket: "3v3" });
    // AI 证据只带本场(m2 的不混入)
    expect(report.aiCalls).toHaveLength(1);
    expect(report.aiCalls[0].prompt).toBe("P1");
    expect(readFileSync(join(r.dir, "match-raw.txt"), "utf8")).toBe(
      "RAW LOG LINES\n",
    );
  });

  it("无同步盘:退 userData/bugreports,synced=false;无 matchId 也能报(全量 AI 证据,无 raw)", () => {
    const { home, userData, matchesDir } = setup(false);
    const r = createBugReport({
      input: { matchId: null, roundSeq: null, comment: "app 打不开录像" },
      matchesDir,
      getMeta: () => null,
      appVersion: "0.1.19",
      platform: "darwin",
      homeDir: home,
      userDataDir: userData,
      aiEntries: AI,
      now: () => T0,
    });
    expect(r.synced).toBe(false);
    expect(r.dir.startsWith(join(userData, "bugreports"))).toBe(true);
    const report = JSON.parse(readFileSync(join(r.dir, "report.json"), "utf8"));
    expect(report.aiCalls).toHaveLength(2);
    expect(existsSync(join(r.dir, "match-raw.txt"))).toBe(false);
  });

  it("resolveBugReportRoot:同步盘存在与否决定落点", () => {
    const { home, userData } = setup(true);
    expect(
      resolveBugReportRoot({ homeDir: home, userDataDir: userData }).synced,
    ).toBe(true);
    const bare = setup(false);
    expect(
      resolveBugReportRoot({ homeDir: bare.home, userDataDir: bare.userData })
        .synced,
    ).toBe(false);
  });
});
