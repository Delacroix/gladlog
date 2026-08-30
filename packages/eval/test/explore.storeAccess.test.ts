// packages/eval/test/explore.storeAccess.test.ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAnalysisData } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  overviewLines,
  pickRows,
  readRawText,
  splitTeams,
} from "../src/explore/storeAccess";

function tmpStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-store-"));
  const rows = [
    {
      id: "aaa",
      kind: "match",
      durationS: 300,
      playerName: "Me-Realm",
      startTime: 100,
    },
    {
      id: "aaa",
      kind: "match",
      durationS: 301,
      playerName: "Me-Realm",
      startTime: 100,
    }, // dup, last wins
    { id: "bbb", kind: "shuffle", durationS: 90, startTime: 200 },
    { id: "ccc", kind: "match", durationS: 150, startTime: 300 },
  ];
  writeFileSync(
    join(dir, "_index.ndjson"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  mkdirSync(join(dir, "aaa"));
  return dir;
}

describe("storeAccess", () => {
  it("loadIndex dedupes by id, last write wins", () => {
    const rows = loadIndex(tmpStore());
    expect(rows.map((r) => r.id).sort()).toEqual(["aaa", "bbb", "ccc"]);
    expect(rows.find((r) => r.id === "aaa")?.durationS).toBe(301);
  });

  it("pickRows filters by duration and sorts newest first", () => {
    const rows = pickRows(loadIndex(tmpStore()), { minDurationS: 120 });
    expect(rows.map((r) => r.id)).toEqual(["ccc", "aaa"]); // bbb 90s dropped
  });
});

describe("readRawText (BACKLOG #26 Task 5)", () => {
  it("reads <matchesDir>/<matchId>/raw.txt when present", () => {
    const dir = tmpStore();
    writeFileSync(join(dir, "aaa", "raw.txt"), "hello raw log\n");
    expect(readRawText(dir, "aaa")).toBe("hello raw log\n");
  });

  it("returns null (never throws) when raw.txt is missing — same contract as parseRawStreams(null, ...)", () => {
    const dir = tmpStore(); // "aaa" dir exists but has no raw.txt written into it
    expect(readRawText(dir, "aaa")).toBeNull();
  });

  it("returns null for a matchId whose directory doesn't exist at all", () => {
    const dir = tmpStore();
    expect(readRawText(dir, "no-such-match")).toBeNull();
  });
});

const hasLibrary = existsSync(join(DEFAULT_MATCH_DIR, "_index.ndjson"));

describe.skipIf(!hasLibrary)("storeAccess against real library", () => {
  it("loads a real round and renders an overview", async () => {
    await ensureAnalysisData();
    const rows = pickRows(loadIndex(DEFAULT_MATCH_DIR), { minDurationS: 120 });
    expect(rows.length).toBeGreaterThan(0);
    const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, rows[0].id);
    const teams = splitTeams(legacy);
    expect(teams.friends.length).toBeGreaterThan(0);
    const lines = overviewLines(legacy, rows[0]);
    expect(lines.some((l) => /\d:\d\d/.test(l))).toBe(true);
  });
});

describe.skipIf(!hasLibrary)(
  "loadLegacyRound.analysisId — a shuffle round's cache id is the ROUND id (GH #18 bench fix, 2026-08-30)",
  () => {
    it("round 0 shares the storage id; round 1 does not", () => {
      const shuffle = loadIndex(DEFAULT_MATCH_DIR).find(
        (r) => r.kind === "shuffle" && (r.durationS ?? 0) > 300,
      );
      if (!shuffle) return; // library without a multi-round shuffle: nothing to pin
      const r0 = loadLegacyRound(DEFAULT_MATCH_DIR, shuffle.id, 0);
      expect(r0.kind).toBe("shuffle");
      expect(r0.analysisId).toBe(shuffle.id);
      const r1 = loadLegacyRound(DEFAULT_MATCH_DIR, shuffle.id, 1);
      expect(r1.analysisId).not.toBe(shuffle.id);
      expect(r1.analysisId.length).toBeGreaterThan(0);
      const plain = loadIndex(DEFAULT_MATCH_DIR).find(
        (r) => r.kind === "match",
      );
      if (plain) {
        expect(loadLegacyRound(DEFAULT_MATCH_DIR, plain.id).analysisId).toBe(
          plain.id,
        );
      }
    });
  },
);
