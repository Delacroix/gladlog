# Offensive Deep Dive (Non-Death Finding Deep Dive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the deep dive round to cover 5 types of window-based non-death findings, using offensive evidence that mirrors death analysis (target HP line / enemy defensives and immunities / our CC on enemy healers / major cooldown alignment), and guarantee 1 deep dive slot for it.

**Architecture:** Add a sibling builder `buildOffensiveDeepDivePack` (output shape matches `DeepDivePack`) in `deepDive.ts` + pure mapping core `offensivePackItems` + gate `hasOffensiveCoachableSignal` + classifier `classifyFindingKind`; renderer guarantees 1 slot, merging into the same `deepen()` call. Survival (death) path remains completely untouched. Predicate single source of truth: offensive evidence solely consumes `analyzeBurstLedger` / `analyzeOutgoingCCChains` (same source as `candidateFindings`).

**Tech Stack:** TypeScript monorepo. analysis (`packages/analysis`), desktop main/renderer (`packages/desktop`), eval harmonics (`packages/eval/scripts`). vitest for testing.

## Global Constraints

- **Predicate Single Source Rule**: Offensive packs only consume `analyzeBurstLedger(player, allies, enemies, combat)` / `analyzeOutgoingCCChains(friendlies, enemies, combat)`; do not calculate new facts.
- **Placeholder Discipline**: Deep dive body numbers must be `{{key.field}}` placeholders; use `sn()` for names in facts to strip realm numbers; structured numeric values should be split into independent placeholder fields, not baked into key names.
- **Type Checking**: `npm run typecheck` (never `tsc -b`).
- **Before pushing desktop changes**: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`.
- **Builder is in `packages/analysis`**: Use relative imports for utils; new exports will be automatically re-exported via the `export *` barrel.
- **Eval**: responder/judge must be sonnet; cross-AI = sonnet + gemini (agy); agy output must be **redirected to a file** (do not use `| tail`).
- **Scope**: Only 5 types of window-based non-death findings — `unconverted-burst` / `burst-into-immunity` / `off-target-in-window` / `juked-kick` / `dr-clipped-cc`. `cd-waste` is excluded (whole-round + survival type, no window anchor).

## Existing Code Anchors (verbatim, for implementer alignment)

`packages/analysis/src/analysis/deepDive.ts`:

- `export const DEEP_DIVE_MAX = 2; export const PACK_BEFORE_S = 30; export const PACK_AFTER_S = 10; const PACK_MAX_ITEMS = 14;`
- `const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1);`
- `const sn = (name) => name.split("-")[0] ?? name;`
- `PackItem.kind: "cc" | "defensive" | "enemy-cd" | "hp" | "dispel" | "position"`
- `interface DeepDivePack { findingIndex; anchorFrom; anchorTo; items: PackItem[]; facts: Record<string,string>; }`
- `buildDeepDivePrompt(packs, findings, specName, ownerName?)` — One section per pack, items listed as `key=pN kind=K facts={k=v,...}`, HARD RULES at the end.

`packages/analysis/src/utils/burstLedger.ts`:

```ts
interface IBurstDefensiveHit {
  spellId;
  spellName: string;
  overlapSeconds: number;
  isImmunity: boolean;
}
interface IBurstLedgerEntry {
  fromSeconds: number;
  toSeconds: number;
  spells: Array<{ spellId; spellName: string; castTimeSeconds: number }>;
  totalDamage: number;
  damageByTarget: Array<{ unitId; unitName: string; damage: number }>;
  dominantTarget: {
    unitId;
    unitName: string;
    hpStartPct: number | null;
    hpEndPct: number | null;
    damage: number;
    defensivesHit: IBurstDefensiveHit[];
    died: boolean;
  } | null;
  allyCDsOverlapping: Array<{ playerName: string; spellName: string }>;
}
function analyzeBurstLedger(
  player,
  allies,
  enemies,
  combat,
): IBurstLedgerEntry[]; // Automatically excludes player via a.id!==player.id
```

`packages/analysis/src/utils/drAnalysis.ts`:

```ts
interface IOutgoingCCApplication {
  atSeconds: number;
  durationSeconds;
  spellName;
  casterName: string;
  drInfo: IDRInfo;
}
interface IOutgoingCCChain {
  targetName: string;
  targetSpec: string;
  applications: IOutgoingCCApplication[];
  hasWastedApplications: boolean;
}
function analyzeOutgoingCCChains(
  friendlies,
  enemies,
  combat,
): IOutgoingCCChain[];
```

`packages/analysis/src/utils/cooldowns.ts`: `isHealerSpec(spec)`.
`packages/analysis/src/analysis/auditFindings.ts`: `export const SEVERITY_RANK = { high:0, med:1, low:2 };`
`packages/analysis/src/analysis/types.ts`: `CandidateEvent { id; type: string; t; unitNames; spell?; facts }`; `Finding { eventIds: string[]; severity; category; title; explanation; deepDive? }`.
Candidate types (`candidateFindings.ts`) and built-in facts: see spec background table.

---

### Task 1: PackItem kind Expansion + `hasOffensiveCoachableSignal` Gate

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts` (PackItem.kind union; add `OFFENSIVE_KINDS` set + `hasOffensiveCoachableSignal`)
- Test: `packages/analysis/src/analysis/deepDive.test.ts` (append describe block)

**Interfaces:**

- Produces: `export function hasOffensiveCoachableSignal(items: PackItem[]): boolean`; expanded `PackItem.kind` includes `"target-hp" | "enemy-defensive" | "immunity" | "our-cc" | "our-cd" | "off-target" | "juked-kick" | "dr-clip"`.

- [ ] **Step 1: Write failing tests** (append to end of `deepDive.test.ts`)

```ts
import { hasOffensiveCoachableSignal } from "./deepDive";

describe("hasOffensiveCoachableSignal (offensive signal gate, offensive deep dive)", () => {
  const item = (kind: string, facts: Record<string, string>) =>
    ({ key: "p1", kind, t: 1, label: "", unitNames: [], facts }) as never;
  it("target bottomed out + defensive/immunity answered = signal", () => {
    expect(
      hasOffensiveCoachableSignal([
        item("target-hp", { role: "enemy-target", hp: "22" }),
        item("immunity", { role: "enemy", spell: "Divine Shield" }),
      ]),
    ).toBe(true);
    expect(
      hasOffensiveCoachableSignal([
        item("target-hp", { role: "enemy-target", hp: "20" }),
        item("enemy-defensive", { role: "enemy", spell: "Ice Barrier" }),
      ]),
    ).toBe(true);
  });
  it("off-target / juked / dr-clip each as standalone signal", () => {
    expect(
      hasOffensiveCoachableSignal([
        item("off-target", { role: "owner", onTargetPct: "40" }),
      ]),
    ).toBe(true);
    expect(
      hasOffensiveCoachableSignal([
        item("juked-kick", { role: "owner", kick: "Kick" }),
      ]),
    ).toBe(true);
    expect(
      hasOffensiveCoachableSignal([
        item("dr-clip", { role: "owner", dr: "Immune" }),
      ]),
    ).toBe(true);
  });
  it("target not bottomed out / target-hp only without defensive -> no signal", () => {
    expect(
      hasOffensiveCoachableSignal([
        item("target-hp", { role: "enemy-target", hp: "80" }),
        item("enemy-defensive", { role: "enemy", spell: "Ice Barrier" }),
      ]),
    ).toBe(false);
    expect(
      hasOffensiveCoachableSignal([
        item("target-hp", { role: "enemy-target", hp: "15" }),
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts -t hasOffensiveCoachableSignal`
Expected: FAIL — `hasOffensiveCoachableSignal is not a function`.

- [ ] **Step 3: Implementation** (in `deepDive.ts`, after `hasCoachableSignal`)

First change `PackItem.kind` to:

```ts
  kind:
    | "cc" | "defensive" | "enemy-cd" | "hp" | "dispel" | "position"
    | "target-hp" | "enemy-defensive" | "immunity" | "our-cc" | "our-cd"
    | "off-target" | "juked-kick" | "dr-clip";
```

Then add constant + gate (threshold `OFFENSIVE_HP_THRESHOLD = 35` independent of spec):

```ts
/** Offensive deep dive: target HP bottom-out threshold (%); below this + defensive/immunity answered = "should swap/wait/CC healer". */
const OFFENSIVE_HP_THRESHOLD = 35;

/**
 * Offensive signal (offensive deep dive gate): non-death candidates are already pre-curated mistakes, light gate -- requires offensive narrative present:
 * target HP bottomed out and answered by defensive/immunity (should swap/wait/CC healer), or off-target/juked/dr-clip each as standalone mistakes.
 */
export function hasOffensiveCoachableSignal(items: PackItem[]): boolean {
  const targetBottomed = items.some(
    (i) =>
      i.kind === "target-hp" && Number(i.facts.hp) <= OFFENSIVE_HP_THRESHOLD,
  );
  const answered = items.some(
    (i) => i.kind === "enemy-defensive" || i.kind === "immunity",
  );
  if (targetBottomed && answered) return true;
  return items.some(
    (i) =>
      i.kind === "off-target" ||
      i.kind === "juked-kick" ||
      i.kind === "dr-clip",
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts`
Expected: PASS (including existing hasCoachableSignal / auditDeepDives test cases).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add packages/analysis/src/analysis/deepDive.ts packages/analysis/src/analysis/deepDive.test.ts
git commit -m "feat(deepdive): offensive signal gate hasOffensiveCoachableSignal + PackItem kind expansion"
```

---

### Task 2: `offensivePackItems` (Pure Mapping) + `buildOffensiveDeepDivePack` (Wiring Predicates)

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`
- Test: `packages/analysis/src/analysis/deepDive.test.ts`

**Interfaces:**

- Consumes: `IBurstLedgerEntry` (burstLedger.ts), `IOutgoingCCChain` (drAnalysis.ts), `hasOffensiveCoachableSignal` (Task 1).
- Produces:
  - `export function offensivePackItems(input: OffensiveMapInput): Omit<PackItem, "key">[]`
  - `export function buildOffensiveDeepDivePack(combat: any, finding: Finding, findingIndex: number, candidates: CandidateEvent[], ownerName?: string): DeepDivePack | null`
  - `interface OffensiveMapInput { entries: IBurstLedgerEntry[]; healerChains: IOutgoingCCChain[]; candFacts: Record<string,string>[]; candTypes: string[]; ownerName?: string; inWin: (t:number)=>boolean; }`

- [ ] **Step 1: Write failing tests** (pure mapping core, handwritten ledger entries)

```ts
import { offensivePackItems } from "./deepDive";
import type { IBurstLedgerEntry } from "../utils/burstLedger";

describe("offensivePackItems (offensive evidence mapping, pure function)", () => {
  const entry: IBurstLedgerEntry = {
    fromSeconds: 40,
    toSeconds: 44,
    spells: [{ spellId: "1", spellName: "Combustion", castTimeSeconds: 40 }],
    totalDamage: 500000,
    damageByTarget: [
      { unitId: "e1", unitName: "Rdruid-Area52", damage: 500000 },
    ],
    dominantTarget: {
      unitId: "e1",
      unitName: "Rdruid-Area52",
      hpStartPct: 70,
      hpEndPct: 18,
      damage: 500000,
      defensivesHit: [
        {
          spellId: "9",
          spellName: "Ice Block",
          overlapSeconds: 2.5,
          isImmunity: true,
        },
      ],
      died: false,
    },
    allyCDsOverlapping: [
      { playerName: "Mate-Area52", spellName: "Power Infusion" },
    ],
  };
  const inWin = (t: number) => t >= 10 && t <= 50;

  it("burst-into-immunity: emits target-hp (start+end) + immunity + our-cd, short names, correct role", () => {
    const items = offensivePackItems({
      entries: [entry],
      healerChains: [],
      candFacts: [{ immunity: "Ice Block", overlap: "2.5" }],
      candTypes: ["burst-into-immunity"],
      ownerName: "Me-Area52",
      inWin,
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("target-hp");
    expect(kinds).toContain("immunity");
    expect(
      items.find((i) => i.kind === "target-hp" && i.facts.hp === "18"),
    ).toBeTruthy();
    // Short name: realm digits stripped, otherwise raw digit audit triggers false positive
    expect(items.find((i) => i.facts.unit === "Rdruid")).toBeTruthy();
    expect(
      items.every(
        (i) => i.facts.unit === undefined || !/\d/.test(i.facts.unit),
      ),
    ).toBe(true);
    // Immunity role=enemy
    expect(items.find((i) => i.kind === "immunity")!.facts.role).toBe("enemy");
  });

  it("healer CC chain within window -> our-cc (role=owner); outside window discarded", () => {
    const items = offensivePackItems({
      entries: [],
      candTypes: ["off-target-in-window"],
      candFacts: [
        {
          onTargetPct: "40",
          target: "Rdruid-Area52",
          offTarget: "Warr-Area52",
        },
      ],
      healerChains: [
        {
          targetName: "Hpal-Area52",
          targetSpec: "65",
          hasWastedApplications: false,
          applications: [
            {
              atSeconds: 42,
              durationSeconds: 3,
              spellName: "Polymorph",
              casterName: "Me-Area52",
              drInfo: { level: "Full" } as never,
            },
            {
              atSeconds: 99,
              durationSeconds: 3,
              spellName: "Ring of Frost",
              casterName: "Me-Area52",
              drInfo: { level: "Full" } as never,
            },
          ],
        },
      ],
      ownerName: "Me-Area52",
      inWin,
    });
    const cc = items.filter((i) => i.kind === "our-cc");
    expect(cc).toHaveLength(1); // 99s outside window dropped by inWin
    expect(cc[0]!.facts.role).toBe("owner");
    // off-target type item: from candidate facts
    const off = items.find((i) => i.kind === "off-target");
    expect(off!.facts.onTargetPct).toBe("40");
    expect(off!.facts.target).toBe("Warr"); // offTarget short name
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts -t offensivePackItems`
Expected: FAIL — `offensivePackItems is not a function`.

- [ ] **Step 3: Implement pure mapping core + builder** (in `deepDive.ts`, after `buildDeepDivePack`)

Add imports:

```ts
import {
  analyzeBurstLedger,
  type IBurstLedgerEntry,
} from "../utils/burstLedger";
import {
  analyzeOutgoingCCChains,
  type IOutgoingCCChain,
} from "../utils/drAnalysis";
```

Pure mapping core:

```ts
export interface OffensiveMapInput {
  entries: IBurstLedgerEntry[];
  healerChains: IOutgoingCCChain[];
  candFacts: Record<string, string>[];
  candTypes: string[];
  ownerName?: string;
  inWin: (t: number) => boolean;
}

/** Offensive evidence -> PackItem (pure): target HP / enemy defensive & immunity / our CC on enemy healer / offensive CD alignment + type-specific items. */
export function offensivePackItems(
  inp: OffensiveMapInput,
): Omit<PackItem, "key">[] {
  const raw: Omit<PackItem, "key">[] = [];
  const ownerShort = inp.ownerName ? sn(inp.ownerName) : undefined;
  const role = (name: string) =>
    ownerShort && sn(name) === ownerShort ? "owner" : "teammate";

  for (const e of inp.entries) {
    if (!inp.inWin(e.fromSeconds) && !inp.inWin(e.toSeconds)) continue;
    const t = e.dominantTarget;
    if (t) {
      // Target HP: start (burst start) + end (burst end), sourced from precomputed ledger values (predicate single source)
      if (t.hpStartPct != null && inp.inWin(e.fromSeconds))
        raw.push({
          kind: "target-hp",
          t: e.fromSeconds,
          label: `${sn(t.unitName)} HP`,
          unitNames: [t.unitName],
          facts: {
            t: fmt(e.fromSeconds),
            hp: String(t.hpStartPct),
            unit: sn(t.unitName),
            role: "enemy-target",
          },
        });
      if (t.hpEndPct != null && inp.inWin(e.toSeconds))
        raw.push({
          kind: "target-hp",
          t: e.toSeconds,
          label: `${sn(t.unitName)} HP`,
          unitNames: [t.unitName],
          facts: {
            t: fmt(e.toSeconds),
            hp: String(t.hpEndPct),
            unit: sn(t.unitName),
            role: "enemy-target",
          },
        });
      for (const d of t.defensivesHit) {
        raw.push({
          kind: d.isImmunity ? "immunity" : "enemy-defensive",
          t: e.fromSeconds,
          label: `${d.spellName}(${sn(t.unitName)})`,
          unitNames: [t.unitName],
          facts: {
            t: fmt(e.fromSeconds),
            spell: d.spellName,
            unit: sn(t.unitName),
            role: "enemy",
            ...(d.isImmunity ? { overlap: d.overlapSeconds.toFixed(1) } : {}),
          },
        });
      }
    }
    // Our offensive CD alignment (owner own spells + ally overlapping)
    for (const s of e.spells)
      if (inp.inWin(s.castTimeSeconds))
        raw.push({
          kind: "our-cd",
          t: s.castTimeSeconds,
          label: `${s.spellName}`,
          unitNames: inp.ownerName ? [inp.ownerName] : [],
          facts: {
            t: fmt(s.castTimeSeconds),
            spell: s.spellName,
            unit: ownerShort ?? "owner",
            role: "owner",
          },
        });
    for (const a of e.allyCDsOverlapping)
      raw.push({
        kind: "our-cd",
        t: e.fromSeconds,
        label: `${a.spellName}(${sn(a.playerName)})`,
        unitNames: [a.playerName],
        facts: {
          t: fmt(e.fromSeconds),
          spell: a.spellName,
          unit: sn(a.playerName),
          role: role(a.playerName),
        },
      });
  }

  // Our CC chain on enemy healer (within window)
  for (const chain of inp.healerChains)
    for (const app of chain.applications) {
      if (!inp.inWin(app.atSeconds)) continue;
      raw.push({
        kind: "our-cc",
        t: app.atSeconds,
        label: `${app.spellName} → ${sn(chain.targetName)}`,
        unitNames: [app.casterName],
        facts: {
          t: fmt(app.atSeconds),
          spell: app.spellName,
          unit: sn(chain.targetName),
          caster: sn(app.casterName),
          role: role(app.casterName),
        },
      });
    }

  // Type-specific items (inherits candidate built-in facts; short name)
  inp.candTypes.forEach((type, i) => {
    const cf = inp.candFacts[i] ?? {};
    const tt = Number(cf.t);
    if (type === "off-target-in-window")
      raw.push({
        kind: "off-target",
        t: Number.isFinite(tt) ? tt : 0,
        label: `off-target`,
        unitNames: [],
        facts: {
          ...(cf.t ? { t: cf.t } : {}),
          role: "owner",
          ...(cf.onTargetPct ? { onTargetPct: cf.onTargetPct } : {}),
          ...(cf.offTarget ? { target: sn(cf.offTarget) } : {}),
        },
      });
    if (type === "juked-kick")
      raw.push({
        kind: "juked-kick",
        t: Number.isFinite(tt) ? tt : 0,
        label: `juked-kick`,
        unitNames: [],
        facts: {
          ...(cf.t ? { t: cf.t } : {}),
          role: "owner",
          ...(cf.kick ? { kick: cf.kick } : {}),
          ...(cf.fake ? { fake: cf.fake } : {}),
        },
      });
    if (type === "dr-clipped-cc")
      raw.push({
        kind: "dr-clip",
        t: Number.isFinite(tt) ? tt : 0,
        label: `dr-clip`,
        unitNames: [],
        facts: {
          ...(cf.t ? { t: cf.t } : {}),
          role: "owner",
          ...(cf.spell ? { spell: cf.spell } : {}),
          ...(cf.target ? { target: sn(cf.target) } : {}),
          ...(cf.dr ? { dr: cf.dr } : {}),
        },
      });
  });

  return raw;
}
```

Builder (wiring predicates + truncation; truncation reuses sorting closest to focus timestamp from death pack; window / unit resolution reuses death pack logic):

```ts
export function buildOffensiveDeepDivePack(
  combat: any,
  finding: Finding,
  findingIndex: number,
  candidates: CandidateEvent[],
  ownerName?: string,
): DeepDivePack | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const cands = (finding.eventIds ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is CandidateEvent => !!c);
  const ts = cands
    .filter((c) => Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.t);
  if (ts.length === 0) return null;
  const durS = ((combat?.endTime ?? 0) - (combat?.startTime ?? 0)) / 1000;
  const anchorFrom = Math.max(0, Math.min(...ts) - PACK_BEFORE_S);
  const anchorTo = Math.min(durS, Math.max(...ts) + PACK_AFTER_S);
  const inWin = (t: number) => t >= anchorFrom && t <= anchorTo;

  const units = Object.values(combat?.units ?? {}) as any[];
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return null;
  const owner = ownerName
    ? friends.find((u) => u.name === ownerName)
    : undefined;
  if (!owner) return null;

  let entries: IBurstLedgerEntry[] = [];
  let healerChains: IOutgoingCCChain[] = [];
  try {
    entries = analyzeBurstLedger(owner, friends, enemies, combat);
  } catch {
    /* No advanced combat log */
  }
  try {
    const enemyHealers = new Set(
      enemies.filter((e) => isHealerSpec(e.spec)).map((e) => e.name),
    );
    healerChains = analyzeOutgoingCCChains(friends, enemies, combat).filter(
      (c) => enemyHealers.has(c.targetName),
    );
  } catch {
    /* Absent */
  }

  const raw = offensivePackItems({
    entries,
    healerChains,
    candFacts: cands.map((c) => c.facts),
    candTypes: cands.map((c) => c.type),
    ownerName,
    inWin,
  });
  if (raw.length === 0) return null;

  // Truncation: closest to focus timestamp (reuses death pack logic)
  const focusT = Math.min(...ts);
  const items: PackItem[] = raw
    .sort((a, b) => Math.abs(a.t - focusT) - Math.abs(b.t - focusT))
    .slice(0, PACK_MAX_ITEMS)
    .sort((a, b) => a.t - b.t)
    .map((it, i) => ({ ...it, key: `p${i + 1}` }));

  const facts: Record<string, string> = {};
  for (const it of items)
    for (const [k, v] of Object.entries(it.facts)) facts[`${it.key}.${k}`] = v;
  return { findingIndex, anchorFrom, anchorTo, items, facts };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add packages/analysis/src/analysis/deepDive.ts packages/analysis/src/analysis/deepDive.test.ts
git commit -m "feat(deepdive): buildOffensiveDeepDivePack + pure mapping core offensivePackItems"
```

---

### Task 3: Classifier `classifyFindingKind` + Prompt Offensive Legend + PROMPT_VERSION Bump

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts` (`classifyFindingKind` + `buildDeepDivePrompt` add offensive legend)
- Modify: `packages/desktop/src/main/ai.ts` (`PROMPT_VERSION` 11→12)
- Test: `packages/analysis/src/analysis/deepDive.test.ts`

**Interfaces:**

- Produces: `export function classifyFindingKind(finding: Finding, candidates: CandidateEvent[]): "survival" | "offensive"`

- [ ] **Step 1: Write failing tests**

```ts
import { classifyFindingKind } from "./deepDive";
import type { CandidateEvent } from "./types";

describe("classifyFindingKind (dispatch)", () => {
  const cand = (id: string, type: string): CandidateEvent => ({
    id,
    type,
    t: 10,
    unitNames: [],
    facts: {},
  });
  const cands = [
    cand("d1", "death"),
    cand("b1", "unconverted-burst"),
    cand("o1", "off-target-in-window"),
  ];
  const F = (eventIds: string[]): Finding => ({
    eventIds,
    severity: "high",
    category: "x",
    title: "x",
    explanation: "x",
  });
  it("death candidate -> survival", () => {
    expect(classifyFindingKind(F(["d1"]), cands)).toBe("survival");
  });
  it("non-death candidate -> offensive", () => {
    expect(classifyFindingKind(F(["b1"]), cands)).toBe("offensive");
    expect(classifyFindingKind(F(["o1"]), cands)).toBe("offensive");
  });
  it("mixed tie favors survival", () => {
    expect(classifyFindingKind(F(["d1", "b1"]), cands)).toBe("survival");
  });
});

describe("buildDeepDivePrompt offensive legend", () => {
  it("prints offensive item legend when offensive pack is present", () => {
    const pack = {
      findingIndex: 0,
      anchorFrom: 0,
      anchorTo: 50,
      items: [
        {
          key: "p1",
          kind: "target-hp",
          t: 44,
          label: "",
          unitNames: [],
          facts: { t: "44", hp: "18", role: "enemy-target" },
        },
      ],
      facts: { "p1.t": "44", "p1.hp": "18", "p1.role": "enemy-target" },
    } as never;
    const findings = [
      {
        eventIds: ["b1"],
        severity: "high",
        category: "x",
        title: "Burst did not kill",
        explanation: "x",
      },
    ] as never;
    const p = buildDeepDivePrompt([pack], findings, "Frost Mage", "Me-Area52");
    expect(p).toContain("kind=target-hp");
    expect(p).toContain("close it"); // Offensive coaching framework keyword
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts -t classifyFindingKind`
Expected: FAIL — `classifyFindingKind is not a function`.

- [ ] **Step 3: Implementation**

Classifier (`deepDive.ts`, containing `OFFENSIVE_CANDIDATE_TYPES` set):

```ts
const OFFENSIVE_CANDIDATE_TYPES = new Set([
  "unconverted-burst",
  "burst-into-immunity",
  "off-target-in-window",
  "juked-kick",
  "dr-clipped-cc",
]);

/** Dispatch: finding referenced candidate majority determines routing; tie favors survival (death coaching value anchor is stronger). */
export function classifyFindingKind(
  finding: Finding,
  candidates: CandidateEvent[],
): "survival" | "offensive" {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let off = 0,
    surv = 0;
  for (const id of finding.eventIds ?? []) {
    const t = byId.get(id)?.type;
    if (!t) continue;
    if (OFFENSIVE_CANDIDATE_TYPES.has(t)) off++;
    else surv++;
  }
  return off > surv ? "offensive" : "survival";
}
```

`buildDeepDivePrompt`: Insert offensive legend + offensive framework after the line `- kind=position …` in HARD RULES (printed only when any pack contains an offensive kind, avoiding noise in death-only matches):

```ts
    ...(packs.some((p) => p.items.some((it) =>
      ["target-hp","enemy-defensive","immunity","our-cc","our-cd","off-target","juked-kick","dr-clip"].includes(it.kind)))
      ? [
        `- Offensive items (non-death findings): kind=target-hp = the enemy target's HP (hp) at that moment; kind=enemy-defensive / kind=immunity = what answered ${ownerShort}'s burst on that target (immunity has overlap seconds); kind=our-cc = ${ownerShort}'s team CC landed on the enemy healer; kind=our-cd = ${ownerShort}'s team offensive cooldown; kind=off-target = damage went to the wrong target (onTargetPct); kind=juked-kick = an interrupt spent on a fake cast (fake); kind=dr-clip = a CC landed on wasted DR (dr). You had the kill set up — coach what to change to close it (swap to the exposed target, hold burst past the immunity, lock their healer first), not survival.`,
      ]
      : []),
```

(Insertion position: in `rules` array of `buildDeepDivePrompt`, between `kind=position` rule and `If, after reviewing…` rule, spread via spread operator.)

`packages/desktop/src/main/ai.ts` —— Update version number in existing line and append `;v12` segment to preserve history:

```ts
export const PROMPT_VERSION = 12; // v9: HP/short names; v10: coachable signal gate + owner anchor + clean window blanking; v11: positioning signal (fourth category); v12: offensive deep dive (non-death findings)
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/analysis/src/analysis/deepDive.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add packages/analysis/src/analysis/deepDive.ts packages/analysis/src/analysis/deepDive.test.ts packages/desktop/src/main/ai.ts
git commit -m "feat(deepdive): classifyFindingKind dispatch + prompt offensive legend + PROMPT_VERSION 12"
```

---

### Task 4: Renderer Guaranteed Offensive Slot

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx` (deep-dive trigger effect, lines ~250-289)

**Interfaces:**

- Consumes: `buildDeepDivePack` / `buildOffensiveDeepDivePack` / `hasCoachableSignal` / `hasOffensiveCoachableSignal` / `classifyFindingKind` / `DEEP_DIVE_MAX` (all from `@gladlog/analysis`).

- [ ] **Step 1: Update imports** (add three in existing `import { buildDeepDivePack, DEEP_DIVE_MAX, hasCoachableSignal, SEVERITY_RANK } from "@gladlog/analysis";`)

```ts
import {
  buildDeepDivePack,
  buildOffensiveDeepDivePack,
  classifyFindingKind,
  DEEP_DIVE_MAX,
  hasCoachableSignal,
  hasOffensiveCoachableSignal,
  SEVERITY_RANK,
} from "@gladlog/analysis";
```

- [ ] **Step 2: Update selection logic** (replace existing `for (const { f, i } of ranked) { … }` loop body)

```ts
// Survival slot: take <= DEEP_DIVE_MAX gated death packs by severity (original logic, only added survival dispatch)
const survivalPacks: DeepDivePack[] = [];
const offensivePacks: DeepDivePack[] = [];
for (const { f, i } of ranked) {
  const kind = classifyFindingKind(f, input.candidates);
  if (kind === "survival") {
    if (survivalPacks.length >= DEEP_DIVE_MAX) continue;
    const pack = buildDeepDivePack(
      legacy,
      f,
      i,
      input.candidates,
      input.ownerName,
    );
    if (pack && hasCoachableSignal(pack.items)) survivalPacks.push(pack);
  } else {
    if (offensivePacks.length >= 1) continue; // OFFENSIVE_DEEP_DIVE_MAX = 1 (guaranteed one slot)
    const pack = buildOffensiveDeepDivePack(
      legacy,
      f,
      i,
      input.candidates,
      input.ownerName,
    );
    if (pack && hasOffensiveCoachableSignal(pack.items))
      offensivePacks.push(pack);
  }
}
const packs = [...survivalPacks, ...offensivePacks];
```

(Note: `ranked` is already sorted by severity, so the offensive slot picks the most severe gated non-death finding. Variable name `packs` is reused for subsequent `deepen({ packs })` unchanged.)

- [ ] **Step 3: Run desktop tests + typecheck + lint**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
```

Expected: All green (existing StructuredAnalysisPanel related tests do not regress; behavior unchanged for matches with no non-death findings).

- [ ] **Step 4: commit**

```bash
git add packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx
git commit -m "feat(deepdive): renderer guaranteed offensive deep dive slot (survival<=2 + offensive<=1)"
```

---

### Task 5: Deterministic Scan `deepDiveOffensiveScan.ts` (Large-sample Bug Hunting)

**Files:**

- Create: `packages/eval/scripts/deepDiveOffensiveScan.ts`

**Interfaces:**

- Consumes: `extractCandidateFindings` / `buildOffensiveDeepDivePack` / `hasOffensiveCoachableSignal` / `classifyFindingKind` / `isHealerSpec` / `specToString` (`@gladlog/analysis`).

- [ ] **Step 1: Write scan script** (mirrors `deepDiveScan.ts`, for non-death candidates)

```ts
// Offensive deep dive robustness scan (deterministic): runs buildOffensiveDeepDivePack +
// hasOffensiveCoachableSignal on every non-death candidate, asserts invariants, tallies per-type gate pass rates, catches crashes / leftover digits. Does not call models.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { toLegacyMatch, CombatUnitReaction } from "@gladlog/parser-compat";
import {
  extractCandidateFindings,
  isHealerSpec,
  buildOffensiveDeepDivePack,
  hasOffensiveCoachableSignal,
  specToString,
  type Finding,
} from "@gladlog/analysis";

const OFFENSIVE = new Set([
  "unconverted-burst",
  "burst-into-immunity",
  "off-target-in-window",
  "juked-kick",
  "dr-clipped-cc",
]);
const NUMERIC_FIELDS = new Set(["t", "hp", "onTargetPct", "dr", "overlap"]);
const hasDigit = /\d/;

const dirs = process.argv.slice(2);
if (dirs.length === 0)
  throw new Error("usage: deepDiveOffensiveScan.ts <dir> [dir2 ...]");
let files: string[] = [];
for (const d of dirs)
  for (const f of readdirSync(d).filter((f) => f.endsWith(".txt")))
    files.push(join(d, f));
files = [...new Map(files.map((f) => [f.split("/").pop(), f])).values()];

let cands = 0,
  packBuilt = 0,
  gated = 0,
  packCrash = 0;
const bugs = { missingRole: 0, factsMismatch: 0, digitInName: [] as string[] };
const byType = new Map<string, { c: number; gated: number }>();
const packSizes: number[] = [];

for (const path of files) {
  const items: GladMatch[] = [];
  try {
    const p = new GladLogParser();
    p.on("match", (m: GladMatch) => items.push(m));
    p.on("shuffle", (sh: { rounds?: GladMatch[] }) => {
      for (const r of sh.rounds ?? []) items.push(r);
    });
    for (const line of readFileSync(path, "utf8").split("\n")) p.push(line);
    p.end();
  } catch {
    continue;
  }
  for (const m of items) {
    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    const players = Object.values(legacy.units).filter((u) => u.info);
    const owner =
      players.find(
        (u) =>
          u.id === legacy.playerId &&
          u.reaction === CombatUnitReaction.Friendly,
      ) ??
      players.find(
        (u) =>
          isHealerSpec(u.spec) && u.reaction === CombatUnitReaction.Friendly,
      );
    if (!owner) continue;
    let cs;
    try {
      cs = extractCandidateFindings(legacy, owner.id);
    } catch {
      continue;
    }
    for (const c of cs.filter((c) => OFFENSIVE.has(c.type))) {
      cands++;
      const st = byType.get(c.type) ?? { c: 0, gated: 0 };
      st.c++;
      const finding: Finding = {
        eventIds: [c.id],
        severity: "high",
        category: "offense",
        title: `${c.type}`,
        explanation: "x",
      };
      let pack;
      try {
        pack = buildOffensiveDeepDivePack(legacy, finding, 0, cs, owner.name);
      } catch {
        packCrash++;
        byType.set(c.type, st);
        continue;
      }
      if (pack) {
        packBuilt++;
        packSizes.push(pack.items.length);
        for (const it of pack.items) {
          if (it.facts.role === undefined) bugs.missingRole++;
          for (const [k, v] of Object.entries(it.facts))
            if (!NUMERIC_FIELDS.has(k) && hasDigit.test(v))
              bugs.digitInName.push(`${it.kind}.${k}=${v}`);
        }
        const expected = new Set<string>();
        for (const it of pack.items)
          for (const k of Object.keys(it.facts)) expected.add(`${it.key}.${k}`);
        if (expected.size !== Object.keys(pack.facts).length)
          bugs.factsMismatch++;
        if (hasOffensiveCoachableSignal(pack.items)) {
          gated++;
          st.gated++;
        }
      }
      byType.set(c.type, st);
    }
  }
}
const mean = (a: number[]) =>
  a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : "0";
console.warn(
  `Non-death candidates ${cands} · Packs built ${packBuilt} · Gated ${gated}(${packBuilt ? Math.round((100 * gated) / packBuilt) : 0}%) · Mean per pack ${mean(packSizes)} items`,
);
console.warn(`Crashes: pack ${packCrash}`);
console.warn(
  `Role missing ${bugs.missingRole} · facts<->items mismatch ${bugs.factsMismatch} · Leftover digits in names ${bugs.digitInName.length}`,
);
if (bugs.digitInName.length)
  console.warn(
    `  Samples: ${[...new Set(bugs.digitInName)].slice(0, 6).join(" · ")}`,
  );
console.warn("── By Type ──");
for (const [t, s] of byType)
  console.warn(
    `  ${t.padEnd(22)} candidates ${s.c} · gated ${s.c ? Math.round((100 * s.gated) / s.c) : 0}%`,
  );
```

- [ ] **Step 2: Run scan** (four public corpus directories)

```bash
npx tsx packages/eval/scripts/deepDiveOffensiveScan.ts \
  /Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-2v2 \
  /Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-220 \
  /Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-hi \
  /Users/mingjianliu/code/gladlog-eval-private/corpus/public-dps
```

Expected: `packCrash 0`, `missingRole 0`, `factsMismatch 0`, `digitInName 0`. If non-zero, return to Task 2 to fix (leftover digits are usually missed `sn()` or numeric fields not in NUMERIC whitelist).

- [ ] **Step 3: typecheck (eval) + eslint + commit**

```bash
npm run typecheck --workspace=packages/eval && npx eslint packages/eval/scripts/deepDiveOffensiveScan.ts --quiet
git add packages/eval/scripts/deepDiveOffensiveScan.ts
git commit -m "test(eval): offensive deep dive deterministic robustness scan (per-type gate pass rate + leftover digit/crash assertions)"
```

---

### Task 6: Large-scale Cross-AI A/B Value Eval

**Files:**

- Create: `packages/eval/scripts/deepDiveOffensiveValueGen.ts` (mirrors `deepDivePositionValueGen.ts`, buckets = offensive vs survival control anchor)
- Create: `packages/eval/scripts/deepDiveOffensiveValueAudit.ts` (mirrors `deepDivePositionValueAudit.ts`, reconstructs pack from prompt + auditDeepDives)

**Interfaces:**

- Consumes: Same analysis exports as Task 5 + `buildDeepDivePack` / `hasCoachableSignal` / `buildDeepDivePrompt` / `auditDeepDives`.

- [ ] **Step 1: Write generator** (refer to `deepDivePositionValueGen.ts`, two buckets: offensive = non-death passing `hasOffensiveCoachableSignal`; survival control = death passing `hasCoachableSignal`; `WANT_EACH` each, shuffled into blind prompts + `key.json`)

Implementation key points (not fully pasted, structure matches `deepDivePositionValueGen.ts`, only replacing pack building / gate):

- offensive bucket: `buildOffensiveDeepDivePack(legacy, finding{eventIds:[c.id]}, 0, cs, owner.name)` + `hasOffensiveCoachableSignal`, where `c` iterates through non-death candidates.
- survival bucket: `buildDeepDivePack(...)` + `hasCoachableSignal`, where `c` iterates through death candidates.
- prompt always `buildDeepDivePrompt([pack],[finding],spec,owner.name)`.
- Output `prompts/NN.txt` + `key.json` (`{ord,bucket,spec}`), mixed and shuffled.

- [ ] **Step 2: Write auditor** (refer to `deepDivePositionValueAudit.ts`; reconstructs pack facts from prompt, runs `auditDeepDives`, outputs `judge-input.json` + `unblind.json`)

Reuse regex from `deepDivePositionValueAudit.ts` (`packFromPrompt`: `key=(\S+) kind=(\S+) facts=\{(.*)\}`), runs `auditDeepDives` per resp, tallies output / blank / audit drop by bucket.

- [ ] **Step 3: Generate blind prompts**

```bash
OUT=/Users/mingjianliu/code/gladlog-eval-private/deepdive-offensive-value
rm -rf "$OUT"
npx tsx packages/eval/scripts/deepDiveOffensiveValueGen.ts \
  "/Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-2v2,/Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-220,/Users/mingjianliu/code/gladlog-eval-private/corpus/deepdive-hi,/Users/mingjianliu/code/gladlog-eval-private/corpus/public-dps" \
  "$OUT" 20
mkdir -p "$OUT/resp"
```

Expected: offensive N ≈ survival N ≈ 20, mixed ~40 prompts.

- [ ] **Step 4: Dispatch sonnet responder** (subagent, reads each prompt and produces deepDive JSON into `resp/NN.json`, writes `[]` for clean windows) —— same methodology as positioning eval responder.

- [ ] **Step 5: Audit + produce blind evaluation pack**

```bash
npx tsx packages/eval/scripts/deepDiveOffensiveValueAudit.ts /Users/mingjianliu/code/gladlog-eval-private/deepdive-offensive-value
```

Record per bucket: output rate / honest blanks / audit drops.

- [ ] **Step 6: Cross-AI blind evaluation** (reuse `JUDGE.md` from positioning eval; sonnet subagent → `judge-sonnet.json`, agy gemini → `judge-gemini.json`, redirect output to file).

- [ ] **Step 7: Unblind and compare means** (offensive vs survival control, per judge + combined; zero filler hard metric; per type).

**Decision rule:** If offensive deep dive average value falls in actionable range (>= 3.5) and both judges have zero scores <= 2 -> rollout approved. If a specific type is systematically lower / filler -> tighten `hasOffensiveCoachableSignal` for that type (no spec-customized parameters).

- [ ] **Step 8: Commit both eval scripts**

```bash
npm run typecheck --workspace=packages/eval && npx eslint packages/eval/scripts/deepDiveOffensiveValue*.ts --quiet
git add packages/eval/scripts/deepDiveOffensiveValueGen.ts packages/eval/scripts/deepDiveOffensiveValueAudit.ts
git commit -m "test(eval): offensive deep dive large-scale cross-AI A/B value eval (offensive vs survival control)"
```

---

## Wrap-up

After all 6 tasks:

- Update memory `gladlog-deepdive-value.md`: offensive deep dive (non-death findings, 5 window-based types) landed + A/B results.
- If A/B passes -> report value numbers to user; if a specific type is weak -> report + tightening recommendations.
- Version remains in main unreleased (packaged in v0.0.12); release is an independent step.
