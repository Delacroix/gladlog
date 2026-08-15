# Report Detail Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking on a meters row expands into a breakdown table by spell/source for that player's current mode (total/share/hits/crit%/max hit, healing includes overheal%).

**Architecture:** The parser exports a single-source tail parameter decoder `decodeHpTail` (the three slices in parseLine are switched to use the same function); the renderer pure derivation `deriveDetailBreakdown` directly aggregates the native event array and reconciles with the summary data; `Meters` adds an expandedUnitId local state to embed the `BreakdownTable`.

**Tech Stack:** TS + React, vitest; no new dependencies.

## Global Constraints

- Breakdown total sum must === `meterValue` under the same mode caliber (damage=damageDone, healing=healingDone+absorbsDone, taken=damageTaken), asserted in unit tests.
- Critical hit decoding is strictly single-sourced in parser (`decodeHpTail`), renderer does not copy offset logic; missing params → critPct null → `critAvailable=false` → column hidden.
- parseLine refactored as an equivalent rewrite: parser existing tests and output must not change.
- Pre-push gate (repo root): `npm test --workspace=packages/desktop && npm test --workspace=packages/parser && npm run typecheck && npx eslint packages/desktop/src --quiet`.

---

### Task 1: parser `decodeHpTail` (Single-source Tail Parameter Decoding + parseLine Refactor)

**Files:**

- Modify: `packages/parser/src/l1/decoders.ts` (append to end)
- Modify: `packages/parser/src/l1/parseLine.ts:73-95` (three slice locations switched to helper)
- Modify: `packages/parser/src/index.ts` (export)
- Test: `packages/parser/test/decodeHpTail.test.ts` (new)

**Interfaces:**

- Consumes: Existing `decodeDamage(tailParams)` / `decodeHeal(tailParams)` (same file).
- Produces (Task 2 dependency, verbatim):

```ts
export function decodeHpTail(
  eventName: string,
  params: string[],
): { critical: boolean; amount: number; effectiveAmount: number } | null;
```

- [ ] **Step 1: Write failing tests**

```ts
// packages/parser/test/decodeHpTail.test.ts
import { describe, expect, it } from "vitest";
import { decodeHpTail } from "../src/l1/decoders";

// Non-advanced SPELL_DAMAGE has 10 tail parameters: amount, base, overkill, school, resisted,
// blocked, absorbed, critical, glancing, crushing (parseLine slice(-10) branch)
const base8 = ["g1", "A", "0x511", "0x0", "g2", "B", "0x10548", "0x0"];
const spell3 = ["116", "Frostbolt", "0x10"];

describe("decodeHpTail", () => {
  it("SPELL_DAMAGE (non-advanced): amount/critical decoded", () => {
    const params = [
      ...base8,
      ...spell3,
      "38000",
      "36000",
      "0",
      "16",
      "0",
      "0",
      "0",
      "1",
      "nil",
      "nil",
    ];
    const r = decodeHpTail("SPELL_DAMAGE", params);
    expect(r).toEqual({
      critical: true,
      amount: 38000,
      effectiveAmount: 38000,
    });
  });

  it("SPELL_PERIODIC_DAMAGE non-critical + overkill deduction", () => {
    const params = [
      ...base8,
      ...spell3,
      "9000",
      "9000",
      "2000",
      "16",
      "0",
      "0",
      "0",
      "nil",
      "nil",
      "nil",
    ];
    const r = decodeHpTail("SPELL_PERIODIC_DAMAGE", params);
    expect(r).toEqual({ critical: false, amount: 9000, effectiveAmount: 7000 });
  });

  it("SPELL_HEAL: 5 tail params, overheal deduction", () => {
    const params = [...base8, ...spell3, "20000", "20000", "5000", "0", "1"];
    const r = decodeHpTail("SPELL_HEAL", params);
    expect(r).toEqual({
      critical: true,
      amount: 20000,
      effectiveAmount: 15000,
    });
  });

  it("non-hp events or insufficient parameters -> null", () => {
    expect(
      decodeHpTail("SPELL_CAST_SUCCESS", [...base8, ...spell3]),
    ).toBeNull();
    expect(decodeHpTail("SPELL_DAMAGE", ["1", "2"])).toBeNull();
    expect(decodeHpTail("SPELL_HEAL", [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/parser -- decodeHpTail`
Expected: FAIL — decodeHpTail not exported.

- [ ] **Step 3: Implement decodeHpTail and refactor parseLine**

Append to end of `decoders.ts` (slice rules moved directly from parseLine, single source going forward):

```ts
/** Tail parameter slicing rules for damage/heal events (single-source: shared between parseLine and consumers). */
export function hpTailSlice(
  eventName: string,
  params: string[],
): { kind: "damage" | "heal"; tail: string[] } | null {
  if (eventName.endsWith("_HEAL")) {
    if (params.length < 5) return null;
    return { kind: "heal", tail: params.slice(-5) };
  }
  const isSwing =
    eventName === "SWING_DAMAGE" || eventName === "SWING_DAMAGE_LANDED";
  if (!isSwing && !eventName.endsWith("_DAMAGE")) return null;
  if (params.length < 10) return null;
  const at = isSwing ? 8 : 11;
  const xIdx = findXIdx(params, at);
  const tail =
    params.length - (xIdx + 5) >= 11 ? params.slice(-11) : params.slice(-10);
  return { kind: "damage", tail };
}

/**
 * Decode damage/heal tail parameters from full params (single-source entry point for breakdown crits/amounts).
 * Non-hp events or insufficient parameters -> null (when trimmed doc has no params, consumer passes [] and receives null).
 */
export function decodeHpTail(
  eventName: string,
  params: string[],
): { critical: boolean; amount: number; effectiveAmount: number } | null {
  const sliced = hpTailSlice(eventName, params);
  if (!sliced) return null;
  const d =
    sliced.kind === "heal"
      ? decodeHeal(sliced.tail)
      : decodeDamage(sliced.tail);
  return {
    critical: d.critical,
    amount: d.amount,
    effectiveAmount: d.effectiveAmount,
  };
}
```

Note: `findXIdx` is currently in parseLine.ts — **move** it to decoders.ts (export it), and in parseLine `import { findXIdx }`; or inversely leave hpTailSlice exported from parseLine. Pick based on avoiding circular dependencies (decoders should not import parseLine → move findXIdx to decoders).

Three modifications in parseLine.ts (equivalent rewrite):

```ts
// SWING_DAMAGE / SWING_DAMAGE_LANDED branch:
result.advanced = decodeAdvanced(params, 8);
const swingTail = hpTailSlice(eventName, params);
if (swingTail) result.damage = decodeDamage(swingTail.tail);

// endsWith("_DAMAGE") branch:
result.advanced = decodeAdvanced(params, 11);
const dmgTail = hpTailSlice(eventName, params);
if (dmgTail) result.damage = decodeDamage(dmgTail.tail);

// endsWith("_HEAL") branch:
result.advanced = decodeAdvanced(params, 11);
const healTail = hpTailSlice(eventName, params);
if (healTail) result.heal = decodeHeal(healTail.tail);
```

Add `decodeHpTail, hpTailSlice` to the decoders export block in `packages/parser/src/index.ts`.

- [ ] **Step 4: Run all parser tests (equivalence verification)**

Run: `npm test --workspace=packages/parser`
Expected: 4 new tests pass + all existing green (slicing behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/parser/src packages/parser/test/decodeHpTail.test.ts
git commit -m "feat(parser): export decodeHpTail/hpTailSlice -- single-source hp tail param decoding, parseLine uses unified slice"
```

---

### Task 2: `derive/detailBreakdown.ts` (Aggregation + Reconciliation)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/detailBreakdown.ts`
- Test: `packages/desktop/test/report.detailbreakdown.test.ts` (new)

**Interfaces:**

- Consumes: Task 1 `decodeHpTail(eventName, params)` (`@gladlog/parser`); `deriveSummary`/`meterValue` (used for reconciliation tests); `ReportSource` (`./types`).
- Produces (Task 3 dependency, verbatim):

```ts
export interface BreakdownRow {
  key: string;
  label: string;
  spellId: string;
  total: number;
  sharePct: number;
  hits: number;
  maxHit: number;
  critPct: number | null;
  overhealPct?: number;
  isAbsorb?: boolean;
}
export function deriveDetailBreakdown(
  source: ReportSource,
  unitId: string,
  mode: "damage" | "healing" | "taken",
): { rows: BreakdownRow[]; critAvailable: boolean };
```

- [ ] **Step 1: Write failing tests**

```ts
// packages/desktop/test/report.detailbreakdown.test.ts
import { describe, expect, it } from "vitest";

import { deriveDetailBreakdown } from "../src/renderer/src/report/derive/detailBreakdown";
import { meterValue } from "../src/renderer/src/report/derive/meterRows";
import { deriveSummary } from "../src/renderer/src/report/derive/summary";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const base = loadRealMatchFixture();
const src = base as unknown as ReportSource;

describe("deriveDetailBreakdown", () => {
  it("three-mode sums reconcile with meterValue (all players)", () => {
    for (const t of deriveSummary(src)) {
      for (const mode of ["damage", "healing", "taken"] as const) {
        const { rows } = deriveDetailBreakdown(src, t.unitId, mode);
        const sum = rows.reduce((a, r) => a + r.total, 0);
        expect(Math.round(sum)).toBe(Math.round(meterValue(t, mode)));
      }
    }
  });

  it("damage: descending by total, share sum ≈ 100, hits/maxHit populated", () => {
    const t = deriveSummary(src)[0]!; // highest damage dealer
    const { rows } = deriveDetailBreakdown(src, t.unitId, "damage");
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.total).toBeLessThanOrEqual(rows[i - 1]!.total);
    const share = rows.reduce((a, r) => a + r.sharePct, 0);
    expect(share).toBeGreaterThan(99);
    expect(share).toBeLessThan(101);
    expect(rows[0]!.hits).toBeGreaterThan(0);
    expect(rows[0]!.maxHit).toBeGreaterThan(0);
  });

  it("clipped fixture without params -> critAvailable=false", () => {
    const t = deriveSummary(src)[0]!;
    const { critAvailable, rows } = deriveDetailBreakdown(
      src,
      t.unitId,
      "damage",
    );
    expect(critAvailable).toBe(false);
    expect(rows.every((r) => r.critPct === null)).toBe(true);
  });

  it("injected synthetic damage with params -> critPct correct (2 crits / 4 hits = 50%)", () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const u = Object.values(clone.units).find(
      (x) => (x as { kind?: string }).kind === "Player",
    ) as unknown as {
      id: string;
      damageOut: Array<Record<string, unknown>>;
    };
    const base8 = ["g1", "A", "0x511", "0x0", "g2", "B", "0x10548", "0x0"];
    const spell3 = ["999001", "TestBolt", "0x10"];
    const mk = (crit: boolean) => ({
      timestamp: clone.startTime + 1000,
      eventName: "SPELL_DAMAGE",
      spellId: 999001,
      spellName: "TestBolt",
      srcId: u.id,
      srcName: "A",
      destId: "g2",
      destName: "B",
      amount: 1000,
      effectiveAmount: 1000,
      params: [
        ...base8,
        ...spell3,
        "1000",
        "1000",
        "0",
        "16",
        "0",
        "0",
        "0",
        crit ? "1" : "nil",
        "nil",
        "nil",
      ],
    });
    u.damageOut.push(mk(true), mk(true), mk(false), mk(false));
    const { rows, critAvailable } = deriveDetailBreakdown(
      clone as unknown as ReportSource,
      u.id,
      "damage",
    );
    const row = rows.find((r) => r.spellId === "999001");
    expect(critAvailable).toBe(true);
    expect(row!.critPct).toBe(50);
    expect(row!.hits).toBe(4);
    expect(row!.maxHit).toBe(1000);
  });

  it("healing: absorbsOut yields isAbsorb rows, overheal% within bounds", () => {
    const healer = deriveSummary(src)
      .slice()
      .sort(
        (a, b) =>
          b.healingDone + b.absorbsDone - (a.healingDone + a.absorbsDone),
      )[0]!;
    const { rows } = deriveDetailBreakdown(src, healer.unitId, "healing");
    for (const r of rows) {
      if (r.overhealPct !== undefined) {
        expect(r.overhealPct).toBeGreaterThanOrEqual(0);
        expect(r.overhealPct).toBeLessThanOrEqual(100);
      }
      if (r.isAbsorb) expect(r.overhealPct).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/report.detailbreakdown.test.ts --root packages/desktop`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implementation**

```ts
// packages/desktop/src/renderer/src/report/derive/detailBreakdown.ts
import { decodeHpTail } from "@gladlog/parser";

import type { ReportSource } from "./types";

export interface BreakdownRow {
  key: string;
  label: string;
  spellId: string;
  total: number;
  sharePct: number;
  hits: number;
  maxHit: number;
  critPct: number | null;
  overhealPct?: number;
  isAbsorb?: boolean;
}

interface HpEventLike {
  eventName?: string;
  spellId?: number | string;
  spellName?: string;
  srcName?: string;
  amount?: number;
  effectiveAmount?: number;
  params?: string[];
}
interface AbsorbEventLike {
  spellId?: number | string;
  spellName?: string;
  absorbedAmount?: number;
}
interface UnitLike {
  id: string;
  name: string;
  ownerId?: string;
  damageOut?: HpEventLike[];
  damageIn?: HpEventLike[];
  healOut?: HpEventLike[];
  absorbsOut?: AbsorbEventLike[];
}

interface Acc {
  label: string;
  spellId: string;
  total: number;
  totalRaw: number; // sum of amount (used for healing overheal%)
  hits: number;
  maxHit: number;
  crits: number;
  critKnown: number; // count of events with decodable params
  isAbsorb?: boolean;
}

const acc = (
  map: Map<string, Acc>,
  key: string,
  seed: Pick<Acc, "label" | "spellId"> & Partial<Pick<Acc, "isAbsorb">>,
): Acc => {
  let a = map.get(key);
  if (!a) {
    a = {
      ...seed,
      total: 0,
      totalRaw: 0,
      hits: 0,
      maxHit: 0,
      crits: 0,
      critKnown: 0,
    };
    map.set(key, a);
  }
  return a;
};

function addHp(a: Acc, e: HpEventLike): void {
  const eff = e.effectiveAmount ?? 0;
  a.total += eff;
  a.totalRaw += e.amount ?? eff;
  a.hits += 1;
  a.maxHit = Math.max(a.maxHit, eff);
  // Single-source crits: parser decodeHpTail; missing params (old/clipped doc) -> not counted in critKnown
  const tail = decodeHpTail(e.eventName ?? "", e.params ?? []);
  if (tail) {
    a.critKnown += 1;
    if (tail.critical) a.crits += 1;
  }
}

/**
 * Report detail breakdown (backlog #11 / spec 2026-07-18-report-detail-breakdown):
 * Uses same event source and summation caliber as derive/summary -- breakdown sum is always equal to meterValue.
 */
export function deriveDetailBreakdown(
  source: ReportSource,
  unitId: string,
  mode: "damage" | "healing" | "taken",
): { rows: BreakdownRow[]; critAvailable: boolean } {
  const units = Object.values(source.units) as unknown as UnitLike[];
  const self = units.find((u) => u.id === unitId);
  if (!self) return { rows: [], critAvailable: false };
  const pets = units.filter((u) => u.ownerId === unitId);
  const map = new Map<string, Acc>();

  if (mode === "taken") {
    for (const e of self.damageIn ?? []) {
      const src = (e.srcName ?? "?").split("-")[0];
      const key = `${e.srcName}:${e.spellId}`;
      addHp(
        acc(map, key, {
          label: `${src}:${e.spellName || "Melee"}`,
          spellId: String(e.spellId ?? 0),
        }),
        e,
      );
    }
  } else {
    const own = [{ unit: self, prefix: "" }].concat(
      pets.map((p) => ({ unit: p, prefix: `${p.name.split("-")[0]}:` })),
    );
    for (const { unit, prefix } of own) {
      const events =
        mode === "damage" ? (unit.damageOut ?? []) : (unit.healOut ?? []);
      for (const e of events) {
        const key = `${prefix}${e.spellId}`;
        addHp(
          acc(map, key, {
            label: `${prefix}${e.spellName || "Melee"}`,
            spellId: String(e.spellId ?? 0),
          }),
          e,
        );
      }
      if (mode === "healing") {
        for (const e of unit.absorbsOut ?? []) {
          const key = `ab:${prefix}${e.spellId}`;
          const a = acc(map, key, {
            label: `${prefix}${e.spellName || "Absorb"}`,
            spellId: String(e.spellId ?? 0),
            isAbsorb: true,
          });
          const amt = e.absorbedAmount ?? 0;
          a.total += amt;
          a.totalRaw += amt;
          a.hits += 1;
          a.maxHit = Math.max(a.maxHit, amt);
        }
      }
    }
  }

  const grand = [...map.values()].reduce((s, a) => s + a.total, 0) || 1;
  const rows: BreakdownRow[] = [...map.entries()]
    .map(([key, a]) => ({
      key,
      label: a.label,
      spellId: a.spellId,
      total: a.total,
      sharePct: (a.total / grand) * 100,
      hits: a.hits,
      maxHit: a.maxHit,
      critPct:
        a.critKnown > 0 ? Math.round((a.crits / a.critKnown) * 100) : null,
      ...(mode === "healing" && !a.isAbsorb
        ? {
            overhealPct:
              a.totalRaw > 0
                ? Math.round(((a.totalRaw - a.total) / a.totalRaw) * 100)
                : 0,
          }
        : {}),
      ...(a.isAbsorb ? { isAbsorb: true as const } : {}),
    }))
    .sort((a, b) => b.total - a.total);
  return { rows, critAvailable: rows.some((r) => r.critPct !== null) };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/report.detailbreakdown.test.ts --root packages/desktop`
Expected: PASS (5 tests). If reconciliation test fails → find missing aggregation items (e.g. healing missing absorbs or pets), **do NOT alter reconciliation assertions**.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/derive/detailBreakdown.ts packages/desktop/test/report.detailbreakdown.test.ts
git commit -m "feat(desktop): deriveDetailBreakdown -- aggregate by spell/source, reconcile sum with meterValue"
```

---

### Task 3: `BreakdownTable` + Meters Inline Expansion

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/BreakdownTable.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/Meters.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx:99-109` (pass source to Meters)
- Modify: `packages/desktop/src/renderer/src/styles.css` (append to end)
- Test: `packages/desktop/test/report.breakdowntable.test.tsx` (new)

**Interfaces:**

- Consumes: Task 2 `deriveDetailBreakdown(source, unitId, mode)` / `BreakdownRow`; `SPELL_ICONS_GENERATED` (`@gladlog/analysis`); `SpellIcon({icon, label, size})`.
- Produces: `BreakdownTable({ rows, critAvailable, mode })`; `Meters` new optional props `source?: ReportSource` (when omitted → no expansion ability, backward compatible).

- [ ] **Step 1: Write failing tests**

```tsx
// packages/desktop/test/report.breakdowntable.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Meters } from "../src/renderer/src/report/components/Meters";
import { deriveSummary } from "../src/renderer/src/report/derive/summary";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const src = loadRealMatchFixture() as unknown as ReportSource;
const rows = deriveSummary(src);

describe("Meters inline detail expansion (backlog #11)", () => {
  it("click row body expands breakdown table, click again collapses; only one expanded at a time", () => {
    const { container } = render(
      <Meters rows={rows} mode="damage" source={src} />,
    );
    const bars = container.querySelectorAll(".rpt-meter-clickable");
    expect(bars.length).toBeGreaterThan(1);
    fireEvent.click(bars[0]!);
    expect(container.querySelectorAll(".rpt-breakdown")).toHaveLength(1);
    // Expanded table contains spell rows
    expect(
      container.querySelectorAll(".rpt-breakdown tbody tr").length,
    ).toBeGreaterThan(0);
    fireEvent.click(bars[1]!);
    expect(container.querySelectorAll(".rpt-breakdown")).toHaveLength(1);
    fireEvent.click(bars[1]!);
    expect(container.querySelectorAll(".rpt-breakdown")).toHaveLength(0);
  });

  it("clipped fixture without params -> no crit column; >8 rows fold into 'Other N (total)'", () => {
    const { container } = render(
      <Meters rows={rows} mode="damage" source={src} />,
    );
    fireEvent.click(container.querySelectorAll(".rpt-meter-clickable")[0]!);
    expect(screen.queryByText("Crit")).toBeNull();
    const trs = container.querySelectorAll(".rpt-breakdown tbody tr");
    expect(trs.length).toBeLessThanOrEqual(9); // 8 + potential fold row
  });

  it("name button remains visibility toggle, does not trigger expansion", () => {
    const toggled: string[] = [];
    const { container } = render(
      <Meters
        rows={rows}
        mode="damage"
        source={src}
        onToggleUnit={(id) => toggled.push(id)}
      />,
    );
    fireEvent.click(container.querySelector(".rpt-meter-name")!);
    expect(toggled).toHaveLength(1);
    expect(container.querySelectorAll(".rpt-breakdown")).toHaveLength(0);
  });

  it("when source is omitted (legacy call signature) -> row is not expandable without throwing", () => {
    const { container } = render(<Meters rows={rows} mode="damage" />);
    expect(container.querySelectorAll(".rpt-meter-clickable")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/report.breakdowntable.test.tsx --root packages/desktop`
Expected: FAIL — rpt-meter-clickable does not exist / source prop unknown.

- [ ] **Step 3: Implement BreakdownTable**

```tsx
// packages/desktop/src/renderer/src/report/components/BreakdownTable.tsx
import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import type { BreakdownRow } from "../derive/detailBreakdown";
import { SpellIcon } from "./SpellIcon";

const TOP_N = 8;
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Breakdown table by spell/source inside meters row (spec 2026-07-18-report-detail-breakdown). */
export function BreakdownTable({
  rows,
  critAvailable,
  mode,
}: {
  rows: BreakdownRow[];
  critAvailable: boolean;
  mode: "damage" | "healing" | "taken";
}) {
  if (rows.length === 0)
    return <div className="rpt-breakdown rpt-breakdown-empty">No data</div>;
  const top = rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const restTotal = rest.reduce((a, r) => a + r.total, 0);
  const restShare = rest.reduce((a, r) => a + r.sharePct, 0);
  const showOverheal = mode === "healing";
  return (
    <table className="rpt-breakdown">
      <thead>
        <tr>
          <th>Spell</th>
          <th>Total</th>
          <th>Share</th>
          <th>Hits</th>
          {critAvailable && <th>Crit</th>}
          {showOverheal && <th>Overheal</th>}
          <th>Max Hit</th>
        </tr>
      </thead>
      <tbody>
        {top.map((r) => (
          <tr key={r.key}>
            <td className="rpt-breakdown-spell">
              <SpellIcon
                icon={SPELL_ICONS_GENERATED[r.spellId]}
                label={r.label}
              />{" "}
              {r.label}
              {r.isAbsorb && <span className="rpt-breakdown-tag">Absorb</span>}
            </td>
            <td>{fmt(r.total)}</td>
            <td>{r.sharePct.toFixed(0)}%</td>
            <td>{r.hits}</td>
            {critAvailable && (
              <td>{r.critPct !== null ? `${r.critPct}%` : "—"}</td>
            )}
            {showOverheal && (
              <td>{r.overhealPct !== undefined ? `${r.overhealPct}%` : "—"}</td>
            )}
            <td>{fmt(r.maxHit)}</td>
          </tr>
        ))}
        {rest.length > 0 && (
          <tr className="rpt-breakdown-rest">
            <td>Other {rest.length} (Total)</td>
            <td>{fmt(restTotal)}</td>
            <td>{restShare.toFixed(0)}%</td>
            <td
              colSpan={2 + (critAvailable ? 1 : 0) + (showOverheal ? 1 : 0)}
            />
          </tr>
        )}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Meters expansion wiring**

Meters.tsx changes (props adds `source?: ReportSource`; row body clickable; single open state):

```tsx
// Imports additions
import { useState } from "react";
import { deriveDetailBreakdown } from "../derive/detailBreakdown";
import type { ReportSource } from "../derive/types";
import { BreakdownTable } from "./BreakdownTable";

// Props addition (destructuring + type):
//   /** Detail expansion data source (backlog #11); when omitted, rows are not expandable (legacy callers). */
//   source?: ReportSource;

// Inside component body:
const [expandedUnitId, setExpandedUnitId] = useState<string | null>(null);
const expandable = source != null && mode !== "stats";

// Inside items.map, wrap the bar+value part of the original <div className="rpt-meter-row">:
// (name button remains untouched outside; clicking bar/value toggles expansion)
<span
  className={
    expandable ? "rpt-meter-body rpt-meter-clickable" : "rpt-meter-body"
  }
  onClick={
    expandable
      ? () => setExpandedUnitId((cur) => (cur === r.unitId ? null : r.unitId))
      : undefined
  }
>
  <span className="rpt-meter-bar-track">
    <span
      className="rpt-meter-bar"
      style={{ width: `${r.widthPct}%`, background: r.color }}
    />
  </span>
  <span className="rpt-meter-value">{r.label}</span>
</span>;
// After row (still inside outer fragment of that unit):
{
  expandable && expandedUnitId === r.unitId && (
    <BreakdownTable
      {...deriveDetailBreakdown(
        source,
        r.unitId,
        mode as "damage" | "healing" | "taken",
      )}
      mode={mode as "damage" | "healing" | "taken"}
    />
  );
}
```

Outer map needs to wrap `<div className="rpt-meter-row">…</div>` and expansion table in `<div key={r.unitId} className="rpt-meter-unit">` (key moves from row to wrapping layer). Collapse on mode change: `useEffect(() => setExpandedUnitId(null), [mode])`.

Add `source={source}` to `<Meters … />` call in MatchReport.tsx (if ShuffleReport has independent calls, add there too; grep `<Meters` to verify all call sites).

- [ ] **Step 5: CSS (append to end of styles.css)**

```css
/* ── Report detail breakdown (meters inline expansion) ── */
.rpt-meter-body {
  display: contents;
}
.rpt-meter-clickable {
  cursor: pointer;
}
.rpt-meter-unit .rpt-meter-clickable:hover .rpt-meter-value {
  color: var(--gold);
}
.rpt-breakdown {
  width: 100%;
  margin: 4px 0 10px;
  border-collapse: collapse;
  font-size: 12px;
}
.rpt-breakdown th {
  text-align: left;
  color: var(--mute);
  font-weight: 500;
  padding: 2px 8px;
  border-bottom: 1px solid var(--hairline);
}
.rpt-breakdown td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--hairline-soft);
  font-variant-numeric: tabular-nums;
}
.rpt-breakdown-spell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rpt-breakdown-tag {
  font-size: 10px;
  color: var(--ink-2);
  border: 1px solid var(--hairline);
  border-radius: 3px;
  padding: 0 4px;
}
.rpt-breakdown-rest td {
  color: var(--mute);
}
.rpt-breakdown-empty {
  color: var(--mute);
  font-size: 12px;
  padding: 4px 8px;
}
```

Note: `.rpt-meter-row` is currently a flex row — `rpt-meter-body { display: contents }` keeps the wrapper span from breaking original layout; if layout collapses during implementation, change body to `display: flex; flex: 1; align-items: center; gap: same as original row` and fine-tune.

- [ ] **Step 6: Run tests + full gate**

Run (repo root): `npx vitest run test/report.breakdowntable.test.tsx --root packages/desktop`, then
`npm test --workspace=packages/desktop && npm test --workspace=packages/parser && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: All 4 new tests pass; existing Meters/report tests do not regress (if row structure changes break existing assertions, update assertions to match new DOM, do not drop functionality).

- [ ] **Step 7: Commit + push + CI**

```bash
git add -A ':!package-lock.json'
git commit -m "feat(desktop): report detail breakdown -- meters inline expansion by spell/source (backlog #11)"
git push
RUN=$(gh run list --workflow test.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch --exit-status $RUN
```

Expected: CI success.

---

## Self-Review Notes

- Spec coverage: decodeHpTail single source (T1), three-mode aggregation + reconciliation + crits/overheal (T2), inline expansion / single open / name button isolation / fold row / column hiding (T3) ✓; "stats mode unchanged" = expandable excludes stats ✓; ShuffleReport reuse = call site grep ✓.
- Placeholder scan: No TBDs; CSS fallback plan is an explicit instruction, not a placeholder ✓.
- Type consistency: BreakdownRow / deriveDetailBreakdown / BreakdownTable / `source?: ReportSource` are consistent across all three locations ✓.
