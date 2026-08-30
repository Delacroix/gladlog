# Unlimited Token Deep Dive Ceiling Experiment + Review Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verification CLI (wrapping existing predicates) + review session builder/machine pre-screen + dev:ui review workbench to support the ceiling experiment of "strongest model conducting multi-turn autonomous deep dives on a match → human performing blind item-by-item evaluation under full combat report context".

**Architecture:** Research-side code all goes into `packages/eval` (`src/explore/` holds logic, `scripts/` acts as thin shells); review UI lives in `packages/desktop/dev/` harness (adding `?review=` mode + vite dev middleware for persisting annotations); the only change to product src is adding a lazy optional prop `externalSeek` to `MatchReport` (externally driven replay jump).

**Tech Stack:** tsx CLI (ESM), existing `@gladlog/analysis` predicates (deep path imports, without modifying analysis package), Vite dev middleware, React (dev harness).

**Spec:** `docs/superpowers/specs/2026-08-12-unlimited-deepdive-review-design.md`

## Global Constraints

- **House rule: Predicate is the spec**: do not write new sampling logic, only wrap existing `@gladlog/analysis` exports; all timestamps must be `toRenderSecond()` (= `Math.floor`) before sampling. Deep path imports (`@gladlog/analysis/src/utils/...`) are existing convention (see `packages/eval/test/predicateIndex.test.ts`), `momentSnapshot`/`getUnitRawPositionAtTime` have no public export paths, always use deep imports **without modifying analysis index.ts**.
- eval must never import `@gladlog/desktop`; match conversion always uses `toLegacyMatch({ ...m, rawLines: [] })` (convention annotated in `packages/eval/scripts/momentDiveAb.ts`).
- eval `scripts/` are not in typecheck scope — logic must be in `packages/eval/src/`, scripts only do arg parsing + invocation.
- Prior to consuming any predicate, run `await ensureAnalysisData()` (from `@gladlog/analysis`).
- On desktop side before push: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet` (eslint must scan entire repo, not just src). Never run `test:visual` locally.
- Review workbench does not enter visual baselines (no scene added, uses independent `?review=` mode).
- Port uses `VISUAL_PORT` from `dev/ports.ts`, never hardcode 5199.
- Direct commit + push to main (user's established workflow); one commit per task.
- Persisted files all use atomic tmp+rename writes (repo discipline).
- `docs/commands/*.md` not in bilingual pairing list, monolingual is acceptable.

## Data Contract (Shared across entire plan)

Under `$GLADLOG_EVAL_HOME/review-sessions/`, per experiment `<name>`:

- `<name>.deep.json` — Deep dive agent manual output: `DeepFindingInput[]`
- `<name>.session.json` — `ReviewSession` (builder output, containing pre-screen verdicts and randomized cards)
- `<name>.answers.json` — `ReviewAnswers` (workbench persisted output)

Single source of types: `packages/eval/src/explore/reviewTypes.ts` (dev harness imports via relative path, vite serves within workspace via `/@fs/` without config).

---

### Task 1: Match Store Access + `pick`/`overview` (eval)

**Files:**

- Create: `packages/eval/src/explore/storeAccess.ts`
- Test: `packages/eval/test/explore.storeAccess.test.ts`

**Interfaces:**

- Produces:
  - `DEFAULT_MATCH_DIR: string`
  - `loadIndex(matchesDir: string): StoredMetaRow[]` (`StoredMetaRow = { id: string; kind?: "match" | "shuffle"; durationS?: number; playerName?: string; result?: string; startTime?: number; bracket?: string }`)
  - `pickRows(rows: StoredMetaRow[], opts: { minDurationS: number }): StoredMetaRow[]` (duration filtering + sorted newest to oldest by startTime)
  - `loadLegacyRound(matchesDir: string, matchId: string, roundSeq?: number): { legacy: LegacyRound; kind: "match" | "shuffle"; roundSeq?: number }` (`type LegacyRound = ReturnType<typeof toLegacyMatch>`)
  - `splitTeams(legacy: LegacyRound): { friends: ICombatUnit[]; enemies: ICombatUnit[]; owner: ICombatUnit | undefined }`
  - `overviewLines(legacy: LegacyRound, meta?: StoredMetaRow): string[]`

Reference implementation: `packages/eval/scripts/momentDiveAb.ts` for `loadIndex` (reading `_index.ndjson`, deduping by id where last write wins), round extraction (`doc.data.rounds` vs `[doc.data]`), `findOwner` (playerId + Friendly, falling back to friendly healer). `splitTeams` filters by `unit.reaction === CombatUnitReaction.Friendly / .Hostile` for player units only (following momentDiveAb pattern). `overviewLines` outputs: 1 line per unit (`Name Team [Deaths: 1:23, …]`, deaths read defensively from `unit.deathRecords ?? []`) + 1 line `Duration m:ss` (`renderedWindowSeconds(0, (endTime-startTime)/1000)` + `fmtTime`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/explore.storeAccess.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadIndex, pickRows } from "../src/explore/storeAccess";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @gladlog/eval run test -- explore.storeAccess`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `storeAccess.ts`** (following momentDiveAb pattern; inside `loadLegacyRound`, `toLegacyMatch({ ...roundData, rawLines: [] })`, for shuffle takes `doc.data.rounds[roundSeq]`, default 0)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @gladlog/eval run test -- explore.storeAccess`
Expected: PASS

- [ ] **Step 5: Real library integration smoke (skip-if-missing)** — append to same test file:

```ts
import { existsSync } from "node:fs";
import {
  DEFAULT_MATCH_DIR,
  loadLegacyRound,
  overviewLines,
  splitTeams,
} from "../src/explore/storeAccess";
import { ensureAnalysisData } from "@gladlog/analysis";

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
```

Run: `npm -w @gladlog/eval run test -- explore.storeAccess` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/storeAccess.ts packages/eval/test/explore.storeAccess.test.ts
git commit -m "feat(eval): matchExplore foundation -- match library read / match pick filtering / overview lines"
```

---

### Task 2: Verification Query Set (cd / hp / auras / pos / dr / flow / gaps) + Unified Dispatch

**Files:**

- Create: `packages/eval/src/explore/matchExplore.ts`
- Test: `packages/eval/test/explore.queries.test.ts`

**Interfaces:**

- Consumes: Task 1 `LegacyRound`, `splitTeams`.
- Produces:
  - `cdLines(legacy, t: number): string[]` — 1 line per player: `{fmtTime(tt)} {name} ready: A,B | onCd: C(rem Ns)`
  - `hpLines(legacy, t: number): string[]`, `hpCurveLines(legacy, fromS, toS, stepS): string[]`
  - `auraLines(legacy, t: number): string[]`
  - `posLines(legacy, t: number): string[]` — owner <-> each unit: `dist 12.3yd | LoS clear/blocked/unknown`
  - `drLines(legacy, fromS, toS): string[]` — bidirectional CC chains, 1 line per application in window
  - `flowLines(legacy, fromS, toS): string[]` — directly forwards `buildCastFlowLines`
  - `gapLines(legacy): string[]` — `detectHealingGaps` + `formatHealingGapsForContext`
  - `runQuery(legacy: LegacyRound, argv: string[]): string[]` — dispatch: `argv[0]` in overview|cd|hp|hpcurve|auras|pos|dr|flow|gaps, followed by `--t/--from/--to/--step`; invalid subcommand/missing args throw `Error("usage: …")`. **This is the shared predicate between pre-screening and CLI**.

Predicate bindings:

| Query | Predicate | Import Path |
| --- | --- | --- |
| cd | `extractMajorCooldowns(unit, combat)` + `cdAvailableAt(cd, tSeconds)` | `@gladlog/analysis` |
| hp | `getHpPercentAtTime(unit, atSeconds, matchStartMs)` (null -> `No sample`) | `@gladlog/analysis` |
| auras | `aurasActiveAt(unit, combat, t)` | `@gladlog/analysis/src/analysis/momentSnapshot` |
| pos distance | `getUnitPositionAtTime(unit, tMs, INTERP_MAX_GAP_MS)` + `distanceBetween` | `@gladlog/analysis` (constant from `positionSampling`) |
| pos LoS | `getUnitRawPositionAtTime(unit, tMs, LOS_SWEEP_GAP_MS)` + `hasLineOfSight(zoneId, a, b)`, null -> `Unknown` (never false) | `@gladlog/analysis/src/utils/losAnalysis` (raw version lacks public export) |
| dr | `analyzeOutgoingCCChains(friends, enemies, combat)` forward & reverse | `@gladlog/analysis` |
| flow | `buildCastFlowLines(combat, fromS, toS)` | `@gladlog/analysis/src/analysis/momentSnapshot` |
| gaps | `detectHealingGaps(healer, friends, enemies, combat)` + `formatHealingGapsForContext`, healer=friendly `isHealerSpec` | `@gladlog/analysis` |

All input timestamps must be floored via `toRenderSecond()` first; `tMs = legacy.startTime + toRenderSecond(t) * 1000`; `zoneId` from `legacy.startInfo.zoneId`. For `dr`: check `packages/analysis/src/utils/drAnalysis.ts:441` for actual `IOutgoingCCChain` field names (1 line per application: timestamp / caster / target / spell / DR tier / actual duration).

- [ ] **Step 1: Write the failing test** (pure logic portion)

```ts
// packages/eval/test/explore.queries.test.ts
import { describe, expect, it } from "vitest";
import { runQuery } from "../src/explore/matchExplore";

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
    const lines = runQuery(emptyLegacy, ["cd", "--t", "93.9"]);
    expect(lines[0]).toContain("1:33"); // fmtTime(93), not 1:34
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @gladlog/eval run test -- explore.queries`
Expected: FAIL

- [ ] **Step 3: Implement `matchExplore.ts`** (table structure as above; each query outputs header line `## cd @ 1:33` for easy referencing; unit iteration uses `splitTeams`, outputs `(no data)` line instead of empty array when empty)

- [ ] **Step 4: Run pure tests to verify they pass**

- [ ] **Step 5: Real library integration smoke** — append `describe.skipIf(!hasLibrary)`: run all 8 subcommands against first real match >120s, assert each returns >=1 line without throwing; assert each line of `pos` matches `/dist [\d.]+yd|Unknown/`.

Run: `npm -w @gladlog/eval run test -- explore.queries`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/matchExplore.ts packages/eval/test/explore.queries.test.ts
git commit -m "feat(eval): matchExplore 8 verification queries with single-source runQuery dispatch"
```

---

### Task 3: CLI Thin Shell `scripts/matchExplore.ts`

**Files:**

- Create: `packages/eval/scripts/matchExplore.ts`

**Interfaces:**

- Consumes: `loadIndex/pickRows/loadLegacyRound/overviewLines/runQuery`, `ensureAnalysisData`.
- Produces: CLI commands (for deep dive agent use):
  - `npx tsx packages/eval/scripts/matchExplore.ts pick [--min-duration 120] [--store <dir>]` — Table: id / kind / duration / playerName / result / bracket
  - `npx tsx packages/eval/scripts/matchExplore.ts <matchId> [--round N] [--store <dir>] <sub> [--t X | --from A --to B [--step S]]` — forwards `runQuery`

- [ ] **Step 1: Implement** (`parseArgs` from `node:util`, `allowPositionals: true`; top-level `await ensureAnalysisData()`; errors via `console.error(usage); process.exit(1)`)

- [ ] **Step 2: Manual smoke**

```bash
npx tsx packages/eval/scripts/matchExplore.ts pick | head -5
ID=$(npx tsx packages/eval/scripts/matchExplore.ts pick | awk 'NR==2{print $1}')
npx tsx packages/eval/scripts/matchExplore.ts "$ID" overview
npx tsx packages/eval/scripts/matchExplore.ts "$ID" cd --t 60
```

Expected: All 3 commands produce output with exit code 0.

- [ ] **Step 3: Commit**

```bash
git add packages/eval/scripts/matchExplore.ts
git commit -m "feat(eval): matchExplore CLI thin shell (pick + query forwarding)"
```

---

### Task 4: Review Types + Baseline Findings Transformation

**Files:**

- Create: `packages/eval/src/explore/reviewTypes.ts`
- Create: `packages/eval/src/explore/baselineFindings.ts`
- Test: `packages/eval/test/explore.baseline.test.ts`

**Interfaces:**

- Produces (`reviewTypes.ts`, imported by dev harness as well):

```ts
export interface EvidenceRef {
  cmd: string;
  line: string;
} // cmd = runQuery argv string, e.g. "cd --t 93"
export interface DeepFindingInput {
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: EvidenceRef[];
  severity: "high" | "med" | "low";
}
export type PrescreenVerdict = "verified" | "mismatch" | "unverifiable";
export interface ReviewCard {
  cardId: string;
  source: "deep" | "baseline";
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: Array<EvidenceRef & { verdict: PrescreenVerdict }>;
}
export interface ReviewSession {
  schemaVersion: 1;
  name: string;
  matchId: string;
  roundSeq?: number;
  createdAt: number;
  cards: ReviewCard[];
}
export interface ReviewAnswer {
  cardId: string;
  truth: "true" | "partial" | "false" | "cant-tell";
  awareness: "knew" | "vague" | "unaware";
  actionable: "concrete" | "generic" | "non-actionable";
  adopt: "yes" | "maybe" | "no";
  impact: "high" | "med" | "low" | "none";
  note: string;
  answeredAt: number;
}
export interface ReviewAnswers {
  schemaVersion: 1;
  name: string;
  answers: ReviewAnswer[];
}
```

- Produces (`baselineFindings.ts`):
  - `readActiveAnalysisResult(matchesDir: string, matchId: string, lang?: "zh" | "en"): { findings: Finding[] } | null` — Reads `analysis-v2.<lang>.json` (candidate search order: zh -> en -> no suffix, following `packages/desktop/src/main/analysis.ts:1225-1300`); envelope v2 takes `slots[lastSlotKey].result`, v1 takes `result`. **Reads JSON only, never imports desktop.**
  - `baselineToCards(findings: Finding[], legacy: LegacyRound, owner: ICombatUnit | undefined): Array<Omit<ReviewCard, "cardId" | "evidence"> & { evidence: EvidenceRef[] }>` — claim = `title — explanation` (appends `deepDive.text` if present); anchorT prioritizes `min(deepDive.chips[].t)`, otherwise cross-references candidates via `extractCandidateFindings` (following `packages/eval/scripts/archive/deepDiveScan.ts` pattern), taking minimum `t` of candidates matching `eventIds`; if neither exists -> anchorT = 0, unitNames = []. Evidence generated from matched candidate events: `{ cmd: "flow --from <t-5> --to <t+5>", line: candidateRenderedLine }`. Baseline cards default to `verified` as deterministic artifacts, short-circuited in Task 5 pre-screen.

- [ ] **Step 1: Write the failing test** (JSON envelope portion)

```ts
// packages/eval/test/explore.baseline.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActiveAnalysisResult } from "../src/explore/baselineFindings";

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
```

- [ ] **Step 2: Run test -> FAIL**; **Step 3: Implement**; **Step 4: Run test -> PASS**
- [ ] **Step 5: Anchor derivation unit tests**
- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/reviewTypes.ts packages/eval/src/explore/baselineFindings.ts packages/eval/test/explore.baseline.test.ts
git commit -m "feat(eval): review types single source + baseline analysis cache conversion (v1/v2 envelopes, chips anchors)"
```

---

### Task 5: Machine Pre-screen + Session Builder Script

**Files:**

- Create: `packages/eval/src/explore/buildSession.ts`
- Create: `packages/eval/scripts/buildReviewSession.ts`
- Test: `packages/eval/test/explore.buildSession.test.ts`

**Interfaces:**

- Consumes: Task 2 `runQuery`, Task 4 all.
- Produces (`buildSession.ts`):
  - `prescreen(evidence: EvidenceRef[], query: (argv: string[]) => string[]): Array<EvidenceRef & { verdict: PrescreenVerdict }>` — per item: `query(cmd.split(/\s+/))` throws -> `unverifiable`; output contains `line` (exact match after trim) -> `verified`; otherwise `mismatch`. `query` is injected for testing; in production passes `(argv) => runQuery(legacy, argv)`.
  - `seededShuffle<T>(items: T[], seed: string): T[]` — mulberry32(fnv1a(seed)), deterministic permutation per seed.
  - `buildSession(opts: { name: string; matchId: string; roundSeq?: number; deep: DeepFindingInput[]; legacy: LegacyRound; matchesDir: string }): ReviewSession` — deep cards pre-screened + baseline cards (short-circuiting `verified`) -> merged -> `seededShuffle(cards, name)` -> `cardId = "c" + index`.
- Produces (script): `npx tsx packages/eval/scripts/buildReviewSession.ts --name <name> --match <id> [--round N] [--store <dir>]` — reads `$GLADLOG_EVAL_HOME/review-sessions/<name>.deep.json`, writes `<name>.session.json`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/explore.buildSession.test.ts
import { describe, expect, it } from "vitest";
import { prescreen, seededShuffle } from "../src/explore/buildSession";

describe("prescreen", () => {
  const query = (argv: string[]) => {
    if (argv[0] !== "cd") throw new Error("usage");
    return ["## cd @ 1:33", "1:33 Foo ready: Divine Shield | onCd: Holy Light"];
  };
  it("verifies a line that the query reproduces", () => {
    const [r] = prescreen(
      [{ cmd: "cd --t 93", line: "1:33 Foo ready: Divine Shield | onCd: Holy Light" }],
      query,
    );
    expect(r.verdict).toBe("verified");
  });
  it("flags a line the query does not reproduce as mismatch", () => {
    const [r] = prescreen(
      [{ cmd: "cd --t 93", line: "1:33 Foo ready: Holy Light" }],
      query,
    );
    expect(r.verdict).toBe("mismatch");
  });
  it("flags an invalid cmd as unverifiable", () => {
    const [r] = prescreen([{ cmd: "nope --t 1", line: "x" }], query);
    expect(r.verdict).toBe("unverifiable");
  });
});

describe("seededShuffle", () => {
  it("is deterministic per seed and permutes", () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "s1");
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "s1")).toEqual(a);
    expect(a.slice().sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
```

- [ ] **Step 2: Run -> FAIL**; **Step 3: Implement `buildSession.ts`**; **Step 4: Run -> PASS**
- [ ] **Step 5: Implement script thin shell + manual smoke**
- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/buildSession.ts packages/eval/scripts/buildReviewSession.ts packages/eval/test/explore.buildSession.test.ts
git commit -m "feat(eval): machine pre-screen (runQuery single-source verification) + review session builder"
```

---

### Task 6: `MatchReport` External Seek Entry Point (Only Product src Modification)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (props area ~:75-104, `handleSeekEvent` area ~:145-174)
- Test: `packages/desktop/test/report.externalseek.test.tsx`

**Interfaces:**

- Produces: `MatchReport` new optional prop `externalSeek?: { tSeconds: number; unitNames: string[]; nonce: number } | null` (default null, zero changes if omitted). Consumption:

```tsx
useEffect(() => {
  if (!externalSeek) return;
  handleSeekEvent(externalSeek.tSeconds, externalSeek.unitNames);
}, [externalSeek?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 1: Write the failing test** (following `packages/desktop/test/report.evidenceseek.test.tsx` pattern)

```tsx
// packages/desktop/test/report.externalseek.test.tsx
it("externalSeek prop switches to replay view at the given time", async () => {
  const { rerender } = renderMatchReport({ externalSeek: null });
  rerender(
    withProps({ externalSeek: { tSeconds: 42, unitNames: ["Foo"], nonce: 1 } }),
  );
  await waitFor(() => {
    expect(
      document.querySelector(".rpt-view-tabs button.active")?.textContent,
    ).toContain("Replay");
  });
});
```

- [ ] **Step 2: Run -> FAIL** (`npm test --workspace=packages/desktop -- report.externalseek`)
- [ ] **Step 3: Implement** (prop + effect, <=10 lines)
- [ ] **Step 4: Run -> PASS**; full run `npm test --workspace=packages/desktop` confirming no regressions
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/test/report.externalseek.test.tsx
git commit -m "feat(desktop): MatchReport externalSeek controlled seek prop (lazy, for review workbench)"
```

---

### Task 7: Review API (Vite dev Middleware)

**Files:**

- Create: `packages/desktop/dev/review/reviewApi.ts`
- Modify: `packages/desktop/dev/vite.config.mts` (add to plugins array)
- Test: `packages/desktop/dev/review/reviewApi.test.ts`

**Interfaces:**

- Produces:
  - `reviewApiPlugin(opts?: { evalHome?: string; matchesDir?: string }): Plugin` — `configureServer` attaches `server.middlewares.use("/__review", handler)`. Dev mode only.
  - `handleReviewRequest(req: { method: string; url: string; body: string }, io: { readFile(p): string | null; writeFileAtomic(p, data): void; listDir(p): string[] }): { status: number; body: string }`
- Routes (all JSON):
  - `GET /__review/list` -> `{ sessions: string[] }`
  - `GET /__review/session/<name>` -> `<name>.session.json` content; 404 -> `{ error }`
  - `GET /__review/match/<id>` -> `<matchesDir>/<id>/match.json` content
  - `GET /__review/answers/<name>` -> `<name>.answers.json`, returns `{ schemaVersion: 1, name, answers: [] }` if missing
  - `POST /__review/answers/<name>` -> overwrites entire body (tmp+rename)
- Path safety: `<name>`/`<id>` must match `/^[A-Za-z0-9._-]+$/`, else 400.

- [ ] **Step 1: Write the failing test**

```ts
// packages/desktop/dev/review/reviewApi.test.ts
import { describe, expect, it } from "vitest";
import { handleReviewRequest } from "./reviewApi";

function memIo(files: Record<string, string> = {}) {
  return {
    files,
    readFile: (p: string) => files[p] ?? null,
    writeFileAtomic: (p: string, d: string) => {
      files[p] = d;
    },
    listDir: (p: string) =>
      Object.keys(files)
        .filter((f) => f.startsWith(p))
        .map((f) => f.slice(p.length + 1)),
  };
}

describe("handleReviewRequest", () => {
  it("answers roundtrip: POST then GET returns the same doc", () => {
    const io = memIo();
    const doc = JSON.stringify({ schemaVersion: 1, name: "exp1", answers: [] });
    expect(
      handleReviewRequest(
        { method: "POST", url: "/__review/answers/exp1", body: doc },
        io,
      ).status,
    ).toBe(200);
    const got = handleReviewRequest(
      { method: "GET", url: "/__review/answers/exp1", body: "" },
      io,
    );
    expect(JSON.parse(got.body)).toEqual(JSON.parse(doc));
  });
  it("missing session is 404", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/nope", body: "" },
        memIo(),
      ).status,
    ).toBe(404);
  });
  it("path traversal name is 400", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/..%2Fx", body: "" },
        memIo(),
      ).status,
    ).toBe(400);
  });
});
```

- [ ] **Step 2: Run -> FAIL** (`npm test --workspace=packages/desktop -- reviewApi`)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run -> PASS**; update `dev/vite.config.mts` plugins
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/dev/review/reviewApi.ts packages/desktop/dev/review/reviewApi.test.ts packages/desktop/dev/vite.config.mts
git commit -m "feat(desktop-dev): review API vite dev middleware (session / match / annotation read-write)"
```

---

### Task 8: `ReviewPanel` Component + Summary

**Files:**

- Create: `packages/desktop/dev/review/summary.ts`
- Create: `packages/desktop/dev/review/ReviewPanel.tsx`
- Test: `packages/desktop/dev/review/summary.test.ts`, `packages/desktop/dev/review/ReviewPanel.test.tsx`

**Interfaces:**

- Consumes: `reviewTypes` (relative import `../../../eval/src/explore/reviewTypes`).
- Produces (`summary.ts`):
  - `summarize(session: ReviewSession, answers: ReviewAnswer[]): { bySource: Record<"deep" | "baseline", { total: number; answered: number; novelValuable: number; dims: Record<string, Record<string, number>> }> }` — `novelValuable` defined as: `truth === "true" && awareness === "unaware" && (impact === "high" || impact === "med")`.
- Produces (`ReviewPanel.tsx`):

```tsx
export function ReviewPanel(props: {
  session: ReviewSession;
  answers: ReviewAnswer[]; // existing annotations
  onSave(answers: ReviewAnswer[]): void; // persisted on each answer (POST)
  onSeek(card: ReviewCard): void; // -> externalSeek
}): JSX.Element;
```

Behavior:
- Queue state: Progress `k/N`; current card shows claim, `fmtTime(anchorT)` timestamp badge (clicking invokes `onSeek`), evidence lines list (**displays `line` text only; verdict and source are never rendered during blind review**).
- 5 question rows with button groups (single selection with highlight): Truth [True / Partial / False / Can't tell], Awareness [Knew / Vague / Unaware], Actionable [Concrete / Generic / Non-actionable], Adopt [Yes / Maybe / No], Impact [High / Med / Low / None]; note in `<textarea>`; "Next" button enabled only when all 5 answered, assembling `ReviewAnswer` (`answeredAt: Date.now()`) calling `onSave` and advancing; supports "Previous" to amend answers.
- All answered -> Reveal view: `summarize` results table (deep vs baseline breakdown: total / verified novel discoveries / distribution across dimensions) + card-by-card list (revealing source badges and per-evidence verdict badges).
- Styles: inline `<style>` or `dev/harness.css` appended `.review-*` classes, **never modifying product `styles.css`**.

- [ ] **Step 1: Write failing tests**

```ts
// packages/desktop/dev/review/summary.test.ts
import { describe, expect, it } from "vitest";
import { summarize } from "./summary";
import type {
  ReviewAnswer,
  ReviewCard,
  ReviewSession,
} from "../../../eval/src/explore/reviewTypes";

const card = (cardId: string, source: "deep" | "baseline"): ReviewCard => ({
  cardId,
  source,
  claim: "c",
  anchorT: 10,
  unitNames: [],
  evidence: [],
});
const session: ReviewSession = {
  schemaVersion: 1,
  name: "s",
  matchId: "m",
  createdAt: 1,
  cards: [
    card("c0", "deep"),
    card("c1", "deep"),
    card("c2", "baseline"),
    card("c3", "baseline"),
  ],
};
const ans = (cardId: string, over: Partial<ReviewAnswer>): ReviewAnswer => ({
  cardId,
  truth: "true",
  awareness: "knew",
  actionable: "concrete",
  adopt: "yes",
  impact: "low",
  note: "",
  answeredAt: 1,
  ...over,
});

describe("summarize", () => {
  it("counts answered per source and novelValuable by the operational definition", () => {
    const answers = [
      ans("c0", { awareness: "unaware", impact: "med" }), // deep: novel & valuable
      ans("c1", { awareness: "unaware", impact: "low" }), // impact low, excluded
      ans("c2", { truth: "false", awareness: "unaware", impact: "high" }), // false, excluded
    ];
    const s = summarize(session, answers);
    expect(s.bySource.deep.answered).toBe(2);
    expect(s.bySource.deep.novelValuable).toBe(1);
    expect(s.bySource.baseline.answered).toBe(1);
    expect(s.bySource.baseline.novelValuable).toBe(0);
    expect(s.bySource.baseline.total).toBe(2);
  });
});
```

```tsx
// packages/desktop/dev/review/ReviewPanel.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";

describe("ReviewPanel", () => {
  it("gates next on all five answers and reports the answer", () => {
    const onSave = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={onSave}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toHaveProperty("disabled", true);
    for (const label of ["True", "Knew", "Concrete", "Yes", "Med"])
      fireEvent.click(screen.getByRole("button", { name: label }));
    expect(next).toHaveProperty("disabled", false);
    fireEvent.click(next);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0].cardId).toBe(
      twoCardSession.cards[0].cardId,
    );
  });

  it("seeks on anchor chip click and hides source until finished", () => {
    const onSeek = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={() => {}}
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByText("0:10")); // fmtTime(anchorT)
    expect(onSeek.mock.calls[0][0].cardId).toBe(twoCardSession.cards[0].cardId);
    expect(screen.queryByText(/baseline|deep/)).toBeNull(); // No source badge during blind review
  });

  it("shows reveal summary with source badges after all cards answered", () => {
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={fullAnswersForBoth}
        onSave={() => {}}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/Novel Verified Discoveries/)).toBeTruthy();
    expect(screen.getAllByText(/Deep Dive|Current Pipeline/).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run -> FAIL**; **Step 3: Implement**; **Step 4: Run -> PASS**
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/dev/review/summary.ts packages/desktop/dev/review/ReviewPanel.tsx packages/desktop/dev/review/summary.test.ts packages/desktop/dev/review/ReviewPanel.test.tsx
git commit -m "feat(desktop-dev): ReviewPanel 5-question cards + reveal summary (source/pre-screen hidden during blind review)"
```

---

### Task 9: `?review=` Mode Wiring + Real Device Walkthrough + Runbook

**Files:**

- Create: `packages/desktop/dev/review/ReviewMode.tsx`
- Modify: `packages/desktop/dev/main.tsx` (mode dispatch: scene first, review second, fallback to Harness)
- Create: `docs/commands/deepdive-probe.md`

**Interfaces:**

- Consumes: Task 6 `externalSeek`, Task 7 API, Task 8 `ReviewPanel`.
- Produces (`ReviewMode.tsx`):

```tsx
export function ReviewMode(props: { name: string }): JSX.Element;
```

Behavior:
1. `fetch("/__review/session/" + name)` -> `ReviewSession`; `fetch("/__review/match/" + session.matchId)` -> StoredMatch doc; for shuffle, takes `doc.data.rounds[…]` based on `session.roundSeq`; `fetch("/__review/answers/" + name)` -> existing annotations.
2. Layout: `display: flex`, left `<MatchReport source={…} matchId={session.matchId} externalSeek={seek} />` (`flex: 1`), right `<ReviewPanel …>` (fixed 380px, independently scrollable).
3. `onSeek(card) => setSeek({ tSeconds: card.anchorT, unitNames: card.unitNames, nonce: Date.now() })`; `onSave(answers) => fetch(POST /__review/answers/<name>)`.
4. Module-level mock: review mode reuses main.tsx slim mock, overriding `analysis.getState` with empty result (no fake findings in AI tab during blind review).

`main.tsx` dispatch: `const review = new URLSearchParams(window.location.search).get("review")`; if `scene` matches -> Scene; else if `review` is non-empty -> `<ReviewMode name={review} />`, else Harness. **Do not modify `scenes.ts`**.

- [ ] **Step 1: Implement `ReviewMode` + main.tsx wiring**

- [ ] **Step 2: Real device end-to-end walkthrough (run-ui flow)**

```bash
cd packages/desktop && npm run dev:ui
```

Using real session created in Task 5: open `http://localhost:5199/?review=<name>` in browser, verify:
1. Left side combat report renders real match correctly.
2. Right side 1/N cards and evidence lines visible without source/verdict badges.
3. Clicking timestamp badge switches to replay and jumps to anchor.
4. Refreshing page after answering card preserves progress (annotations read back).
5. Completing all cards displays reveal summary.
6. Content of `$GLADLOG_EVAL_HOME/review-sessions/<name>.answers.json` matches UI.

- [ ] **Step 3: Write `docs/commands/deepdive-probe.md`** (Chinese). Content must include:
  1. Pick match: `matchExplore pick` -> select match with user, >2 minutes, with deaths/turnarounds.
  2. Full deep dive agent opening prompt (copyable into new Claude Code session): role = deep dive using strongest model; tools = `matchExplore` subcommands table; discipline = overview read-through -> formulate hypothesis -> query data rows to verify -> stop after 2 rounds with no new findings; output format = `<name>.deep.json` `DeepFindingInput[]` full schema. **Each evidence `line` must be copied exactly from a query output, and `cmd` must match the query parameters**.
  3. Command sequence for build + review + reveal (Task 3/5 commands + `?review=` URL).
  4. Reference layer (non-judging): agy/Gemini independent review, 7-dimension judge execution, displayed side-by-side.
  5. Per-match wrap-up: append reveal summary (deep vs baseline verified discoveries, hallucinations, reference opinions) to `$GLADLOG_EVAL_HOME/ledger.md`.

- [ ] **Step 4: Pre-push full check**

```bash
npm test --workspace=packages/desktop && npm -w @gladlog/eval run test && npm run typecheck && npx eslint . --quiet
```

Expected: All green.

- [ ] **Step 5: Commit + push**

```bash
git add packages/desktop/dev/review/ReviewMode.tsx packages/desktop/dev/main.tsx docs/commands/deepdive-probe.md
git commit -m "feat(desktop-dev): ?review= review mode wiring + deep dive ceiling experiment runbook"
git push
```

---

## Definition of Done

Landing all code is only the foundation; the experiment itself (running 1 round) follows `docs/commands/deepdive-probe.md`, producing 3 deliverables: ceiling report, gold standard dataset (accumulated answers), and distillation candidates list. Before completing the first round, no conclusion is drawn on "whether deep dive is better" — **fixes require before/after numbers, experiments require item-by-item annotations**.
