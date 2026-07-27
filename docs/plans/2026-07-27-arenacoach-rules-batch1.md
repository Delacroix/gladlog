# arenacoach 规则吸收第一批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 arenacoach.gg 21 条规则里对 gladlog 价值最高、且**不需要新白名单表**的三条确定性谓词做进 candidateFindings 候选层:死亡时保命技可用未按(DEATH-001)、队友阵亡时外减可用未给(DEATH-003)、中立局面浪费 PvP 饰品(TRINKET-001)。

**Architecture:** 三条规则全部实现为 `packages/analysis` 的纯函数候选提取器(hand-built fixture 可单测),集成进 `extractCandidateFindings` 既有菜单;下游三处表态(prompt 类型指南 / renderer 失误规则表 / deepDive 分类自动落 survival)。全部判定复用既有共享谓词:`extractMajorCooldowns` 的 `availableWindows`/`casts`、`analyzePlayerCCAndTrinket` 的 CC/饰品摘要、`getUnitHpAtTimestamp`(HP_SAMPLE_RADIUS_MS)、`isAllyCastableDefensive`、`USABLE_WHILE_CC_SPELL_IDS`、`reconstructEnemyCDTimeline`。**零新增法术白名单**。

**Tech Stack:** TypeScript(analysis 包纯函数 + vitest hand-built fixture)、desktop renderer(mistakes 规则表)、eval 语料扫描。

## Global Constraints

- **谓词单源(CLAUDE.md 铁律)**:同一事实的两个消费者 import 同一函数/常量。本计划的共享点:`cdAvailableAt`(Task 1 新建,Task 2/3 消费,`deathSetupEvents` 的 defensive-early 重构为同源)、`HP_SAMPLE_RADIUS_MS`(Task 4 传给 `getUnitHpAtTimestamp` 的 maxDtMs)、`fmtFactNum`(所有 facts 数值渲染)。
- **facts 锚定渲染值**:所有进 facts 的时刻/数值必须过 `fmtFactNum`(`factFormat.ts` 的 `fmt`),门规复算才对得上。
- 类型检查只用 `npm run typecheck`(绝不 `tsc -b`)。
- 提交方式:直接 commit+push main,不建分支不开 PR;每个 Task 一个 commit。
- 门禁链不加管道(`npm run typecheck | tail` 禁止——退出码会被吃掉)。
- 复合命令不 `cd`;需要时用 `(cd … && …)` 子壳。
- push 前:`npm run presubmit`(全 workspace,覆盖 CI 的 5 步)。
- 新类型必须在 renderer 的 `MISTAKE_RULES` 或 `IGNORED_CANDIDATE_TYPES` 表态(`report.mistakes.test` 清单测试强制)。
- 只抄 arenacoach 的**判定谓词与阈值**,不抄任何描述文案(版权)。
- 功能落地后按「修复要给前后数字」惯例给语料发生率数字(Task 6),给不出就明说。

## 判定谓词规格(来自 arenacoach 公开目录,阈值为其 25 万场调参值)

| 新类型                   | 判定                                                                                                                                                                                                         | 关键阈值                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `death-unused-defensive` | owner 自己死亡时,存在 tag=Defensive 且非 throughput 的大保命技处于可用状态;且 owner「自由」:死亡时刻不在 CC 中,或在 CC 中但饰品可用,或该技能可在 CC 中施放(USABLE_WHILE_CC);Forbearance 期内的圣盾类不算可用 | 每死亡 ≤1 条,facts 列 ≤3 个技能            |
| `external-unused`        | 友方队友(≠owner)死亡时,owner 存活、有 ally-castable 外减可用、且死亡前窗口内 owner 有 ≥1.5s 不在 CC 的空档                                                                                                   | 空档窗口=[deathT−5s, deathT],最小空档 1.5s |
| `wasted-trinket`         | owner 的一次饰品使用发生在「中立局面」:全体友方 HP≥80%(共享采样谓词,任何人采不到样保守不发)+ 友方治疗不在 CC 中 + 无敌方进攻 CD buff 生效中                                                                  | HP 阈值 80%,采样半径 HP_SAMPLE_RADIUS_MS   |

---

### Task 1: 共享可用性谓词 `cdAvailableAt`

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts`(`IMajorCooldownInfo` 定义之后新增 export)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts:605-615`(defensive-early 的 `readyAt` 手算改为消费新谓词)
- Modify: `packages/analysis/src/index.ts`(barrel export,若 cooldowns 面已 re-export 则跟随现状)
- Test: `packages/analysis/test/cdAvailableAt.test.ts`(新建)

**Interfaces:**

- Consumes: `IMajorCooldownInfo`(现有)、`lastCastBefore`(`src/context/timelineHelpers.ts`,现有)
- Produces: `export function cdAvailableAt(cd: Pick<IMajorCooldownInfo, "casts" | "cooldownSeconds" | "neverUsed">, tSeconds: number): boolean` —— Task 2/3 依赖

- [ ] **Step 1: 写失败测试**

```ts
// packages/analysis/test/cdAvailableAt.test.ts
import { describe, expect, it } from "vitest";
import { cdAvailableAt } from "../src/utils/cooldowns";

const cast = (timeSeconds: number) => ({ timeSeconds });

describe("cdAvailableAt(死亡时刻可用性——defensive-early 的镜像谓词)", () => {
  it("从未使用 → 全程可用", () => {
    expect(
      cdAvailableAt({ casts: [], cooldownSeconds: 120, neverUsed: true }, 45),
    ).toBe(true);
  });
  it("上次使用 + CD 已转好 → 可用", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(10)], cooldownSeconds: 60, neverUsed: false },
        75, // readyAt = 70 ≤ 75
      ),
    ).toBe(true);
  });
  it("上次使用 + CD 未转好 → 不可用", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(30)], cooldownSeconds: 60, neverUsed: false },
        75, // readyAt = 90 > 75
      ),
    ).toBe(false);
  });
  it("多次施放取 t 之前最近一次", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(10), cast(80)], cooldownSeconds: 60, neverUsed: false },
        100, // last before 100 = 80, readyAt = 140 > 100
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --root packages/analysis test/cdAvailableAt.test.ts`
Expected: FAIL — `cdAvailableAt` is not exported

- [ ] **Step 3: 最小实现**

在 `cooldowns.ts` 的 `IMajorCooldownInfo` 定义后新增(`lastCastBefore` 在 `timelineHelpers.ts`,注意 import 方向:cooldowns.ts 若引它会成环则把实现放 `timelineHelpers.ts` 并从 cooldowns re-export——以实际 import 图为准,谓词只能有一份):

```ts
/**
 * t 时刻该大 CD 是否可用。与 deathSetupEvents 的 defensive-early(readyAt
 * 手算)同源:那边判「死亡时不可用且用早了」,这边是它的补集消费方
 * (death-unused-defensive / external-unused 判「死亡时可用却没按」)。
 */
export function cdAvailableAt(
  cd: Pick<IMajorCooldownInfo, "casts" | "cooldownSeconds" | "neverUsed">,
  tSeconds: number,
): boolean {
  const last = [...cd.casts].filter((c) => c.timeSeconds <= tSeconds).pop();
  if (!last) return true; // t 之前从未用过(含 neverUsed)
  return last.timeSeconds + cd.cooldownSeconds <= tSeconds;
}
```

- [ ] **Step 4: 重构 defensive-early 消费同一谓词**

`candidateFindings.ts` deathSetupEvents 内 `const readyAt = last.timeSeconds + cd.cooldownSeconds; if (readyAt <= deathT) continue;` 改为 `if (cdAvailableAt(cd as IMajorCooldownInfo, deathT)) continue;`(语义等价:可用 → 不是"提前用掉"链)。保留 `lastCastBefore` 取 `last` 用于时刻/标签。

- [ ] **Step 5: 跑新测试 + candidateFindings 既有测试**

Run: `npx vitest run --root packages/analysis test/cdAvailableAt.test.ts src/analysis/candidateFindings.test.ts`
Expected: 全 PASS(重构不改变 defensive-early 行为)

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(analysis): cdAvailableAt 共享可用性谓词 —— defensive-early 重构同源,为 arenacoach 批次铺路"
```

---

### Task 2: `death-unused-defensive`(DEATH-001 死亡时保命技可用未按)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts`(新增纯函数 + 接线进 `extractDeathSetups`)
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts`(新增 describe)

**Interfaces:**

- Consumes: `cdAvailableAt`(Task 1)、`DeathSetupParts`(现有,复用其 victimCC/victimCDs 切片)、`USABLE_WHILE_CC_SPELL_IDS`、`FORBEARANCE_GATED_IDS`+`selfForbearanceActiveAt`(`utils/cooldowns.ts` 现有)、`fmt`(factFormat)
- Produces: `export function deathUnusedDefensiveEvents(parts: DeathSetupParts, victim: { isOwner: boolean; unit?: any }, combat?: any): CandidateEvent[]`(签名以实测 `selfForbearanceActiveAt` 参数为准);候选 type 字符串 `"death-unused-defensive"`,id 形如 `death-unused-defensive:<victimId>:<round(deathT)>`,facts `{ t, unit, walls, free }` —— Task 5 依赖此 type 与 facts 键名

- [ ] **Step 1: 写失败测试(hand-built parts,镜像 deathSetupEvents 测试风格)**

```ts
describe("death-unused-defensive(死亡时保命技可用未按)", () => {
  const wall = (over: Partial<IMajorCooldownInfo> = {}) => ({
    spellId: "108271", // Astral Shift
    spellName: "Astral Shift",
    tag: "Defensive",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const base = {
    deathT: 100,
    victim: { id: "p1", name: "Me-R" },
    victimCDs: [wall()],
    victimCC: { ccInstances: [], trinketUseTimes: [] },
  };

  it("可用保命技 + 死亡时不在 CC → 发一条,facts 列技能与 free=yes", () => {
    const ev = deathUnusedDefensiveEvents(base, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("death-unused-defensive");
    expect(ev[0]!.facts.walls).toContain("Astral Shift");
    expect(ev[0]!.facts.free).toBe("yes");
  });

  it("非 owner 的死亡 → 不发(指摘只对 owner)", () => {
    expect(deathUnusedDefensiveEvents(base, { isOwner: false })).toEqual([]);
  });

  it("保命技死亡时在 CD → 不发", () => {
    const p = {
      ...base,
      victimCDs: [wall({ casts: [{ timeSeconds: 50 }], neverUsed: false })],
    }; // readyAt=140 > deathT=100
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("死亡时在 CC 且饰品在 CD → 不自由,不发", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [40],
      },
    };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("死亡时在 CC 但饰品可用 → 仍发(free=trinket_in_hand)", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "available_unused",
          },
        ],
        trinketUseTimes: [],
      },
    };
    const ev = deathUnusedDefensiveEvents(p, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.facts.free).toBe("trinket_in_hand");
  });

  it("throughput 型不算保命技 → 不发", () => {
    const p = { ...base, victimCDs: [wall({ isThroughput: true })] };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `deathUnusedDefensiveEvents` 未定义

- [ ] **Step 3: 最小实现**

```ts
/** 每死亡 facts 里最多列出的可用保命技数。 */
const UNUSED_DEFENSIVE_MAX_LISTED = 3;

/**
 * death-unused-defensive:owner 死亡时有保命技可用却没按(arenacoach
 * DEATH-001 谓词,阈值同源)。"自由"判定:死亡时刻不在 CC 中,或在 CC 中
 * 但饰品可用(available_unused/available),或技能可在 CC 中施放
 * (USABLE_WHILE_CC_SPELL_IDS)。圣盾类在 Forbearance 期内不算可用。
 */
export function deathUnusedDefensiveEvents(
  parts: DeathSetupParts,
  victim: { isOwner: boolean; unit?: any },
  combat?: any,
): CandidateEvent[] {
  if (!victim.isOwner) return [];
  const { deathT } = parts;
  const ccAtDeath = parts.victimCC?.ccInstances.find(
    (cc) =>
      cc.atSeconds <= deathT && cc.atSeconds + cc.durationSeconds >= deathT,
  );
  const freeState = !ccAtDeath
    ? "yes"
    : ccAtDeath.trinketState !== "on_cooldown"
      ? "trinket_in_hand"
      : null; // 在 CC 且无饰品:整体不自由,仅 USABLE_WHILE_CC 技能可豁免

  const walls = (parts.victimCDs ?? []).filter((cd) => {
    if (cd.tag !== "Defensive") return false;
    if ((cd as IMajorCooldownInfo).isThroughput) return false;
    if (!cdAvailableAt(cd as IMajorCooldownInfo, deathT)) return false;
    if (freeState === null && !USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId))
      return false;
    if (
      FORBEARANCE_GATED_IDS.has(cd.spellId) &&
      victim.unit &&
      combat &&
      selfForbearanceActiveAt(victim.unit, combat, deathT) // 签名以实际为准
    )
      return false;
    return true;
  });
  if (walls.length === 0) return [];
  return [
    {
      id: `death-unused-defensive:${parts.victim.id}:${Math.round(deathT)}`,
      type: "death-unused-defensive",
      t: deathT,
      unitNames: [parts.victim.name],
      facts: {
        t: fmt(deathT),
        unit: parts.victim.name,
        walls: walls
          .slice(0, UNUSED_DEFENSIVE_MAX_LISTED)
          .map((w) => w.spellName)
          .join(", "),
        free: freeState ?? "usable_in_cc",
      },
    },
  ];
}
```

接线:`extractDeathSetups` 签名加 `ownerId?: string`(由 `extractCandidateFindings` 调用点传入既有 `ownerId`),循环体 `out.push(...deathSetupEvents(parts))` 后追加:

```ts
out.push(
  ...deathUnusedDefensiveEvents(
    parts,
    { isOwner: u.id === ownerId, unit: u },
    combat,
  ),
);
```

`selfForbearanceActiveAt` 的真实签名先读 `utils/cooldowns.ts:149` 再接——参数对不上时以那边为准调整包装,**不许**另写一份 Forbearance 判定。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 真 fixture 冒烟(菜单不炸 + 类型出现在产出或合法缺席)**

在 `candidateFindings.test.ts` 的真实对局集成测试处(现有 extractCandidateFindings 集成用例)断言:产出里若含 `death-unused-defensive` 则其 facts.t 可被 `Number()` 解析且 walls 非空;不含也合法(fixture 无 owner 死亡)。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(analysis): death-unused-defensive 候选 —— owner 死亡时保命技可用未按(arenacoach DEATH-001)"
```

---

### Task 3: `external-unused`(DEATH-003 队友阵亡时外减可用未给)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts`
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts`

**Interfaces:**

- Consumes: `cdAvailableAt`(Task 1)、`isAllyCastableDefensive`(`utils/cooldowns.ts:53` 现有)、`extractDeathSetups` 内既有 `ccOf`/`cdsOf` memo
- Produces: 候选 type `"external-unused"`,id `external-unused:<ownerId>:<victimId>:<round(deathT)>`,facts `{ t, victim, owner, external, freeGapS }`;导出常量 `EXTERNAL_FREE_WINDOW_S = 5`、`EXTERNAL_FREE_MIN_GAP_S = 1.5` —— Task 5/6 依赖

- [ ] **Step 1: 写失败测试**

```ts
describe("external-unused(队友阵亡时 owner 外减可用未给)", () => {
  const ext = (over = {}) => ({
    spellId: "102342", // Ironbark
    spellName: "Ironbark",
    tag: "External",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const owner = { id: "h1", name: "Healer-R" };
  const victim = { id: "p2", name: "Mate-R" };

  it("外减可用 + owner 死亡前窗口有空档 → 发一条", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [], // 全程自由
      ownerAliveAt: () => true,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("external-unused");
    expect(ev[0]!.facts.external).toBe("Ironbark");
  });

  it("外减在 CD → 不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext({ casts: [{ timeSeconds: 60 }], neverUsed: false })], // readyAt=150
      ownerCC: [],
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("owner 死亡前窗口 [95,100] 全被 CC 覆盖 → 不自由,不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 94, durationSeconds: 7 }], // 覆盖 [94,101]
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("窗口内有 ≥1.5s 空档(CC 只盖 [95,99])→ 发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 4 }], // 空档 [99,100] 仅 1s… + [95 前 0s]?
      ownerAliveAt: () => true,
    });
    // 窗口 [95,100]:CC 盖 [95,99] → 最大空档 1.0s < 1.5 → 不发
    expect(ev).toEqual([]);
    const ev2 = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 3 }], // 空档 [98,100] = 2s ≥ 1.5
      ownerAliveAt: () => true,
    });
    expect(ev2).toHaveLength(1);
  });

  it("owner 在 deathT 已死亡 → 不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [],
      ownerAliveAt: () => false,
    });
    expect(ev).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `externalUnusedEvents` 未定义

- [ ] **Step 3: 最小实现**

```ts
/** external-unused:死亡前回看窗口(秒)与 owner 最小自由空档(秒)。
 * 阈值来源:arenacoach DEATH-003 的 "you were free to cast it"(1.5s 反应
 * 豁免与其全站一致);窗口 5s 取 DEATH_CC_LOOKBACK_S 的近端子窗。 */
export const EXTERNAL_FREE_WINDOW_S = 5;
export const EXTERNAL_FREE_MIN_GAP_S = 1.5;

export function externalUnusedEvents(input: {
  deathT: number;
  victim: { id: string; name: string };
  owner: { id: string; name: string };
  ownerExternals: Array<
    Pick<
      IMajorCooldownInfo,
      "spellId" | "spellName" | "cooldownSeconds" | "casts" | "neverUsed"
    >
  >;
  ownerCC: Array<{ atSeconds: number; durationSeconds: number }>;
  ownerAliveAt: (t: number) => boolean;
}): CandidateEvent[] {
  const { deathT, victim, owner } = input;
  if (!input.ownerAliveAt(deathT)) return [];

  // owner 自由空档:窗口 [deathT-5, deathT] 减去 CC 覆盖后的最大连续空档
  const from = Math.max(0, deathT - EXTERNAL_FREE_WINDOW_S);
  const covers = input.ownerCC
    .map((c) => [c.atSeconds, c.atSeconds + c.durationSeconds] as const)
    .filter(([a, b]) => b > from && a < deathT)
    .sort((a, b) => a[0] - b[0]);
  let cursor = from;
  let maxGap = 0;
  for (const [a, b] of covers) {
    maxGap = Math.max(maxGap, a - cursor);
    cursor = Math.max(cursor, b);
  }
  maxGap = Math.max(maxGap, deathT - cursor);
  if (maxGap < EXTERNAL_FREE_MIN_GAP_S) return [];

  const avail = input.ownerExternals.find((cd) => cdAvailableAt(cd, deathT));
  if (!avail) return [];
  return [
    {
      id: `external-unused:${owner.id}:${victim.id}:${Math.round(deathT)}`,
      type: "external-unused",
      t: deathT,
      unitNames: [owner.name, victim.name],
      spell: avail.spellName,
      spellId: avail.spellId,
      facts: {
        t: fmt(deathT),
        victim: victim.name,
        owner: owner.name,
        external: avail.spellName,
        freeGapS: fmt(maxGap),
      },
    },
  ];
}
```

接线(`extractDeathSetups` 内,已知 ownerId):victim 循环里 `u.id !== ownerId` 且 owner 单位存在时,用既有 memo 装配 input:

```ts
const ownerUnit = ownerId ? friends.find((f) => f.id === ownerId) : undefined;
// …victim 死亡循环内,deathUnusedDefensiveEvents 之后:
if (ownerUnit && ownerUnit.id !== u.id) {
  try {
    out.push(
      ...externalUnusedEvents({
        deathT,
        victim: { id: u.id, name: u.name },
        owner: { id: ownerUnit.id, name: ownerUnit.name },
        ownerExternals: cdsOf(ownerUnit).filter((cd) =>
          isAllyCastableDefensive(cd.spellId),
        ),
        ownerCC: ccOf(ownerUnit).ccInstances,
        ownerAliveAt: (t) =>
          !(ownerUnit.deathRecords ?? []).some(
            (dr: any) => (dr.timestamp - start) / 1000 <= t,
          ),
      }),
    );
  } catch {
    /* owner 摘要不可算 → 该类缺席 */
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(analysis): external-unused 候选 —— 队友阵亡时 owner 外减可用未给(arenacoach DEATH-003)"
```

---

### Task 4: `wasted-trinket`(TRINKET-001 中立局面浪费饰品)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts`(纯函数 + 在 `teamPlayEvents` 里接线,那里已有 `analyzePlayerCCAndTrinket(owner,…)` 调用)
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts`

**Interfaces:**

- Consumes: `analyzePlayerCCAndTrinket(...).trinketUseTimes`(现有)、`getUnitHpAtTimestamp` + `HP_SAMPLE_RADIUS_MS`(`utils/cooldowns.ts` 现有)、`reconstructEnemyCDTimeline(...).players[].offensiveCDs`(`castTimeSeconds`/`buffEndSeconds`,现有)
- Produces: 候选 type `"wasted-trinket"`,id `wasted-trinket:<ownerId>:<round(t)>`,facts `{ t, unit, teamMinHpPct }`;导出常量 `TRINKET_NEUTRAL_HP_PCT = 80` —— Task 5/6 依赖

- [ ] **Step 1: 写失败测试(纯函数注入探针,不建整 combat)**

```ts
describe("wasted-trinket(中立局面浪费 PvP 饰品)", () => {
  const probes = {
    friendlyHpPctAt: (t: number) => 95, // 全队最低 HP%(null=采不到样)
    healerInCCAt: (t: number) => false,
    enemyOffensiveActiveAt: (t: number) => false,
  };
  const owner = { id: "p1", name: "Me-R" };

  it("全队高血 + 治疗自由 + 无敌方爆发 → 中立,发一条", () => {
    const ev = wastedTrinketEvents([42.4], owner, probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("wasted-trinket");
    expect(ev[0]!.facts.teamMinHpPct).toBe("95");
  });

  it("有人低血(<80%)→ 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => 60,
      }),
    ).toEqual([]);
  });

  it("HP 采不到样 → 保守不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => null,
      }),
    ).toEqual([]);
  });

  it("治疗在 CC 中 → 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, { ...probes, healerInCCAt: () => true }),
    ).toEqual([]);
  });

  it("敌方进攻 CD buff 生效中 → 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        enemyOffensiveActiveAt: () => true,
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `wastedTrinketEvents` 未定义

- [ ] **Step 3: 最小实现**

```ts
/** wasted-trinket 的中立血线(arenacoach TRINKET-001:"everyone at high
 * health";其目录未给出精确值,取 80% 且由 Task 6 语料实证校准)。 */
export const TRINKET_NEUTRAL_HP_PCT = 80;

export function wastedTrinketEvents(
  trinketUseTimes: number[],
  owner: { id: string; name: string },
  probes: {
    /** t 时刻全体友方玩家的最低 HP%;任何人采不到样 → null(保守不发)。 */
    friendlyHpPctAt: (t: number) => number | null;
    healerInCCAt: (t: number) => boolean;
    enemyOffensiveActiveAt: (t: number) => boolean;
  },
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  for (const t of trinketUseTimes) {
    const minHp = probes.friendlyHpPctAt(t);
    if (minHp === null || minHp < TRINKET_NEUTRAL_HP_PCT) continue;
    if (probes.healerInCCAt(t)) continue;
    if (probes.enemyOffensiveActiveAt(t)) continue;
    out.push({
      id: `wasted-trinket:${owner.id}:${Math.round(t)}`,
      type: "wasted-trinket",
      t,
      unitNames: [owner.name],
      facts: { t: fmt(t), unit: owner.name, teamMinHpPct: fmt(minHp) },
    });
  }
  return out;
}
```

接线(`teamPlayEvents` 内,`analyzePlayerCCAndTrinket(owner,…)` 已有的 try 块里追加;探针全部用共享谓词装配):

```ts
const enemyTl = reconstructEnemyCDTimeline(enemies, combat);
const healer = friends.find((u) => isHealerSpec(u.spec));
const healerCC =
  healer && healer.id !== owner.id
    ? analyzePlayerCCAndTrinket(healer, enemies, combat, enemyPets).ccInstances
    : [];
out.push(
  ...wastedTrinketEvents(cc.trinketUseTimes, owner, {
    friendlyHpPctAt: (t) => {
      let min = 100;
      for (const f of friends) {
        const hp = getUnitHpAtTimestamp(
          f,
          combat.startTime + t * 1000,
          HP_SAMPLE_RADIUS_MS, // 谓词单源:与门规同一采样半径
        );
        if (hp === null) return null;
        min = Math.min(min, hp);
      }
      return min;
    },
    healerInCCAt: (t) =>
      healerCC.some(
        (c) => c.atSeconds <= t && t <= c.atSeconds + c.durationSeconds,
      ),
    enemyOffensiveActiveAt: (t) =>
      enemyTl.players.some((p) =>
        p.offensiveCDs.some(
          (cd) => cd.castTimeSeconds <= t && t <= cd.buffEndSeconds,
        ),
      ),
  }),
);
```

注意:`getUnitHpAtTimestamp` 返回值是 HP% 还是绝对值先读实现确认(`advancedActorMaxHp` 参与则可能是 pct);若是绝对值需换算 pct,换算逻辑放探针装配处,阈值常量不变。healer 自己是 owner 时(治疗视角)`healerInCCAt` 恒 false——owner 自己在 CC 中开饰品破 CC 属正常操作,由 minHp/敌方爆发两条件兜底判断中立。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(analysis): wasted-trinket 候选 —— 中立局面浪费 PvP 饰品(arenacoach TRINKET-001)"
```

---

### Task 5: 下游表态 —— prompt 类型指南 / renderer 失误规则表 / PROMPT_VERSION

**Files:**

- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.ts`(TYPE_GUIDANCE 表 3 条)
- Modify: `packages/desktop/src/renderer/src/report/derive/mistakes.ts`(MISTAKE_RULES 3 行 + candidateDetail 3 个 case)
- Modify: `packages/desktop/src/shared/promptVersion.ts`(PROMPT_VERSION +1)
- Test: 既有 `report.mistakes.test.tsx` 清单测试(自动覆盖)、`buildFindingsPrompt.test.ts`(若有类型指南快照则更新)

**Interfaces:**

- Consumes: Task 2/3/4 的三个 type 字符串与 facts 键名(`walls`/`free`、`victim`/`external`/`freeGapS`、`teamMinHpPct`)
- Produces: 用户可见的失误清单行与 AI 教练指南;PROMPT_VERSION bump 使旧分析缓存失效(批量分析会重跑,属预期,写进下版 changelog)

- [ ] **Step 1: TYPE_GUIDANCE 新增三条(英文,与现有条目同风格;指令自己写,不抄 arenacoach 文案)**

```ts
"death-unused-defensive": `- "death-unused-defensive": the player died at facts.t while major defensive(s) facts.walls were OFF cooldown. facts.free explains why pressing was possible: "yes" = not in CC; "trinket_in_hand" = CC'd but trinket was available to break out first; "usable_in_cc" = the listed ability works while CC'd. Coach pressing defensives earlier when taking heavy damage; do not invent which damage killed them.`,
"external-unused": `- "external-unused": teammate facts.victim died at facts.t while the player (facts.owner) had external defensive facts.external off cooldown and was free of CC for facts.freeGapS seconds in the final window. Coach external usage priorities; never claim the external would certainly have saved them.`,
"wasted-trinket": `- "wasted-trinket": the player used their PvP trinket at facts.t in a neutral state (team minimum HP facts.teamMinHpPct%, healer free, no enemy offensive cooldowns active). Coach saving trinket for kill windows or breaking lethal CC.`,
```

- [ ] **Step 2: MISTAKE_RULES 三行 + candidateDetail case**

```ts
{ type: "death-unused-defensive", label: "死亡时保命技可用未按", severity: "major", source: "candidate" },
{ type: "external-unused",        label: "队友阵亡时外减可用未给", severity: "major", source: "candidate" },
{ type: "wasted-trinket",         label: "中立局面浪费饰品",       severity: "major", source: "candidate" },
```

`candidateDetail` 按现有 switch 风格补:`death-unused-defensive` → `` `死亡时 ${c.facts.walls} 可用未按` ``;`external-unused` → `` `${c.facts.victim} 阵亡时 ${c.facts.external} 可用` ``;`wasted-trinket` → `` `全队最低血量 ${c.facts.teamMinHpPct}% 时开饰品` ``。

- [ ] **Step 3: PROMPT_VERSION +1**(`packages/desktop/src/shared/promptVersion.ts`,现值 +1,注释注明本批三类型)

- [ ] **Step 4: 跑 desktop 相关测试**

Run: `npx vitest run --root packages/desktop test/report.mistakes.test.tsx && npx vitest run --root packages/analysis src/analysis/buildFindingsPrompt.test.ts`
Expected: 全 PASS(清单测试因 MISTAKE_RULES 表态而过;prompt 测试若断言指南条目数需同步更新)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: arenacoach 批次下游接线 —— prompt 指南/失误清单三行/PROMPT_VERSION bump"
```

---

### Task 6: 语料实证(发生率数字 + 人工抽检)

**Files:**

- Create: `packages/eval/src/scan/newCandidateScan.ts`(可复用扫描,不留一次性脚本;入口/CLI 形态跟既有 scan 先例——先 `grep -rn "rotScan\|pvpReplaceScan" packages/eval/src` 找到先例文件照它的注册方式)
- Test: 无(扫描器本身是测量工具;判定谓词已在 Task 2-4 单测)

**Interfaces:**

- Consumes: `extractCandidateFindings`(全新菜单)、本机对局库(`matchesDir`,约 794 场)或 `$GLADLOG_EVAL_HOME` 语料装载器(以既有 scan 先例用哪个为准)
- Produces: 每类型发生率表(计划执行报告必附):`matches-with-emit / applicable-matches`,以及每类 5 场人工抽检记录

- [ ] **Step 1: 照 scan 先例写扫描器**——逐场装载 → `extractCandidateFindings(legacy, ownerId)` → 统计三类型的:出现场次、场均条数、applicable 分母(death-unused-defensive 分母=owner 有死亡的场;external-unused 分母=队友有死亡且 owner 有外减的场;wasted-trinket 分母=owner 用过饰品的场)。

- [ ] **Step 2: 跑全库并记录数字**。验收界:每类发生率在 (0%, 70%) 开区间——0% 说明谓词发不出来(白名单串联腐烂的镜像症状,回查上游),≥70% 说明门太松(对照 arenacoach 全人群值:DEATH-001 38%、DEATH-003 43%、TRINKET-001 34%,治疗视角语料允许偏离但不应数量级偏离)。

- [ ] **Step 3: 每类抽 5 场人工核验 facts**:availability(对照战报冷却台账渲染)、时刻在渲染网格、free 判定与回放一致。5/5 通过为验收;有错回 Task 2-4 修谓词,重跑本 Task。

- [ ] **Step 4: 越界处理**:发生率越界时调整对应阈值(TRINKET_NEUTRAL_HP_PCT / EXTERNAL_FREE_MIN_GAP_S)或加承压门(镜像 CD_WASTE_PRESSURE_HP_PCT 先例),改完重跑 Step 2;**数字与调整理由写进 commit message**。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(eval): 新候选三类语料扫描 —— 发生率 X%/Y%/Z%(n=794),抽检 15/15 通过"
```

---

### Task 7: 收尾 —— presubmit + agy 复核 + push

- [ ] **Step 1**: `npm run presubmit`(输出落文件查退出码,不加管道)
- [ ] **Step 2**: agy flash 复核(照 `.claude/skills/agy-review`:diff 落 patch 文件,prompt 点名怀疑面——free 判定的边界、owner 死亡时刻比较的开闭区间、HP pct/绝对值换算、PROMPT_VERSION bump 的缓存影响)
- [ ] **Step 3**: 采纳/驳回逐条处理后 `git push`,按 headSha 盯 CI 绿
- [ ] **Step 4**: 更新 `docs/BACKLOG.md`(如有相关条目)并把「第二批候选」(DEATH-002 无敌可用 / COOLDOWN-001 CC 压手 / DEFENSIVE-001-002 / DISPEL 迟发分层 / OFFENSIVE-001-002)记为后续待办

## 明确不做(YAGNI,第二批再议)

- DEATH-002(死时无敌可用):需要无敌子表 + Hypothermia 类共享 debuff 台账,Forbearance 已有但不全。
- COOLDOWN-001 / DEFENSIVE-001 / DEFENSIVE-002 / OFFENSIVE-001 / OFFENSIVE-002 / DISPEL late 分层:各需新白名单(小减伤表/规避手段表/锥形技能表)或新几何判定,按白名单纪律须先语料实证,单独立项。
- eval 门规新增硬门:三类新 facts 暂不进 `promptQualityCheck.hardFailures`(facts 由确定性谓词产出、审计层已验 eventIds 与占位符;若 Task 6 抽检发现渲染不一致再立项)。
