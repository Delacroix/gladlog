# Window AI Analysis (backlog #16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the battle report view time window is active, one-click [AI Analyze Segment]: Selected segment evidence pack → window mode deep dive prompt → audit → inline result card; do not invoke the model if there is no signal, and bypass cache for results written to disk.

**Architecture:** Reuse the deep dive full pipeline. On the analysis side, add a `windowOverride` parameter to two pack-building functions (same collection code, zero extraction risk), add `buildWindowPack` (including signal gate hierarchy) and a neutral anchor constructor; add `mode:"window"` to the prompt. On the desktop main side, add an `analyzeWindow` IPC (single request-response + `windowAnalysis.<lang>.json` LRU cache + idempotency guard); on the renderer, add a button to the `MatchReport` toolbar + `WindowAnalysisCard` final state card.

**Tech Stack:** TypeScript, React, vitest, Electron IPC.

**Spec:** `docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md`
**Working Directory:** Always worktree `/Users/mingjianliu/code/gladlog-wt-16` (main; dependencies installed). Main checkout `/Users/mingjianliu/code/gladlog` is in use by user, **strictly do not touch**.

## Global Constraints

- Directly commit to worktree main and push eventually (project convention, no branch).
- Compound commands never use bare `cd` (use absolute paths or `(cd ... && ...)` subshells); no pipes in gate chains.
- Desktop tests always use `npm test --workspace=packages/desktop` (running single files directly bypasses configs causing artifacts, tripped 3 times in #15); analysis similarly workspace-scoped.
- Only pre-push gate is `npm run presubmit`; visual baseline CI single-source, never run `test:visual` locally.
- Predicate single source: window collection code is not duplicated — `windowOverride` parameter allows finding anchor and user window to use the **exact same code**. Anchor text timestamp is floored to render second first (house rule: predicate is the spec).
- Zero-signal path determined in renderer, **does not issue IPC nor call model**; empty result is valid output.
- main must never statically import deepDive values (prevents 13.6MB table entering main module graph) — following dynamic import precedent in `deepenInner`.

**Spec Deviations (Intentional, documented):** Spec stated "extract private collectPackItems"; this plan uses `windowOverride` optional parameter to achieve the same goal (reusing collection code) — replacing a 340-line mechanical extraction with ~15 lines of parameterization, reducing refactor risk by an order of magnitude while maintaining identical predicate single-source semantics. `windowPackGate` is folded into `buildWindowPack` return value (null = no signal), eliminating one exported surface.

---

### Task 1: analysis — windowOverride Parameterization + buildWindowPack + Neutral Anchor

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts` (buildDeepDivePack ~117-131, buildOffensiveDeepDivePack ~633-651, two new exports at file end)
- Modify: `packages/analysis/src/index.ts` (export new functions)
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts` (new)

**Interfaces:**

- Consumes: Existing `buildDeepDivePack/buildOffensiveDeepDivePack/hasCoachableSignal/hasOffensiveCoachableSignal/DeepDivePack/Finding`.
- Produces (consumed by Task 2/3/4):
  - `WindowOverride = { fromS: number; toS: number }` (exported type)
  - `buildDeepDivePack(combat, finding, findingIndex, candidates, ownerName?, windowOverride?)` (6th param optional, 0 breaking changes to existing calls)
  - `buildOffensiveDeepDivePack(...same 6th param...)`
  - `buildWindowPack(combat, fromS, toS, ownerName?): { pack: DeepDivePack; kind: "survival" | "offensive" } | null` (null = pack build failure or no coachable signal)
  - `buildWindowAnchorFinding(pack: DeepDivePack, fromS: number, toS: number, kind: "survival" | "offensive"): Finding` (deterministic neutral anchor)

- [ ] **Step 1: Write failing test**

`deepDive.window.test.ts` (combat fixture following `deepDive.test.ts` ~620-682 `mkUnit`/`combat`/`candidates`/`finding` structure):

```ts
import { describe, expect, it } from "vitest";
import {
  buildDeepDivePack,
  buildWindowAnchorFinding,
  buildWindowPack,
} from "./deepDive";
// …bring deepDive.test.ts mkUnit/combat/candidates/finding fixture (anchor at 100s / 105s match)…

describe("windowOverride equivalence", () => {
  it("same window: finding anchor pack and override pack are identical item-by-item", () => {
    const viaFinding = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
    );
    // finding anchor 100 -> window [70, 105] (PACK_BEFORE_S=30 / durS clamped 105)
    const viaOverride = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: 70, toS: 105 },
    );
    expect(viaOverride).not.toBeNull();
    expect(viaOverride!.items).toEqual(viaFinding!.items);
    expect(viaOverride!.facts).toEqual(viaFinding!.facts);
    expect(viaOverride!.anchorFrom).toBe(70);
    expect(viaOverride!.anchorTo).toBe(105);
  });

  it("override does not depend on finding.eventIds (synthetic empty anchor can also build pack)", () => {
    const synth = {
      eventIds: [],
      severity: "low",
      category: "window",
      title: "",
      explanation: "",
    } as Finding;
    const p = buildDeepDivePack(combat, synth, 0, [], "Owner-Area52", {
      fromS: 70,
      toS: 105,
    });
    expect(p).not.toBeNull(); // legacy behavior: empty eventIds -> null; override must bypass
  });

  it("window out of bounds clamped: fromS<0 -> 0, toS>durS -> durS", () => {
    const p = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: -5, toS: 999 },
    );
    expect(p!.anchorFrom).toBe(0);
    expect(p!.anchorTo).toBe(105);
  });
});

describe("buildWindowPack signal gate hierarchy", () => {
  it("survival signal passes gate -> kind=survival", () => {
    // Using 105s match: passes survival gate when window has CC >= 3s with trinket available_unused
    // (If fixture lacks this signal, construct auraEvents variant with cc + trinket=available_unused, duration>=3
    //  — matching predicate in hasCoachableSignal cc branch)
    const r = buildWindowPack(ccCombat, 70, 105, "Owner-Area52");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("survival");
  });

  it("all fail gate -> null (caller uses no-signal text)", () => {
    const r = buildWindowPack(combat, 0, 10, "Owner-Area52"); // empty window
    expect(r).toBeNull();
  });
});

describe("buildWindowAnchorFinding neutral anchor", () => {
  it("time floored to render second; no problem phrasing; contains kind count summary", () => {
    const f = buildWindowAnchorFinding(somePack, 36.7, 59.2, "survival");
    expect(f.title).toBe("User selected segment 0:36–0:59");
    expect(f.explanation).not.toMatch(/problem|mistake|error|wrong/i);
    expect(f.eventIds).toEqual([]);
    expect(f.severity).toBe("low");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/analysis -- deepDive.window`
Expected: FAIL (new exports missing).

- [ ] **Step 3: Implement**

Modify header in `buildDeepDivePack` (and symmetrically in `buildOffensiveDeepDivePack`):

```ts
export interface WindowOverride {
  fromS: number;
  toS: number;
}

export function buildDeepDivePack(
  combat: any,
  finding: Finding,
  findingIndex: number,
  candidates: CandidateEvent[],
  ownerName?: string,
  /** User selected segment (#16): window takes override as-is (clamped to [0, durS]), without -30/+10
   * padding — user framing is what they want to inspect; does not depend on finding.eventIds. */
  windowOverride?: WindowOverride,
): DeepDivePack | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ts = (finding.eventIds ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is CandidateEvent => !!c && Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.t);
  if (!windowOverride && ts.length === 0) return null; // match-wide observations without anchor, no deep dive
  const durS = ((combat?.endTime ?? 0) - (combat?.startTime ?? 0)) / 1000;
  const anchorFrom = windowOverride
    ? Math.max(0, windowOverride.fromS)
    : Math.max(0, Math.min(...ts) - PACK_BEFORE_S);
  const anchorTo = windowOverride
    ? Math.min(durS, windowOverride.toS)
    : Math.min(durS, Math.max(...ts) + PACK_AFTER_S);
```

`focusT` (truncation focal point, declared as `Math.max(...ts)` in survival HP section, `Math.min(...ts)` in offensive): with override, both use window midpoint `(anchorFrom + anchorTo) / 2` (user window has no natural focus, midpoint is most neutral). Note `Math.max(...[])` is `-Infinity` — check override branch first before calculation.

Add at file end:

```ts
/** User selected segment pack builder (#16): survival collection -> survival gate;
 * if failed, offensive collection -> offensive gate;
 * if both fail -> null (caller displays "No coachable signals", does not call model).
 * Synthetic empty anchor finding exists only to reuse both pack builder function signatures,
 * does not enter prompt (prompt uses buildWindowAnchorFinding neutral anchor). */
export function buildWindowPack(
  combat: any,
  fromS: number,
  toS: number,
  ownerName?: string,
): { pack: DeepDivePack; kind: "survival" | "offensive" } | null {
  const synth: Finding = {
    eventIds: [],
    severity: "low",
    category: "window",
    title: "",
    explanation: "",
  };
  const win = { fromS, toS };
  const surv = buildDeepDivePack(combat, synth, 0, [], ownerName, win);
  if (surv && hasCoachableSignal(surv.items))
    return { pack: surv, kind: "survival" };
  const off = buildOffensiveDeepDivePack(combat, synth, 0, [], ownerName, win);
  if (off && hasOffensiveCoachableSignal(off.items))
    return { pack: off, kind: "offensive" };
  return null;
}

const KIND_ZH: Record<PackItem["kind"], string> = {
  cc: "CC",
  defensive: "Defensive Cast",
  "enemy-cd": "Enemy Offensive CD",
  hp: "HP Trajectory",
  dispel: "Dispel",
  "external-available": "External Available",
  "immunity-available": "Immunity Available",
  position: "Positioning",
  "target-hp": "Target Health",
  "enemy-defensive": "Enemy Defensive",
  immunity: "Enemy Immunity",
  "our-cc": "Friendly CC",
  "our-cd": "Friendly Major CD",
  "off-target": "Off-Target",
  "dr-clip": "DR Clip",
};

/** Neutral anchor (#16 mitigation layer 1): title/explanation generated deterministically from pack stats,
 * without "problem/mistake" presupposition; timestamp floored to render second (house rule predicate is spec). */
export function buildWindowAnchorFinding(
  pack: DeepDivePack,
  fromS: number,
  toS: number,
  kind: "survival" | "offensive",
): Finding {
  const mm = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const counts = new Map<string, number>();
  for (const it of pack.items)
    counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([k, n]) => `${KIND_ZH[k as PackItem["kind"]] ?? k}×${n}`)
    .join(", ");
  return {
    eventIds: [],
    severity: "low",
    category: kind === "offensive" ? "window-offensive" : "window",
    title: `User selected segment ${mm(fromS)}–${mm(toS)}`,
    explanation: `This window was manually selected by the user. In-window evidence: ${summary}.`,
  };
}
```

In `index.ts`, export `buildWindowPack`, `buildWindowAnchorFinding`, `WindowOverride` type.

- [ ] **Step 4: Run test to confirm passing**

Run: `npm test --workspace=packages/analysis`
Expected: All green (new file + existing deepDive tests zero regressions). Then run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(analysis): deep dive pack building windowOverride parameterization + buildWindowPack signal gate hierarchy + neutral anchor (#16)"
```

---

### Task 2: analysis — window Mode Prompt

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts` (buildDeepDivePrompt ~806-863)
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts` (append describe)

**Interfaces:**

- Produces: `buildDeepDivePrompt(packs, findings, specName, ownerName?, mode?: "deepen" | "window")` (5th param optional, default "deepen" behavior byte-for-byte unchanged; Task 3 passes "window").

- [ ] **Step 1: Write failing test**

Append to `deepDive.window.test.ts`:

```ts
describe("buildDeepDivePrompt window mode", () => {
  const windowFinding = buildWindowAnchorFinding(pack, 100, 150, "survival");
  it("contains selected segment contract: does not assume problems exist + empty array is valid", () => {
    const p = buildDeepDivePrompt(
      [pack],
      [windowFinding],
      "Holy Paladin",
      "Owner-Area52",
      "window",
    );
    expect(p).toContain("manually selected");
    expect(p).toContain("Do NOT assume something went wrong");
    expect(p).toContain("output an empty array");
    expect(p).not.toContain("deepening findings"); // deepen framework text must not appear
    expect(p).toContain("SELECTED WINDOW"); // section header renamed
    // Hard rules and output contract preserved (audit compatibility anchor)
    expect(p).toContain('"findingIndex": number');
    expect(p).toContain("Write NO digits");
  });
  it("default mode behavior unchanged (regression anchor)", () => {
    const p = buildDeepDivePrompt(
      [pack],
      findings,
      "Holy Paladin",
      "Owner-Area52",
    );
    expect(p).toContain("deepening findings");
    expect(p).toContain("FINDING 0:");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/analysis -- deepDive.window`
Expected: New describe FAIL (lacks 5th param).

- [ ] **Step 3: Implement**

Add `mode: "deepen" | "window" = "deepen"` to signature. Branch in two places by mode, keeping everything else untouched:

```ts
// Section headers in sections:
mode === "window"
  ? [
      `SELECTED WINDOW ${p.findingIndex}: ${f.title} — ${f.explanation}`,
      `EVIDENCE PACK ${p.findingIndex} (window ${fmt(p.anchorFrom)}s–${fmt(p.anchorTo)}s; the ONLY additional evidence you may reference):`,
      listing,
    ].join("\n")
  : /* original 3 lines untouched */

// Opening instruction block:
mode === "window"
  ? `You are a World of Warcraft arena coach reviewing a time window that ${ownerShort} (a ${specName}) manually selected from their own match replay. ${ownerShort} is curious whether anything in this window could have been played differently. Do NOT assume something went wrong — the window was selected out of curiosity, not because a mistake is known to be there. For the window, write ONE short paragraph (3-5 sentences) ONLY IF the evidence pack supports a specific, concrete observation about a decision ${ownerShort}'s team could have made differently. If nothing stands out, output an empty array [] — that is a good and expected answer.`
  : /* original sentence untouched */
```

- [ ] **Step 4: Run test to confirm passing**

Run: `npm test --workspace=packages/analysis` + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(analysis): deep dive prompt window mode (neutral framing + empty output contract, #16)"
```

---

### Task 3: desktop main — analyzeWindow Service + Disk Cache + IPC + preload

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`
- Modify: `packages/desktop/src/main/ipc.ts` (~line 133 beside deepen handler)
- Modify: `packages/desktop/src/preload/index.ts` (~line 69 beside deepen)
- Modify: `packages/desktop/src/preload/api.ts` (analysis block ~142 beside deepen)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts` (add stub)
- Test: `packages/desktop/src/main/analysis.test.ts` (append describe; harness follows `createAnalysisService` + `mkdtempSync` pattern)

**Interfaces:**

- Consumes: Task 1/2's `buildWindowAnchorFinding`, `buildDeepDivePrompt(mode:"window")` (via dynamic import), existing `auditDeepDives/parseModelJsonArray/resolveAiClient/resolveAiModel/buildCoachSystemPrompt/recordAiDebug`.
- Produces (consumed by Task 4, isomorphic in preload api.ts):

```ts
export type WindowAnalyzeInput = {
  matchId: string;
  fromS: number;
  toS: number;
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName?: string;
};
export type WindowAnalyzeResult =
  | {
      status: "ok";
      text: string;
      chips: DeepDiveResult["chips"];
      fromCache: boolean;
    }
  | { status: "audit-empty" } // Model output failed audit (or was empty) -> UI prompts retry
  | { status: "no-client" } // AI not configured -> UI prompts settings
  | { status: "busy" }; // Same match same window in-flight (idempotency guard)
```

- [ ] **Step 1: Write failing test**

In `analysis.test.ts`, add:

```ts
describe("analyzeWindow (#16 segment analysis)", () => {
  const PACK = {
    findingIndex: 0,
    anchorFrom: 30,
    anchorTo: 60,
    items: [
      {
        key: "p1",
        kind: "cc",
        t: 40,
        label: "Fear → O",
        unitNames: ["O-R"],
        facts: {
          t: "40",
          spell: "Fear",
          duration: "4.0",
          trinket: "available_unused",
        },
      },
    ],
    facts: {
      "p1.t": "40",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "available_unused",
    },
  };
  const GOOD = JSON.stringify([
    {
      findingIndex: 0,
      deepDive:
        "At {{p1.t}}s the {{p1.spell}} landed with trinket {{p1.trinket}}; trinket that stun.",
      citedKeys: ["p1"],
    },
  ]);
  const input = (dir: string) => ({
    matchId: "m1",
    fromS: 30,
    toS: 60,
    pack: PACK,
    kind: "survival" as const,
    spec: "Holy Paladin",
    ownerName: "O-Realm",
  });

  it("normal path: LLM -> audit -> ok + disk write; second call hits cache without calling client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir));
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") {
      expect(r1.text).toContain("At 40s");
      expect(r1.fromCache).toBe(false);
    }
    expect(
      JSON.parse(
        readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
      )["30-60"].text,
    ).toContain("At 40s");
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") expect(r2.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("all failed audit -> audit-empty without disk write (allows retry)", async () => {
    // client outputs raw digit item ("died at 40s" without placeholders) -> auditDeepDives drops all
  });

  it("no client -> no-client, does not write cache", async () => {});

  it("LRU: writing 21st window evicts entry with oldest at, file has exactly 20 entries", async () => {});

  it("idempotency: second call returns busy immediately while same match same window in-flight, does not stack client calls", async () => {
    // client stream hung on never-resolving promise, two concurrent analyzeWindow calls
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/desktop -- src/main/analysis`
Expected: FAIL (analyzeWindow does not exist).

- [ ] **Step 3: Implement**

In `analysis.ts` (beside deepen):

```ts
const WINDOW_CACHE_MAX = 20;
const windowInFlight = new Set<string>(); // `${matchId}:${windowKey}`

const windowCachePath = (matchId: string, lang: AiLanguage) =>
  join(deps.matchesDir, matchId, `windowAnalysis.${lang}.json`);

type WindowCacheEntry = {
  fromS: number;
  toS: number;
  text: string;
  chips: Array<{
    t: number;
    label: string;
    unitNames: string[];
    spellId?: string;
  }>;
  at: number;
};

async function analyzeWindow(
  input: WindowAnalyzeInput,
): Promise<WindowAnalyzeResult> {
  const windowKey = `${Math.floor(input.fromS)}-${Math.floor(input.toS)}`;
  const flight = `${input.matchId}:${windowKey}`;
  if (windowInFlight.has(flight)) return { status: "busy" };
  windowInFlight.add(flight);
  try {
    const settings = deps.getSettings();
    const lang: AiLanguage = settings.aiLanguage ?? "zh";
    const path = windowCachePath(input.matchId, lang);
    let cache: Record<string, WindowCacheEntry> = {};
    try {
      cache = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      /* First time */
    }
    const hit = cache[windowKey];
    if (hit)
      return {
        status: "ok",
        text: hit.text,
        chips: hit.chips,
        fromCache: true,
      };

    const client = resolveAiClient(settings, deps.clientFactory);
    if (!client) return { status: "no-client" };

    // Dynamic import: same reason as deepenInner (prevents 13.6MB table in main startup graph)
    const [
      { buildDeepDivePrompt, auditDeepDives, buildWindowAnchorFinding },
      { ensureAnalysisData },
    ] = await Promise.all([
      import("@gladlog/analysis/src/analysis/deepDive"),
      import("@gladlog/analysis/src/data/ensure"),
    ]);
    await ensureAnalysisData();
    const anchor = buildWindowAnchorFinding(
      input.pack,
      input.fromS,
      input.toS,
      input.kind,
    );
    const prompt = buildDeepDivePrompt(
      [input.pack],
      [anchor],
      input.spec,
      input.ownerName,
      "window",
    );
    let raw = "";
    const stream = client.stream({
      model: resolveAiModel(settings),
      max_tokens: 2048, // single pack single segment
      system: buildCoachSystemPrompt(lang),
      messages: [{ role: "user", content: prompt }],
    });
    for await (const ev of stream) if (ev.delta) raw += ev.delta;
    recordAiDebug({
      kind: "analysis",
      matchId: `${input.matchId}#window:${windowKey}`,
      at: Date.now(),
      model: resolveAiModel(settings),
      prompt,
      raw,
    });
    const dives = auditDeepDives(parseModelJsonArray(raw), [input.pack]);
    const d = dives.find((x) => x.findingIndex === 0);
    if (!d) return { status: "audit-empty" }; // not cached, allow retry
    cache[windowKey] = {
      fromS: input.fromS,
      toS: input.toS,
      text: d.text,
      chips: d.chips,
      at: Date.now(),
    };
    const keys = Object.keys(cache);
    if (keys.length > WINDOW_CACHE_MAX) {
      const evict = keys
        .sort((a, b) => cache[a]!.at - cache[b]!.at)
        .slice(0, keys.length - WINDOW_CACHE_MAX);
      for (const k of evict) delete cache[k];
    }
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), "utf-8");
    renameSync(tmp, path);
    return { status: "ok", text: d.text, chips: d.chips, fromCache: false };
  } catch {
    return { status: "audit-empty" }; // Network/parse failure handled identically: allows retry, not cached
  } finally {
    windowInFlight.delete(flight);
  }
}
```

Add `analyzeWindow` to service return object. Export `WindowAnalyzeInput/WindowAnalyzeResult`.
Note: Generation counter (`nextGen`) is **not** used here — window analysis is single request-response, does not race with run/deepen writes to `analysis-v2` cache, and idempotency guard handles duplicates.

In `ipc.ts`:

```ts
ipcMain.handle("gladlog:analysis:analyzeWindow", (_e, input) =>
  deps.analysis.analyzeWindow(input),
);
```

In `preload/index.ts`:

```ts
analyzeWindow: (input) => ipcRenderer.invoke("gladlog:analysis:analyzeWindow", input),
```

In `preload/api.ts` analysis block:

```ts
/** Segment analysis (#16): pack constructed deterministically by renderer; single request-response, does not emit. */
analyzeWindow(input: {
  matchId: string; fromS: number; toS: number;
  pack: unknown; kind: "survival" | "offensive";
  spec: string; ownerName?: string;
}): Promise<
  | { status: "ok"; text: string; chips: Array<{ t: number; label: string; unitNames: string[]; spellId?: string }>; fromCache: boolean }
  | { status: "audit-empty" } | { status: "no-client" } | { status: "busy" }
>;
```

In `fixtureBridge.ts` analysis stub: `async analyzeWindow() { return { status: "no-client" as const }; }`.

- [ ] **Step 4: Run test to confirm passing**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(desktop): analyzeWindow main process service (LRU disk cache + idempotency guard) + IPC/preload (#16)"
```

---

### Task 4: desktop renderer — resolveOwner Extraction + Button + WindowAnalysisCard

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/analysisInput.ts` (extract resolveOwner + new buildWindowAnalysisRequest)
- Create: `packages/desktop/src/renderer/src/report/components/WindowAnalysisCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (toolbar button + state machine + card mounting)
- Modify: `packages/desktop/src/renderer/src/styles.css` (minor card styling)
- Test: `packages/desktop/test/windowAnalysis.test.tsx` (new; fixture stub using `__gladlogFixture` pattern)

**Interfaces:**

- Consumes: Task 1 `buildWindowPack`, Task 3 bridge `analysis.analyzeWindow`, #15 `makeRichText`, existing `toLegacySafe/specToString/ensureAnalysisData/ChipIcon`, `MatchReport`'s `handleSeekEvent`.
- Produces:

```ts
// analysisInput.ts
export function resolveOwner(legacy: LegacyLike): Unit | undefined; // extracted as-is from buildAnalysisInput inline logic, shared across both
export function buildWindowAnalysisRequest(
  source: ReportSource,
  fromS: number,
  toS: number,
): {
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName: string;
} | null;
// null = missing owner / pack build failed / no coachable signal -> caller displays no-signal text, does not issue IPC

// WindowAnalysisCard.tsx
export type WindowCardState =
  | { phase: "loading" }
  | { phase: "result"; text: string; chips: Chips; fromCache: boolean }
  | { phase: "none" } // No signal (deterministic, zero cost)
  | { phase: "audit-empty" } // Retryable
  | { phase: "no-client" };
export function WindowAnalysisCard(props: {
  state: WindowCardState;
  range: { fromS: number; toS: number };
  rich: (t?: string | null) => ReactNode;
  onJumpT: (tSeconds: number, unitNames: string[]) => void;
  onRetry: () => void;
}): JSX.Element;
```

- [ ] **Step 1: Write failing test**

`test/windowAnalysis.test.tsx` (`// @vitest-environment jsdom`):

```tsx
// 1) buildWindowAnalysisRequest: any window on cropped fixture -> null (no death/damage taken, gate fails), does not throw
// 2) MatchReport without timeRange -> no [AI Analyze Segment] button; set initialTimeRange={fromS:36,toS:59} -> button appears
// 3) Click button (fixture gate fails) -> displays "No coachable signals detected" card, and __gladlogFixture.analysis.analyzeWindow is not called (vi.fn count 0)
// 4) Window onChange (TimeRangeBar cleared) -> card collapses
// 5) WindowAnalysisCard unit test: result state renders text (via injected rich) + chips buttons call onJumpT; audit-empty state has retry button calling onRetry
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/desktop -- windowAnalysis`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `analysisInput.ts`: extract owner resolution lines from `buildAnalysisInput` into `export function resolveOwner(legacy)`; add:

```ts
/** Segment analysis request (#16): pack building + gate checking handled on renderer; returns null if gate fails (no IPC issued).
 * Prerequisite contract: await ensureAnalysisData() prior to call (prompt spell names must not degrade). */
export function buildWindowAnalysisRequest(
  source: ReportSource,
  fromS: number,
  toS: number,
) {
  try {
    const legacy = toLegacySafe(source);
    const owner = resolveOwner(legacy);
    if (!owner) return null;
    const r = buildWindowPack(legacy, fromS, toS, owner.name);
    if (!r) return null;
    return {
      pack: r.pack,
      kind: r.kind,
      spec: specToString(owner.spec),
      ownerName: owner.name,
    };
  } catch {
    return null;
  }
}
```

`WindowAnalysisCard.tsx`: finding card style (`rpt-finding rpt-finding-low` container + `data-testid="window-ai-card"`); header "Segment Analysis 0:36–0:59" + when fromCache small text "(Cached)"; phase branches:
- loading: "Analyzing… (approx. 10–30s)";
- result: `<p className="rpt-finding-body">{rich(text)}</p>` + chips row (`<ChipIcon spellId={c.spellId} />⏱ {mmss(c.t)} {c.label}`, onClick -> `onJumpT(c.t, c.unitNames)`);
- none: "No coachable signals detected in this segment (no CC / defensive casts / enemy burst / sudden HP drops, etc.).";
- audit-empty: "Model output did not pass audit." + retry button (onRetry);
- no-client: "AI not configured (available after filling API Key in settings).".

In `MatchReport.tsx`:
- state: `const [winAi, setWinAi] = useState<{ range: TimeRange; state: WindowCardState } | null>(null);`
- `timeRange` change (including clear) resets `setWinAi(null)`.
- Toolbar button (between TimeRangeBar and "Copy Markdown"):

```tsx
{
  timeRange && (
    <button
      className="rpt-btn"
      data-testid="window-ai-btn"
      title="Perform an AI deep dive on the current segment (does not call model if no coachable signal)"
      onClick={() => void runWindowAi(timeRange)}
    >
      AI Analyze Segment
    </button>
  );
}
```

- Handler function inside component:

```tsx
const runWindowAi = async (range: TimeRange) => {
  setWinAi({ range, state: { phase: "loading" } });
  await ensureAnalysisData(); // prerequisite contract for pack building
  const req = buildWindowAnalysisRequest(source, range.fromS, range.toS);
  if (!req) return setWinAi({ range, state: { phase: "none" } }); // No IPC issued
  try {
    const r = await bridge().analysis.analyzeWindow({
      matchId: resolvedMatchId,
      fromS: range.fromS,
      toS: range.toS,
      pack: req.pack,
      kind: req.kind,
      spec: req.spec,
      ownerName: req.ownerName,
    });
    if (r.status === "ok")
      setWinAi({
        range,
        state: {
          phase: "result",
          text: r.text,
          chips: r.chips,
          fromCache: r.fromCache,
        },
      });
    else if (r.status === "busy")
      return; // In-flight: keep loading, result persisted by earlier call and displayed on next click
    else setWinAi({ range, state: { phase: r.status } });
  } catch {
    setWinAi({ range, state: { phase: "audit-empty" } }); // Missing bridge / exceptions handled as retryable
  }
};
```

- Card mounting: under toolbar row, above `<Timeline>`, `winAi && <WindowAnalysisCard state={winAi.state} range={winAi.range} rich={rich} onJumpT={handleSeekEvent} onRetry={() => void runWindowAi(winAi.range)} />`.

- [ ] **Step 4: Run test to confirm passing**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck` + `npx eslint packages/desktop/src --quiet`
Expected: All green.

- [ ] **Step 5: Visual acceptance test on testbench**

Start dev:ui in worktree, drag-select window on real fixture -> click button -> verify "No signals" card appears; verify final card text when fixtureBridge stub returns no-client.

- [ ] **Step 6: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(desktop): report segment [AI Analyze Segment] button + WindowAnalysisCard final state card (#16)"
```

---

### Task 5: Gatekeeper, Push, CI, Visual Baseline, Backlog Reconciliation

**Files:**

- Modify: `docs/BACKLOG.md` (#16 title row ✅)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/report-window.png` (CI generated human review — initialTimeRange={36,59} active in scene, new button in view)

- [ ] **Step 1: presubmit**

Run (worktree): `(cd /Users/mingjianliu/code/gladlog-wt-16 && npm run presubmit)`
Expected: All green.

- [ ] **Step 2: Backlog reconciliation + push**

In `docs/BACKLOG.md` #16 title row, add:
`✅(2026-07-29 Landed: TimeRangeBar segment selection -> windowOverride pack building -> window mode deep dive -> WindowAnalysisCard; zero-cost path for no signal; windowAnalysis.<lang>.json LRU cache; spec docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md; real model filler smoke pending real device)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "docs: backlog #16 reconciliation"
git -C /Users/mingjianliu/code/gladlog-wt-16 push
```

- [ ] **Step 3: Monitor CI by headSha**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-16 rev-parse HEAD)
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
# if run not created yet: sleep 20 and retry; once id obtained
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run watch <RUN_ID> --exit-status)
```

- [ ] **Step 4: Visual baseline regeneration (CI single source, human review)**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh workflow run visual-baseline.yml --ref main)
RUN=$(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run list --workflow visual-baseline.yml --limit 1 --json databaseId -q '.[0].databaseId')
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run download $RUN -n visual-baselines -D /tmp/bl16)
for f in /tmp/bl16/scenes.spec.ts/*.png; do n=$(basename $f); cmp -s "$f" /Users/mingjianliu/code/gladlog-wt-16/packages/desktop/qa/__screenshots__/scenes.spec.ts/$n || echo "DIFF $n"; done
```

Human review DIFF: change must be explained by "report-window toolbar has one additional button"; other scenes must not change. Copy over, commit, push, return to Step 3 until green.

- [ ] **Step 5: Report acceptance metrics + real-device smoke handoff**

- Before/after numbers: same fixture scene, button count 0 -> 1 when window active; zero-signal path analyzeWindow call count 0 (test assertion); cache hit client call count 1 -> 1 (no increase).
- **Real model filler smoke left for user's real device** (spec 3-layer mitigation verification layer): pick 3-4 matches from real library, test 1 segment each of "death window / quiet window / offensive window", human review: whether quiet window honestly reports no issues, whether signal window suggestions align with pack evidence.

---

## Self-Review Records

1. **Spec Coverage**: Pack building / gate hierarchy / neutral anchor (T1), window prompt 3-layer mitigation (T2), IPC / LRU cache / idempotency / audit-empty not cached (T3), button / final card / zero-signal zero IPC / rich reuse (T4), presubmit / baseline / reconciliation / smoke handoff (T5).
2. **Placeholders**: None.
3. **Type Consistency**: `WindowAnalyzeInput/Result` defined in T3, consumed via preload api in T4; `buildWindowPack` returning `{pack, kind} | null` consistent across all 3 call sites; `WindowCardState.phase` aligned with result.status literals.
