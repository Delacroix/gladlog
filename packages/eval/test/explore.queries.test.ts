// packages/eval/test/explore.queries.test.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  cdAvailableAt,
  ensureAnalysisData,
  type IMajorCooldownInfo,
  parseRawStreams,
} from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import { remainingCdSeconds, runQuery } from "../src/explore/matchExplore";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  pickRows,
  readRawText,
  splitTeams,
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

// remainingCdSeconds hand-copies cdAvailableAt's "most recent cast at/before
// t" lookup (no export exposes it) — per CLAUDE.md's shared-predicate
// fallback, pin the duplicate to the real predicate with an equality test
// instead of a comment, so a future boundary/charge change in cooldowns.ts
// turns this red.
describe("remainingCdSeconds parity with cdAvailableAt", () => {
  const cd: Pick<
    IMajorCooldownInfo,
    "casts" | "cooldownSeconds" | "neverUsed"
  > = {
    casts: [{ timeSeconds: 10 }],
    cooldownSeconds: 120,
    neverUsed: false,
  };

  it("agrees with cdAvailableAt's sign across before/at/mid/expiry/after boundaries", () => {
    // before first cast, exactly at cast time, mid-cooldown, exactly at
    // expiry (10+120=130), just after expiry, well after expiry.
    for (const t of [5, 10, 70, 130, 131, 200]) {
      expect(remainingCdSeconds(cd, t) <= 0).toBe(cdAvailableAt(cd, t));
    }
  });

  it("agrees with cdAvailableAt for the neverUsed case (always available)", () => {
    const neverUsed: Pick<
      IMajorCooldownInfo,
      "casts" | "cooldownSeconds" | "neverUsed"
    > = { casts: [], cooldownSeconds: 60, neverUsed: true };
    for (const t of [0, 30, 1000]) {
      expect(remainingCdSeconds(neverUsed, t) <= 0).toBe(
        cdAvailableAt(neverUsed, t),
      );
    }
  });

  it("pins exact 还剩 Ns arithmetic, not just its sign", () => {
    // cast at t=10, 120s cd → at t=70, 60s remain.
    expect(remainingCdSeconds(cd, 70)).toBe(60);
    const shortCd: Pick<
      IMajorCooldownInfo,
      "casts" | "cooldownSeconds" | "neverUsed"
    > = { casts: [{ timeSeconds: 0 }], cooldownSeconds: 30, neverUsed: false };
    // cast at t=0, 30s cd → at t=10, 20s remain.
    expect(remainingCdSeconds(shortCd, 10)).toBe(20);
  });
});

const hasLibrary = existsSync(join(DEFAULT_MATCH_DIR, "_index.ndjson"));

describe.skipIf(!hasLibrary)("runQuery against real library", () => {
  it("all 10 subcommands run clean on a real >120s round (mana/drink exercise the real raw.txt path via readRawText+parseRawStreams, same as the CLI shell)", async () => {
    await ensureAnalysisData();
    const rows = pickRows(loadIndex(DEFAULT_MATCH_DIR), { minDurationS: 121 });
    expect(rows.length).toBeGreaterThan(0);
    const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, rows[0].id);
    const fromS = 10;
    const toS = 100;
    const midT = 60;

    // Same load path scripts/matchExplore.ts's CLI shell uses for `mana`/
    // `drink`: readRawText (matchesDir-relative, null on missing/unreadable)
    // + parseRawStreams(text, legacy.startTime). Real raw.txt may or may not
    // be present for whichever match `pickRows` happens to surface first —
    // either way `parseRawStreams` degrades gracefully (available:false),
    // so the smoke assertions below hold regardless; a second assertion
    // further down additionally exercises the real-data branch WHEN raw.txt
    // is actually present for this row.
    const rawText = readRawText(DEFAULT_MATCH_DIR, rows[0].id);
    const rawStreams = parseRawStreams(rawText, legacy.startTime);
    const { friends } = splitTeams(legacy);
    const unitName = friends[0]?.name ?? "";

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
      [
        "mana",
        "--unit",
        unitName,
        "--from",
        String(fromS),
        "--to",
        String(toS),
      ],
      ["drink"],
    ];

    for (const argv of cases) {
      const lines = runQuery(legacy, argv, rawStreams);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    }

    const posOut = runQuery(legacy, ["pos", "--t", String(midT)], rawStreams);
    for (const line of posOut.slice(1)) {
      expect(line).toMatch(/dist [\d.]+yd|未知/);
    }

    if (rawStreams.available) {
      // Real raw.txt was present for this row — confirm `mana` actually
      // walked it (didn't silently fall back to the NO_RAW line) so this
      // test is a real exercise of the raw-parsing path, not just a
      // graceful-degradation no-op.
      const manaOut = runQuery(
        legacy,
        [
          "mana",
          "--unit",
          unitName,
          "--from",
          String(fromS),
          "--to",
          String(toS),
        ],
        rawStreams,
      );
      expect(manaOut.some((l) => l.includes("raw.txt"))).toBe(false);
    }
  });
});
