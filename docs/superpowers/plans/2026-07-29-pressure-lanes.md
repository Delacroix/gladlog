# Pressure/Exposure Lanes (backlog #4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pressure lane at the bottom of the battle report Timeline curve area: DMG SPIKE segments (click=set time window, connects to #16) + HEALER EXPOSURE markers, using the same predicates as prompt.

**Architecture:** analysis adds two single-source exports (`DMG_SPIKE_THRESHOLD` exported via package index; `computeHealerExposureEvents` orchestrator encapsulates exposure orchestration, `buildMatchContext` passes pre-computed artifacts to consume the same entry point); desktop adds new derive `pressureLanes.ts` + bottom lane layer in `Timeline.tsx`.

**Tech Stack:** TypeScript、React SVG、vitest。

**Spec:** `docs/superpowers/specs/2026-07-29-pressure-lanes-design.md`
**Working Directory:** Always use worktree `/Users/mingjianliu/code/gladlog-wt-qa` (main; dependencies already installed). The main checkout `/Users/mingjianliu/code/gladlog` is occupied by the user, **absolutely do not touch**.

## Global Constraints

- Commit directly to the main branch of the worktree, and eventually push (project convention); never use naked `cd` in compound commands; never add pipes to the gatekeeping chain.
- Tests must be run with workspace scope (`npm test --workspace=packages/analysis` / `--workspace=packages/desktop`); running single files directly has configuration artifacts.
- The only gatekeeping before push is `npm run presubmit`; visual baseline CI is single-source, absolutely do not run `test:visual` locally.
- Single source for predicates: spike gate = `DMG_SPIKE_THRESHOLD` (already exported in timelineHelpers, just add to package index exports, do not copy value); `computePressureWindows` is called with **default parameters** (same as buildMatchContext:235, do not explicitly pass literals); exposure only goes through one entry point `computeHealerExposureEvents`.
- If prompt has a [DMG SPIKE] segment, the lane must have it, and vice versa (structural guarantee via same gate and parameters).
- Zero changes to `buildMatchContext` behavior (exposure extraction is an equivalent refactor, existing context tests are the regression anchors).

---

### Task 1: analysis — DMG_SPIKE_THRESHOLD 上浮导出 + computeHealerExposureEvents orchestrator

**Files:**

- Modify: `packages/analysis/src/utils/healerExposureAnalysis.ts`(文件尾加 orchestrator)
- Modify: `packages/analysis/src/context/buildMatchContext.ts:288-303`(改调 orchestrator,传预计算件)
- Modify: `packages/analysis/src/index.ts`(导出)
- Test: `packages/analysis/test/healerExposureEvents.test.ts`(新)

**Interfaces:**

- Consumes: 既有 `analyzeHealerExposureAtBurst`、`analyzePlayerCCAndTrinket`、`reconstructEnemyCDTimeline(enemies, combat, owner?, friendlies?)`、`isHealerSpec`、`DMG_SPIKE_THRESHOLD`(timelineHelpers:474,值 300_000)。
- Produces(Task 2 消费,经 `@gladlog/analysis`):
  - `DMG_SPIKE_THRESHOLD`(index re-export)
  - `computeHealerExposureEvents(combat, pre?): IHealerBurstExposure[]`
  - `IHealerBurstExposure` / `HealerExposureLabel` 类型(index re-export,若已导出则确认即可)

- [ ] **Step 1: 写失败测试**

`packages/analysis/test/healerExposureEvents.test.ts`(fixture 构造参考 `test/` 下既有合成 combat 写法;单元有 `advancedActions` 才有坐标,无坐标场景 exposure 应为空):

```ts
import { describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD, computeHealerExposureEvents } from "../src";

describe("computeHealerExposureEvents", () => {
  it("无位置数据(无 advancedActions)→ 空数组,不抛", () => {
    // 最小合成 combat:1 友方治疗 + 1 敌人,均无 advancedActions
    const combat = mkCombatNoAdvanced(); // 按本文件内联构造
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("无治疗(全 DPS 队)→ 空数组", () => {
    const combat = mkCombatNoHealer();
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("pre 注入路径与自算路径同型(buildMatchContext 等价性烟测)", () => {
    // 自算路径跑通即可(结果形状断言),精确等价由 context 既有测试兜
    const combat = mkCombatNoAdvanced();
    const r = computeHealerExposureEvents(combat, undefined);
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("DMG_SPIKE_THRESHOLD 单源导出", () => {
  it("package index 导出且与 timelineHelpers 同值", async () => {
    const helpers = await import("../src/context/timelineHelpers");
    expect(DMG_SPIKE_THRESHOLD).toBe(helpers.DMG_SPIKE_THRESHOLD);
  });
});
```

(`mkCombatNoAdvanced`/`mkCombatNoHealer` 由实现者按 `deepDive.test.ts` 的 `mkUnit` 样式内联构造:units 带 `info`/`reaction`/`spec`(治疗用如 CombatUnitSpec.Priest_Holy)、各事件数组置空、`startInfo: { zoneId: "1552" }`、`startTime: 0, endTime: 90_000, playerId: "o"`。)

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- healerExposureEvents`
Expected: FAIL(导出不存在)。

- [ ] **Step 3: 实现**

`healerExposureAnalysis.ts` 文件尾:

```ts
export interface IHealerExposurePre {
  alignedBurstWindows: IAlignedBurstWindow[];
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  healerUnit: ICombatUnit | undefined;
}

/** 治疗暴露编排单源(#4):buildMatchContext 传预计算件(零重复计算),
 * renderer 不传则自算(派生全走共享谓词:analyzePlayerCCAndTrinket /
 * reconstructEnemyCDTimeline)。两条路径都收敛到同一个
 * analyzeHealerExposureAtBurst 调用 —— 泳道与 prompt 不许分叉。 */
export function computeHealerExposureEvents(
  combat: AtomicArenaCombat,
  pre?: IHealerExposurePre,
): IHealerBurstExposure[] {
  const units = Object.values(combat.units ?? {}) as ICombatUnit[];
  const players = units.filter((u) => (u as { info?: unknown }).info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return [];

  const healerUnit =
    pre !== undefined
      ? pre.healerUnit
      : friends.find((p) => isHealerSpec(p.spec));
  if (!healerUnit) return [];

  let alignedBurstWindows: IAlignedBurstWindow[];
  let ccTrinketSummaries: IPlayerCCTrinketSummary[];
  if (pre) {
    ({ alignedBurstWindows, ccTrinketSummaries } = pre);
  } else {
    // owner 解析镜像 renderer/buildAnalysisInput 口径:playerId 优先,治疗回退
    const owner =
      friends.find(
        (u) => u.id === (combat as { playerId?: string }).playerId,
      ) ?? healerUnit;
    const enemyIds = new Set(enemies.map((u) => u.id));
    const enemyPets = units.filter(
      (u) =>
        (u as { ownerId?: string }).ownerId &&
        enemyIds.has((u as { ownerId?: string }).ownerId!),
    );
    ccTrinketSummaries = friends.map((p) =>
      analyzePlayerCCAndTrinket(p, enemies, combat, enemyPets),
    );
    alignedBurstWindows = reconstructEnemyCDTimeline(
      enemies,
      combat,
      owner,
      friends,
    ).alignedBurstWindows;
  }

  const healerCCSummary = ccTrinketSummaries.find(
    (s) => s.playerName === healerUnit.name,
  );
  if (!healerCCSummary) return [];

  try {
    return analyzeHealerExposureAtBurst(
      alignedBurstWindows,
      enemies,
      healerUnit,
      healerCCSummary,
      ccTrinketSummaries,
      combat.startInfo?.zoneId ?? "",
      combat.startTime,
    );
  } catch {
    return []; // 无高级日志/几何缺席 → 优雅缺席
  }
}
```

(import 需补 `analyzePlayerCCAndTrinket`、`reconstructEnemyCDTimeline`、`isHealerSpec`、`CombatUnitReaction`、相关类型——注意别引入循环依赖:`enemyCDs`/`ccTrinketAnalysis` 若已被本文件依赖链引用则安全;若出现循环,orchestrator 挪到新文件 `utils/healerExposureEvents.ts`,报告说明。)

`buildMatchContext.ts:288-303` 等价替换:

```ts
const healerUnit = friends.find((p) => isHealerSpec(p.spec)) as
  ICombatUnit | undefined;
const healerExposures = computeHealerExposureEvents(combat, {
  alignedBurstWindows: enemyCDTimeline.alignedBurstWindows,
  ccTrinketSummaries,
  healerUnit,
});
```

(原 `healerCCSummary` 局部变量若其它地方还在用则保留其定义;orchestrator 内部自行 find。)

`index.ts`:re-export `DMG_SPIKE_THRESHOLD`(from `./context/timelineHelpers`)、`computeHealerExposureEvents`、`IHealerBurstExposure`、`HealerExposureLabel`(后两个若 `export *` 已覆盖则验证后跳过,报告写明)。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis`(全量——context 测试是 buildMatchContext 等价重构的回归锚)+ `npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(analysis): 治疗暴露编排单源 computeHealerExposureEvents + DMG_SPIKE_THRESHOLD 上浮导出(#4)"
```

---

### Task 2: desktop — derive/pressureLanes.ts

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/pressureLanes.ts`
- Test: `packages/desktop/test/pressureLanes.test.ts`(新;node 环境即可,纯 derive)

**Interfaces:**

- Consumes: `computePressureWindows`、`DMG_SPIKE_THRESHOLD`、`computeHealerExposureEvents`(Task 1)、`toLegacySafe`、`CombatUnitReaction`。
- Produces(Task 3 消费):

```ts
export interface PressureBand {
  fromS: number;
  toS: number;
  targetName: string;
  totalDamage: number;
  /** 取整秒窗口时长(≥1)算出的 k DPS,与 [DMG SPIKE] 行同口径。 */
  dpsK: number;
}
export interface ExposureMark {
  tS: number;
  label: "Critical" | "Exposed" | "Pressured"; // Safe 不出泳道
  /** hover 文案(中文,derive 拼好):威胁数/饰品状态/LoS 掩体距离。 */
  title: string;
}
export function derivePressureLanes(source: ReportSource): {
  spikes: PressureBand[];
  exposures: ExposureMark[];
};
```

- [ ] **Step 1: 写失败测试**

`test/pressureLanes.test.ts`(真实裁剪 fixture `test/fixtures/real-match-sample.json`——90s 真 3v3,有 damageIn;死亡/治疗类数组被剥):

```ts
import { describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD } from "@gladlog/analysis";
import realMatch from "./fixtures/real-match-sample.json";
import { derivePressureLanes } from "../src/renderer/src/report/derive/pressureLanes";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

const src = realMatch as unknown as ReportSource;

describe("derivePressureLanes", () => {
  it("spike 全部过阈值门,时刻为相对秒且在场内", () => {
    const { spikes } = derivePressureLanes(src);
    const durS = (src.endTime - src.startTime) / 1000;
    for (const s of spikes) {
      expect(s.totalDamage).toBeGreaterThanOrEqual(DMG_SPIKE_THRESHOLD);
      expect(s.fromS).toBeGreaterThanOrEqual(0);
      expect(s.toS).toBeLessThanOrEqual(durS + 10); // 窗口右缘=起点+10s,允许贴边
      expect(s.dpsK).toBeGreaterThan(0);
    }
  });

  it("dpsK 与 [DMG SPIKE] 行同口径(Math.round(total/max(1,round(to-from))/1000))", () => {
    const { spikes } = derivePressureLanes(src);
    for (const s of spikes) {
      const windowSec = Math.round(s.toS - s.fromS);
      expect(s.dpsK).toBe(
        Math.round(s.totalDamage / Math.max(1, windowSec) / 1000),
      );
    }
  });

  it("裁剪 fixture(无 advancedActions 剥留与否皆可)不抛;exposures 是数组", () => {
    const { exposures } = derivePressureLanes(src);
    expect(Array.isArray(exposures)).toBe(true);
    for (const e of exposures) {
      expect(["Critical", "Exposed", "Pressured"]).toContain(e.label);
      expect(e.title.length).toBeGreaterThan(0);
    }
  });

  it("空 source(units 空)→ 双空数组不抛", () => {
    const empty = { ...src, units: {} } as unknown as ReportSource;
    expect(derivePressureLanes(empty)).toEqual({ spikes: [], exposures: [] });
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/desktop -- pressureLanes`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
import {
  DMG_SPIKE_THRESHOLD,
  computeHealerExposureEvents,
  computePressureWindows,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

// …PressureBand/ExposureMark 接口(见 Interfaces 块,原样)…

/** 承压泳道 derive(#4):spike 门/窗参与 [DMG SPIKE] prompt 行同谓词
 * (DMG_SPIKE_THRESHOLD + computePressureWindows 默认参),prompt 有的段
 * 泳道必有。exposure 经 computeHealerExposureEvents 单入口,无坐标优雅缺席。 */
export function derivePressureLanes(source: ReportSource): {
  spikes: PressureBand[];
  exposures: ExposureMark[];
} {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    if (friends.length === 0) return { spikes: [], exposures: [] };

    const spikes: PressureBand[] = computePressureWindows(friends, legacy)
      .filter((pw) => pw.totalDamage >= DMG_SPIKE_THRESHOLD)
      .map((pw) => {
        const windowSec = Math.round(pw.toSeconds - pw.fromSeconds);
        return {
          fromS: pw.fromSeconds,
          toS: pw.toSeconds,
          targetName: pw.targetName,
          totalDamage: pw.totalDamage,
          // 同口径:emitDmgSpikeEntries 的 dpsK 公式(B20 防 Infinity)
          dpsK: Math.round(pw.totalDamage / Math.max(1, windowSec) / 1000),
        };
      });

    const exposures: ExposureMark[] = computeHealerExposureEvents(legacy)
      .filter((e) => e.exposureLabel !== "Safe")
      .map((e) => {
        const exposed = e.threats.filter((t) => !t.losBlocked).length;
        const trinket =
          e.trinketState === "available"
            ? "饰品在手"
            : e.trinketState === "passive"
              ? "被动饰品"
              : "饰品转 CD";
        const los =
          e.losBreak && e.losBreak.repositionYards <= 30
            ? `;LoS 掩体 ~${e.losBreak.repositionYards} 码`
            : "";
        return {
          tS: e.atSeconds,
          label: e.exposureLabel as ExposureMark["label"],
          title: `治疗暴露(${e.exposureLabel})· ${exposed} 威胁在 LoS · ${trinket}${los}`,
        };
      });

    return { spikes, exposures };
  } catch {
    return { spikes: [], exposures: [] };
  }
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/desktop/src/renderer/src/report/derive/pressureLanes.ts packages/desktop/test/pressureLanes.test.ts
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(desktop): pressureLanes derive(spike 同门同参 + exposure 单入口,#4)"
```

---

### Task 3: desktop — Timeline 泳道层 + 点击设窗 + MatchReport 接线

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/Timeline.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(传 lanes)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `packages/desktop/test/pressureLanes.render.test.tsx`(新,`// @vitest-environment jsdom`)

**Interfaces:**

- Consumes: Task 2 `derivePressureLanes/PressureBand/ExposureMark`;Timeline 既有 `onRangeSelect?: (fromS, toS) => void`、布局常量 `W=800, H(现值见文件), PAD={l:34,r:8,t:18,b:18}`、x 轴为绝对 ms(`x(data.start + tS*1000)` 换算)。
- Produces: `Timeline` 新可选 props `pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] }`(缺省不画,老调用零破坏)。

- [ ] **Step 1: 写失败测试**

`test/pressureLanes.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/renderer/src/report/components/Timeline";

// 最小 data:两条 series 一个死亡都非必需——只要 start/end 有效
const data = { start: 0, end: 90_000, series: [], deaths: [] } as never;

describe("Timeline 承压泳道", () => {
  const pressure = {
    spikes: [
      {
        fromS: 30,
        toS: 40,
        targetName: "P2-R",
        totalDamage: 1_200_000,
        dpsK: 120,
      },
    ],
    exposures: [
      {
        tS: 35,
        label: "Critical" as const,
        title: "治疗暴露(Critical)· 2 威胁在 LoS · 饰品转 CD",
      },
    ],
  };

  it("有 pressure 时渲染 spike 块与 exposure 标记;缺省不渲染", () => {
    const { container, rerender } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
      />,
    );
    expect(
      container.querySelectorAll('[data-testid="pressure-spike"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="pressure-exposure"]'),
    ).toHaveLength(1);
    rerender(
      <Timeline data={data} hidden={new Set()} onSelectUnit={() => {}} />,
    );
    expect(
      container.querySelector('[data-testid="pressure-spike"]'),
    ).toBeNull();
  });

  it("点击 spike 块 → onRangeSelect(fromS, toS)", () => {
    const onRangeSelect = vi.fn();
    const { container } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
        onRangeSelect={onRangeSelect}
      />,
    );
    fireEvent.click(container.querySelector('[data-testid="pressure-spike"]')!);
    expect(onRangeSelect).toHaveBeenCalledWith(30, 40);
  });

  it("spike 块 title 含承压方与量级;exposure title 原样透传", () => {
    const { container } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
      />,
    );
    expect(
      container.querySelector('[data-testid="pressure-spike"] title')
        ?.textContent,
    ).toMatch(/P2.*1\.20M.*120k/);
    expect(
      container.querySelector('[data-testid="pressure-exposure"] title')
        ?.textContent,
    ).toContain("治疗暴露");
  });
});
```

(Timeline 的必填 props 以实际签名为准——若还需 `onDeathClick` 等,测试补上空函数;实现者读文件对齐。)

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/desktop -- pressureLanes.render`
Expected: FAIL(无 pressure prop)。

- [ ] **Step 3: 实现**

`Timeline.tsx`:

- props 加 `pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] };`(type import 自 derive)。
- 常量 `const LANE_H = 8;`,泳道 y 域:`[H - PAD.b - LANE_H, H - PAD.b]`(画在绘图区内底缘,不改 H、不缩曲线)。
- 渲染层放在 bands 之后、曲线 path 之前(泳道被曲线压住无妨,块半透明):

```tsx
{
  (pressure?.spikes ?? []).map((s, i) => {
    const x1 = x(data.start + s.fromS * 1000);
    const x2 = x(data.start + s.toS * 1000);
    const dmgM = (s.totalDamage / 1_000_000).toFixed(2);
    const mm = (v: number) =>
      `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
    return (
      <rect
        key={`ps${i}`}
        data-testid="pressure-spike"
        className="rpt-pressure-spike"
        x={x1}
        width={Math.max(3, x2 - x1) /* 最小宽度,bands 先例精神 */}
        y={H - PAD.b - LANE_H}
        height={LANE_H}
        onClick={
          onRangeSelect ? () => onRangeSelect(s.fromS, s.toS) : undefined
        }
        style={{ cursor: onRangeSelect ? "pointer" : undefined }}
      >
        <title>{`${mm(s.fromS)}–${mm(s.toS)} ${s.targetName.split("-")[0]} 承压 ${dmgM}M(${s.dpsK}k DPS)${onRangeSelect ? "(点击设为时间窗)" : ""}`}</title>
      </rect>
    );
  });
}
{
  (pressure?.exposures ?? []).map((e, i) => {
    const cx = x(data.start + e.tS * 1000);
    const cy = H - PAD.b - LANE_H / 2;
    return (
      <path
        key={`pe${i}`}
        data-testid="pressure-exposure"
        className={`rpt-pressure-exposure rpt-pressure-exposure-${e.label.toLowerCase()}`}
        d={`M ${cx} ${cy - 5} L ${cx + 4} ${cy} L ${cx} ${cy + 5} L ${cx - 4} ${cy} Z`}
      >
        <title>{e.title}</title>
      </path>
    );
  });
}
```

`MatchReport.tsx`:`const pressure = useMemo(() => derivePressureLanes(source), [source]);` 传 `<Timeline … pressure={pressure} />`(该组件已有 onRangeSelect 接 setTimeRange——点击 spike 即设窗,零新回调)。

`styles.css`:

```css
/* 承压泳道(#4):底部细条,与全高进攻色带分层 */
.rpt-pressure-spike {
  fill: rgba(239, 83, 80, 0.45);
}
.rpt-pressure-spike:hover {
  fill: rgba(239, 83, 80, 0.7);
}
.rpt-pressure-exposure-critical {
  fill: #ef5350;
}
.rpt-pressure-exposure-exposed {
  fill: #ffa726;
}
.rpt-pressure-exposure-pressured {
  fill: #ffee58;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck` + `npx eslint packages/desktop/src --quiet`
Expected: 全绿。

- [ ] **Step 5: run-ui 真眼验收**

dev:ui(worktree,5199 被占自动换口)真实 fixture:底部泳道出现红块与菱形;hover 出中文 title;点击红块 → 时间窗设为该段、【AI 分析此段】按钮出现(#16 闭环走通)。截图留档。

- [ ] **Step 6: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(desktop): Timeline 承压泳道(spike 点击设窗接 #16 + exposure 标记,#4)"
```

---

### Task 4: 门禁、push、CI、视觉基线、backlog 收账

**Files:**

- Modify: `docs/BACKLOG.md`(#4 标题行 ✅)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png`(CI 生成人审)

- [ ] **Step 1: presubmit**

Run: `(cd /Users/mingjianliu/code/gladlog-wt-qa && npm run presubmit)`
Expected: 全绿;红了如实报告,不跳步。

- [ ] **Step 2: backlog 收账 + push**

`docs/BACKLOG.md` `## 4. Burst-window analysis timeline (visual)` 标题行加:
`✅(2026-07-29 落地:战报 Timeline 底部承压泳道 DMG SPIKE 点击设窗接 #16 + HEALER EXPOSURE 标记;TimelineStrip 同步留后续;spec docs/superpowers/specs/2026-07-29-pressure-lanes-design.md)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "docs: backlog #4 收账"
git -C /Users/mingjianliu/code/gladlog-wt-qa push
```

- [ ] **Step 3: 按 headSha 盯 CI**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-qa rev-parse HEAD)
(cd /Users/mingjianliu/code/gladlog-wt-qa && gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
# 空则等 20s 重查;拿到 id 后 gh run watch <id> --exit-status
```

test job 必须绿;frontend-qa 因 report-battle/report-window/report-synth 基线红 → 预期,走 Step 4。

- [ ] **Step 4: 视觉基线重生成(CI 单源人审)**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-qa && gh workflow run visual-baseline.yml --ref main)
# 轮询 completed 后下载对比(#15/#16 同配方)
```

DIFF 逐张人审:变化必须是「Timeline 底部多一条泳道(红块/菱形)」可解释,其他区域不动。审过 cp 覆盖、commit、push,回 Step 3 盯绿。

- [ ] **Step 5: 汇报验收数字**

同一 fixture:泳道块数 = prompt [DMG SPIKE] 行数(同门同参判据);点击块后时间窗与块起止一致;改前泳道 0 元素。

---

## Self-Review 记录(定稿前跑过)

1. **Spec 覆盖**:阈值上浮+orchestrator(T1)、derive 同门同参+exposure 单入口+防御(T2)、泳道形态/点击设窗/hover/样式(T3)、基线/收账/一致性判据(T4)。「窗口参数同理」条款以「双方都用默认参」满足(buildMatchContext:235 即默认调用,无字面量可共享)。
2. **占位符**:T1 fixture 构造指向既有 mkUnit 样式并给了字段清单;T3 测试注明「必填 props 以实际签名为准」——均为对既有代码的引用而非 TBD。
3. **类型一致**:`PressureBand/ExposureMark` T2 定义、T3 import 消费;`pressure` prop 形状与 derive 返回一致;`computeHealerExposureEvents(combat, pre?)` T1/T2 一致。
