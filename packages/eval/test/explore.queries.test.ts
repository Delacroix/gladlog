// packages/eval/test/explore.queries.test.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureAnalysisData } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import { runQuery } from "../src/explore/matchExplore";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  pickRows,
} from "../src/explore/storeAccess";

const emptyLegacy = {
  startTime: 1_000_000,
  endTime: 1_180_000,
  startInfo: { zoneId: "1672" },
  units: {},
} as any;

describe("runQuery dispatch", () => {
  it("rejects unknown subcommand with usage", () => {
    expect(() => runQuery(emptyLegacy, ["nope"])).toThrow(/usage/);
  });
  it("requires --t for cd", () => {
    expect(() => runQuery(emptyLegacy, ["cd"])).toThrow(/usage/);
  });
  it("floors fractional seconds to the render grid", () => {
    // 空对局也要输出表头行,且表头时刻是 floor 后的渲染秒
    const lines = runQuery(emptyLegacy, ["cd", "--t", "93.9"]);
    expect(lines[0]).toContain("1:33"); // fmtTime(93), not 1:34
  });
});

const hasLibrary = existsSync(join(DEFAULT_MATCH_DIR, "_index.ndjson"));

describe.skipIf(!hasLibrary)("runQuery against real library", () => {
  it("all 8 subcommands run clean on a real >120s round", async () => {
    await ensureAnalysisData();
    const rows = pickRows(loadIndex(DEFAULT_MATCH_DIR), { minDurationS: 121 });
    expect(rows.length).toBeGreaterThan(0);
    const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, rows[0].id);
    const fromS = 10;
    const toS = 100;
    const midT = 60;

    const cases: string[][] = [
      ["overview"],
      ["cd", "--t", String(midT)],
      ["hp", "--t", String(midT)],
      ["hpcurve", "--from", String(fromS), "--to", String(toS), "--step", "10"],
      ["auras", "--t", String(midT)],
      ["pos", "--t", String(midT)],
      ["dr", "--from", String(fromS), "--to", String(toS)],
      ["flow", "--from", String(fromS), "--to", String(toS)],
      ["gaps"],
    ];

    for (const argv of cases) {
      const lines = runQuery(legacy, argv);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    }

    const posOut = runQuery(legacy, ["pos", "--t", String(midT)]);
    for (const line of posOut.slice(1)) {
      expect(line).toMatch(/dist [\d.]+yd|未知/);
    }
  });
});
