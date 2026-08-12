// packages/eval/test/explore.baseline.test.ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import {
  baselineToCards,
  readActiveAnalysisResult,
} from "../src/explore/baselineFindings";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  pickRows,
  splitTeams,
} from "../src/explore/storeAccess";

function writeDoc(dir: string, id: string, file: string, doc: unknown) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, file), JSON.stringify(doc));
}
const finding = {
  eventIds: ["e1"],
  severity: "high",
  category: "cc",
  title: "T",
  explanation: "E",
};

describe("readActiveAnalysisResult", () => {
  it("reads v2 envelope via lastSlotKey", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    writeDoc(dir, "m1", "analysis-v2.zh.json", {
      schemaVersion: 2,
      language: "zh",
      lastSlotKey: "cli:claude",
      slots: {
        "cli:claude": {
          promptVersion: 3,
          createdAt: 1,
          result: { findings: [finding], dropped: 0, hadNarration: false },
        },
      },
    });
    expect(readActiveAnalysisResult(dir, "m1", "zh")?.findings).toHaveLength(1);
  });
  it("reads v1 legacy envelope and falls back zh→en→bare", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    writeDoc(dir, "m1", "analysis-v2.json", {
      schemaVersion: 1,
      promptVersion: 3,
      createdAt: 1,
      result: { findings: [finding], dropped: 0, hadNarration: false },
    });
    expect(readActiveAnalysisResult(dir, "m1", "zh")?.findings).toHaveLength(1);
  });
  it("returns null when no cache exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    mkdirSync(join(dir, "m1"));
    expect(readActiveAnalysisResult(dir, "m1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// baselineToCards — anchorT/unitNames derivation
// ---------------------------------------------------------------------------

// Same minimal synthetic combat shape `candidateFindings.test.ts` uses: one
// Friendly death (spec 256 = Priest_Discipline, a healer) and one Hostile
// death. `extractCandidateFindings` emits `death:a:30` / `death:b:45` for it.
function combat(): any {
  return {
    startTime: 0,
    endTime: 60000,
    playerId: "a",
    units: {
      a: {
        id: "a",
        name: "Me-R",
        type: 1,
        reaction: 1,
        spec: "256",
        deathRecords: [{ timestamp: 30000 }],
        spellCastEvents: [],
        advancedActions: [],
        info: { teamId: "0" },
      },
      b: {
        id: "b",
        name: "Enemy-R",
        type: 1,
        reaction: 2,
        spec: "577",
        deathRecords: [{ timestamp: 45000 }],
        spellCastEvents: [],
        advancedActions: [],
        info: { teamId: "1" },
      },
    },
  };
}

describe("baselineToCards — anchorT/unitNames derivation", () => {
  it("prefers min(deepDive.chips[].t) when chips are present", () => {
    const withChips: Finding = {
      eventIds: ["death:a:30"],
      severity: "high",
      category: "survival",
      title: "T",
      explanation: "E",
      deepDive: {
        text: "narration",
        chips: [
          { t: 45, label: "a", unitNames: ["Me-R"] },
          { t: 30, label: "b", unitNames: ["Enemy-R"] },
        ],
      },
    };
    const [card] = baselineToCards([withChips], combat(), undefined);
    expect(card.anchorT).toBe(30);
  });

  it("falls back to the min t of matched candidate events when there are no chips", () => {
    const noChips: Finding = {
      eventIds: ["death:a:30"],
      severity: "high",
      category: "survival",
      title: "T",
      explanation: "E",
    };
    const [card] = baselineToCards([noChips], combat(), undefined);
    expect(card.anchorT).toBe(30);
    expect(card.unitNames).toEqual(["Me-R"]);
    expect(card.evidence).toHaveLength(1);
    expect(card.evidence[0].cmd).toBe("flow --from 25 --to 35");
  });

  it("floors a fractional candidate-fallback anchorT/evidence window onto the render grid (toRenderSecond, not raw/Math.round)", () => {
    // death timestamp 30700ms → t=30.7s. `extractCandidateFindings` itself
    // rounds ITS id to the nearest second (`Math.round(30.7)` = 31, hence
    // `death:a:31` below) — that id-rounding is candidateFindings.ts's own
    // concern and out of scope here. What this test pins down is downstream
    // of that: before finding 3's fix, `anchorT` was the raw un-floored
    // `30.7` and `candidateEvidence`'s `tt` was `Math.round(30.7)` = 31
    // (→ "flow --from 26 --to 36"); after the fix both go through
    // `toRenderSecond` (floor), landing on 30 for both — the same instant a
    // reviewer sees rendered via `fmtTime` elsewhere, per CLAUDE.md's
    // shared-predicate rule.
    const fractional: Finding = {
      eventIds: ["death:a:31"],
      severity: "high",
      category: "survival",
      title: "T",
      explanation: "E",
    };
    const withFractionalDeath = combat();
    withFractionalDeath.units.a.deathRecords = [{ timestamp: 30700 }];
    const [card] = baselineToCards(
      [fractional],
      withFractionalDeath,
      undefined,
    );
    expect(card.anchorT).toBe(30);
    expect(card.evidence[0].cmd).toBe("flow --from 25 --to 35");
  });

  it("anchorT is 0 and unitNames is [] with no chips and no candidate match", () => {
    const noMatch: Finding = {
      eventIds: ["nonexistent-id"],
      severity: "low",
      category: "misc",
      title: "T",
      explanation: "E",
    };
    const [card] = baselineToCards([noMatch], combat(), undefined);
    expect(card.anchorT).toBe(0);
    expect(card.unitNames).toEqual([]);
    expect(card.evidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// real-library smoke — a match with an actual analysis cache is rare in the
// local library; skip cleanly (this.skip()) when none can be found instead of
// failing the run.
// ---------------------------------------------------------------------------

const hasLibrary = existsSync(join(DEFAULT_MATCH_DIR, "_index.ndjson"));

describe.skipIf(!hasLibrary)("baselineToCards against real library", () => {
  it("converts a real match's analysis cache without throwing", (ctx) => {
    const rows = pickRows(loadIndex(DEFAULT_MATCH_DIR), { minDurationS: 60 });
    const row = rows.find(
      (r) =>
        ["zh", "en"].some((lang) =>
          existsSync(join(DEFAULT_MATCH_DIR, r.id, `analysis-v2.${lang}.json`)),
        ) || existsSync(join(DEFAULT_MATCH_DIR, r.id, "analysis-v2.json")),
    );
    if (!row) {
      ctx.skip();
      return;
    }
    const cached = readActiveAnalysisResult(DEFAULT_MATCH_DIR, row.id);
    if (!cached) {
      ctx.skip();
      return;
    }
    const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, row.id);
    const { owner } = splitTeams(legacy);
    expect(() => baselineToCards(cached.findings, legacy, owner)).not.toThrow();
  });
});
