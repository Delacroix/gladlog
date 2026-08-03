# OBS 录像二期 · 第 0 段(地基)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OBS 录像二期里**与采集端无关、且在 mac 上能验完**的地基做掉,并交付一个
Windows 门测脚本 —— 让用户跑一发就能回答第 1 段开工前必须确认的几件事。

**Architecture:** 设计见 `docs/plans/2026-08-02-obs-phase2-design.md`(下称"设计文档")。
本计划覆盖设计文档 **§4 第 0 段**(五项)+ **§9.4 自检表的门测子集**。第 1 段(托管 OBS
实例)另出计划,**要等门测结果回来再写**。

两处是**修已发布的 bug**:回放对齐(§2.6)与体积配额缺失(§2.8)。一处是第 1 段的结构
前提:索引改成一段素材对多场(§4.3)。

**Tech Stack:** TypeScript monorepo;Electron 38.8.6;vitest;React(renderer)。

## Global Constraints

- 类型检查只用 `npm run typecheck`(**绝不** `tsc -b`)。`packages/desktop/tsconfig.json` 的
  `include` 是 `["src","test","dev","qa"]` —— **`scripts/` 不在里面**,Task 7 的脚本
  typecheck 扫不到,别拿它当验收。
- **所有 vitest 命令必须在包目录里跑**:`(cd packages/desktop && npx vitest run <相对路径>)`。
  从仓库根跑不加载 `packages/desktop/vitest.config.ts`,`globals: true` 关着、RTL 自动
  cleanup 不注册 —— 实测同一个 `VideoTab.test.tsx` 根目录下 6 失败/10 通过、包目录下
  16/16 全绿。**这是本计划最容易让人白干半天的坑。**
- **本仓库没装 `@testing-library/jest-dom`。** 断言一律 `.toBeTruthy()` / `.toContain()`,
  **不要**写 `.toBeInTheDocument()`(全仓零处使用)。
- **新增 `.tsx` 测试文件第一行必须是** `// @vitest-environment jsdom`。
- **renderer 测试打桩走 `vi.mock("./bridge")`**(`bridge()` 返回 `window.__gladlogFixture ?? window.gladlog`),
  照 `App.pagination.test.tsx` 的写法,**不要**直接赋值 `window.gladlog`。
- push 前跑 `npm run presubmit`;**本机绝不直跑 `test:visual`**。
- 门禁链**不加管道**;复合命令**不 `cd`**,用 `(cd … && …)` 子壳。
- renderer / preload 从 `src/main/*` 只能 `import type`;跨界常量放 `src/shared/`。
- **谓词单源**(CLAUDE.md 铁律):共享点是 `packages/desktop/src/shared/videoTime.ts` ——
  renderer 换算、Task 7 的 headroom、收官时的 §9.1 基线统计**必须**都走它。
- 每个 Task 一个 commit;本工作树在 `worktree-obs-phase2`,**不直推 main**。

### 改类型时的通用纪律(本计划两次踩到)

改一个被广泛构造的接口(`RecordingEntry`、`GladlogSettings`)时,**先 grep 出全部构造点
再动手**,包括 `test/` 与 `dev/` 下的:

```
(cd packages/desktop && grep -rn "matchId:" src test dev qa | grep -v node_modules)
(cd packages/desktop && grep -rn "recordingKeepCount" src test dev qa)
```

`src/main/` 之外还有 `packages/desktop/test/settingsStore.test.ts` 这种目录,
**`npx vitest run src/main/` 扫不到它**。

---

### Task 1: `shared/videoTime.ts` —— 回放换算的单源纯函数

设计文档 §2.6 / §4.1 / §9.1 / §9.2。

**Files:**

- Create: `packages/desktop/src/shared/videoTime.ts`
- Test: `packages/desktop/src/shared/videoTime.test.ts`

**Interfaces:**

- Consumes: 无(纯函数,electron-free)。
- Produces:`PRE_ROLL_S`、`VideoWindow`、`computeVideoWindow`、`toBattleSeconds`、
  `toVideoSeconds`、`seekTargetS` —— Task 2 与 Task 7 依赖。

> **关键定义**:`headroomS` **带符号**,与设计文档 §9.1 的
> `headroomMs = source.startTime − chunk.startedAt` 逐字对应 —— 一期基线恒为负,
> §5.5 那个"WoW 刚启动就进场"的例外也是负的,**都要如实表达**。给 UI 用的
> "缺了多少秒"是另一个字段 `missingHeadS`。**不要合并**,那正是谓词漂移。

- [ ] **Step 1: 写失败测试**

```ts
// packages/desktop/src/shared/videoTime.test.ts
import { describe, expect, it } from "vitest";
import {
  PRE_ROLL_S,
  computeVideoWindow,
  seekTargetS,
  toBattleSeconds,
  toVideoSeconds,
} from "./videoTime";

const T0 = 1_750_000_000_000;

/** lagS > 0 表示录像起点晚于开场 lagS 秒(一期的常态,也是那个 bug 的现场)。 */
function win(lagS: number, durationS = 600) {
  return computeVideoWindow({
    matchStartMs: T0,
    matchEndMs: T0 + 300_000,
    recordingStartedAtMs: T0 + lagS * 1000,
    durationS,
  });
}

describe("computeVideoWindow", () => {
  it("录像晚于开场:offsetS 为负且不再被 clamp 成 0", () => {
    const w = win(10);
    expect(w.offsetS).toBe(-10);
    expect(w.missingHeadS).toBe(10);
    expect(w.headroomS).toBe(-10); // 带符号 —— 设计文档 §9.1 的基线就是负的
  });

  it("录像早于开场(二期目标):offsetS 与 headroomS 同为正", () => {
    const w = win(-5);
    expect(w.offsetS).toBe(5);
    expect(w.headroomS).toBe(5);
    expect(w.missingHeadS).toBe(0);
  });

  it("windowStartS 允许回滚到开场之前,但不越过视频 0", () => {
    expect(win(-20).windowStartS).toBe(20 - PRE_ROLL_S);
    expect(win(-1).windowStartS).toBe(0);
    expect(win(10).windowStartS).toBe(0);
  });

  it("windowEndS 被实际时长夹住,且永不小于 windowStartS", () => {
    expect(win(-5, 600).windowEndS).toBe(305);
    expect(win(-5, 100).windowEndS).toBe(100);
    expect(win(-5, 0).windowEndS).toBe(305); // 时长未知不夹
    const degenerate = computeVideoWindow({
      matchStartMs: T0,
      matchEndMs: T0 + 1000,
      recordingStartedAtMs: T0 - 500_000,
      durationS: 10,
    });
    expect(degenerate.windowEndS).toBeGreaterThanOrEqual(
      degenerate.windowStartS,
    );
  });

  it("本场整段落在录像结束之后 → noFootage", () => {
    expect(win(-5, 600).noFootage).toBe(false);
    expect(win(-1000, 600).noFootage).toBe(true);
    expect(win(-1000, 0).noFootage).toBe(false); // 时长未知时不下结论
  });
});

describe("换算(设计文档 §9.2 的判据)", () => {
  it("缺头 lag 秒时,战斗秒 b 对应的视频秒必须是 b − lag", () => {
    for (const lag of [2, 10, 25]) {
      const w = win(lag);
      for (const b of [0, 30, 120]) {
        expect(toVideoSeconds(b, w.offsetS)).toBe(b - lag);
      }
    }
  });

  it("有头 head 秒时,战斗秒 b 对应的视频秒必须是 b + head", () => {
    expect(toVideoSeconds(60, win(-8).offsetS)).toBe(68);
  });

  it("往返恒等", () => {
    for (const lag of [-8, 0, 12]) {
      const w = win(lag);
      for (const b of [0, 17.5, 240]) {
        expect(toBattleSeconds(toVideoSeconds(b, w.offsetS), w.offsetS)).toBe(
          b,
        );
      }
    }
  });
});

describe("seekTargetS", () => {
  it("默认回滚 PRE_ROLL_S 秒", () => {
    expect(seekTargetS(60, win(-20))).toBe(60 + 20 - PRE_ROLL_S);
  });

  it("preRoll:false 时精确落点", () => {
    expect(seekTargetS(60, win(-20), { preRoll: false })).toBe(80);
  });

  it("回滚不越过窗口下限", () => {
    expect(seekTargetS(0, win(-1))).toBe(0);
  });

  it("越过窗口上限时夹住", () => {
    const w = win(-5, 600);
    expect(seekTargetS(99_999, w)).toBe(w.windowEndS);
  });

  it("缺头场景:战斗前 lag 秒内的时刻全部落到窗口下限", () => {
    const w = win(10);
    expect(seekTargetS(3, w)).toBe(0);
    expect(seekTargetS(60, w)).toBe(60 - 10 - PRE_ROLL_S);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/shared/videoTime.test.ts)`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// packages/desktop/src/shared/videoTime.ts

/**
 * Playback-time arithmetic for the recording tab. Pure and electron-free so the
 * renderer, the Windows gate-check script and the phase-2 baseline stats all
 * consume the SAME predicate (CLAUDE.md shared-predicate rule) -- the phase-1
 * bug was exactly a second, divergent copy of this arithmetic inline in a
 * component.
 */

/** How far to roll back before a clicked combat moment, so the viewer sees the
 * setup rather than the outcome. 3s matches arenacoach's EVENT_PRE_ROLL_SEC
 * (design doc 2026-08-02-obs-phase2-design.md 2.12). */
export const PRE_ROLL_S = 3;

export interface VideoWindow {
  /**
   * Where this match's opening sits inside the video, in seconds.
   * MAY BE NEGATIVE: negative means the recording started AFTER the match
   * opened, i.e. the first |offsetS| seconds were never captured. Phase 1
   * wrapped this in Math.max(0, ...), which ate the negative value and shifted
   * every seek late by the whole log lag.
   */
  offsetS: number;
  /** Scrubber / playback lower bound: may sit before the opening when that
   * footage exists, never below video 0. */
  windowStartS: number;
  /** Scrubber / playback upper bound: the match's end, clamped by duration. */
  windowEndS: number;
  /**
   * SIGNED headroom in seconds, identical in meaning to the design doc's
   * headroomMs = matchStart - recordingStartedAt (9.1). Negative is a real,
   * reportable value (phase-1's baseline is entirely negative, and phase 2 has
   * one documented negative exception in 5.5) -- do NOT clamp it. For "how many
   * seconds are missing", use missingHeadS.
   */
  headroomS: number;
  /** Seconds of the opening never captured; 0 when the head is covered. UI copy
   * uses this, acceptance statistics use headroomS. */
  missingHeadS: number;
  /** The whole match sits past the end of the footage. Only meaningful once
   * duration is known -- false while durationS is 0. */
  noFootage: boolean;
}

export function computeVideoWindow(args: {
  matchStartMs: number;
  matchEndMs: number;
  recordingStartedAtMs: number;
  /** Measured video duration; pass 0 when not yet known. */
  durationS: number;
}): VideoWindow {
  const { matchStartMs, matchEndMs, recordingStartedAtMs, durationS } = args;
  const offsetS = (matchStartMs - recordingStartedAtMs) / 1000;
  const windowStartS = Math.max(0, offsetS - PRE_ROLL_S);
  const rawEndS = (matchEndMs - recordingStartedAtMs) / 1000;
  const clampedEndS = durationS > 0 ? Math.min(rawEndS, durationS) : rawEndS;
  return {
    offsetS,
    windowStartS,
    windowEndS: Math.max(windowStartS, clampedEndS),
    headroomS: offsetS,
    missingHeadS: Math.max(0, -offsetS),
    noFootage: durationS > 0 && offsetS >= durationS,
  };
}

/** Video seconds -> combat seconds within this match. */
export function toBattleSeconds(videoS: number, offsetS: number): number {
  return videoS - offsetS;
}

/** Combat seconds within this match -> video seconds. */
export function toVideoSeconds(battleS: number, offsetS: number): number {
  return battleS + offsetS;
}

/** Where to seek when the user clicks a combat moment: roll back PRE_ROLL_S,
 * then clamp into the window. */
export function seekTargetS(
  battleS: number,
  w: VideoWindow,
  opts?: { preRoll?: boolean },
): number {
  const raw = toVideoSeconds(battleS, w.offsetS);
  const rolled = opts?.preRoll === false ? raw : raw - PRE_ROLL_S;
  return Math.min(Math.max(rolled, w.windowStartS), w.windowEndS);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/shared/videoTime.test.ts) && npm run typecheck`
Expected: 全 PASS / 零类型错误

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/videoTime.ts packages/desktop/src/shared/videoTime.test.ts
git commit -m "feat(desktop): 回放换算单源 videoTime —— offsetS 允许为负 + 带符号 headroom + pre-roll"
```

---

### Task 2: VideoTab 消费单源 + 缺头显式化 + onError

设计文档 §4.1。这一步真正修掉已发布的对齐 bug。

> **本 Task 会改动两条既有断言,这是设计决定,不是回归。**
>
> | 用途                     | 用哪个量        | 为什么                                                      |
> | ------------------------ | --------------- | ----------------------------------------------------------- |
> | battleS ↔ videoS 换算    | `offsetS`(可负) | 纯换算常量                                                  |
> | **挂载后的初始播放位置** | `offsetS`       | 打开录像 tab 从**开场**开始播;pre-roll 只服务于"点某个时刻" |
> | 越界回弹下限             | `startBoundS`   | 否则 pre-roll 落点会被立刻弹回,等于没做                     |
> | scrubber `min`           | `startBoundS`   | 否则可播位置落在滑块量程之外                                |
> | `clampedCurS` 下限       | `startBoundS`   | 同上                                                        |
> | 标记条 `windowStartS`    | `startBoundS`   | 同上                                                        |
>
> 因此 `VideoTab.test.tsx` 里**恰好两条**断言要改(已逐行核对):
> `:309` `expect(Number(range.min)).toBeCloseTo(OFFSET_S)` → `OFFSET_S - PRE_ROLL_S`;
> `:327` 回弹断言 `toBeCloseTo(OFFSET_S)` → `OFFSET_S - PRE_ROLL_S`。
> `:304` 的初始 `currentTime ≈ OFFSET_S` **保持不变**(挂载位置没改)。两处都要补注释说明原因。

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/VideoTab.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/VideoTab.test.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/VideoMomentStrip.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/VideoMomentStrip.test.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/VideoMomentList.tsx`
- Create: `packages/desktop/src/renderer/src/report/components/VideoMomentList.test.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css`

**Interfaces:**

- Consumes: Task 1 的 `PRE_ROLL_S` / `computeVideoWindow` / `seekTargetS` / `toBattleSeconds`。
- Produces:`VideoMomentStrip` 与 `VideoMomentList` 新增 prop
  `unreachableBeforeBattleS?: number`(默认 0)。

- [ ] **Step 1: 写失败测试**

追加到 `VideoTab.test.tsx` 末尾。**注意三条既有约定**:元素选择器是
`.rpt-video-tab video`;设置时长用文件里已有的 `fireLoadedMetadata(video, <秒>)`;
挂载时**不传 `matchId`**(传了会触发 AI 拉取,既有用例都不传)。

```tsx
describe("VideoTab:录像晚于开场(缺头,一期生产上的常态)", () => {
  const LAG_S = 12;
  const startedAtLate = startedAt + LAG_S * 1000; // 录像比开场晚 12s

  it("缺头时顶部给出明确提示,而不是静默", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAtLate} source={source} />,
    );
    const note = container.querySelector(".rpt-video-note");
    expect(note).toBeTruthy();
    expect(note!.textContent).toMatch(/缺头\s*12\s*秒/);
  });

  it("越界回弹下限是 windowStartS(缺头时为 0),不是负数", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAtLate} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: -5,
    });
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(0);
  });

  it("scrubber 量程从 0 开始(缺头时开场之前没有素材可回滚)", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAtLate} source={source} />,
    );
    fireLoadedMetadata(
      container.querySelector(".rpt-video-tab video") as HTMLVideoElement,
      200,
    );
    const range = container.querySelector(
      ".rpt-video-ctrl-range",
    ) as HTMLInputElement;
    expect(Number(range.min)).toBeCloseTo(0);
    // 本场终点 = 本场时长 − 缺头 = endS − LAG_S
    expect(Number(range.max)).toBeCloseTo(endS - LAG_S);
  });

  it("视频解不了时给出可见提示,而不是一块黑屏", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireEvent.error(video);
    expect(
      container.querySelector(".rpt-video-note--error")?.textContent,
    ).toMatch(/无法播放/);
  });
});

describe("VideoTab:pre-roll(点某个战斗时刻回滚 3 秒)", () => {
  const OFFSET_S = 30;
  const startedAtMid = startedAt - OFFSET_S * 1000;

  it("scrubber 下限比开场早 PRE_ROLL_S 秒(素材够时)", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAtMid} source={source} />,
    );
    fireLoadedMetadata(
      container.querySelector(".rpt-video-tab video") as HTMLVideoElement,
      200,
    );
    const range = container.querySelector(
      ".rpt-video-ctrl-range",
    ) as HTMLInputElement;
    expect(Number(range.min)).toBeCloseTo(OFFSET_S - PRE_ROLL_S);
  });

  it("回弹下限同样是 windowStartS,否则 pre-roll 落点会被立刻弹回", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAtMid} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: OFFSET_S - PRE_ROLL_S, // 正好落在 pre-roll 位置
    });
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(OFFSET_S - PRE_ROLL_S); // 不被弹回
  });
});
```

顶部 import 补 `PRE_ROLL_S`:

```ts
import { PRE_ROLL_S } from "../../../../shared/videoTime";
```

- [ ] **Step 2: 改两条既有断言**

- `:309`:`expect(Number(range.min)).toBeCloseTo(OFFSET_S)` →
  `expect(Number(range.min)).toBeCloseTo(OFFSET_S - PRE_ROLL_S); // pre-roll:量程下限比开场早 3s`
- `:327`:`expect(video.currentTime).toBeCloseTo(OFFSET_S)` →
  `expect(video.currentTime).toBeCloseTo(OFFSET_S - PRE_ROLL_S); // 回弹下限 = windowStartS`

`:304` 与 `:346` **不动**。

- [ ] **Step 3: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/renderer/src/report/components/VideoTab.test.tsx)`
Expected: 新增六例 FAIL

- [ ] **Step 4: 换掉派生块**

import 区加(相对深度照该文件既有的 `src/shared/` import 写法):

```ts
import {
  computeVideoWindow,
  seekTargetS,
  toBattleSeconds,
} from "../../../../shared/videoTime";
```

把现有 :119-126 的派生块替换为:

```ts
// Single source for all playback-time arithmetic (shared/videoTime.ts) --
// the phase-1 bug was a divergent inline copy that clamped offsetS to 0.
const win = computeVideoWindow({
  matchStartMs: source.startTime,
  matchEndMs: source.endTime,
  recordingStartedAtMs: startedAt,
  durationS,
});
const offsetS = win.offsetS; // conversion constant only; may be negative
const endS = win.windowEndS;
const startBoundS = win.windowStartS; // playback / scrubber lower bound
```

- [ ] **Step 5: 逐处替换**

| 现址   | 原写法                                                             | 改成                                                                       |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| :237-9 | `if (v.currentTime < offsetS - 0.25) { v.currentTime = offsetS; }` | `if (v.currentTime < startBoundS - 0.25) { v.currentTime = startBoundS; }` |
| :244   | `const battleS = v.currentTime - offsetS;`                         | `const battleS = toBattleSeconds(v.currentTime, offsetS);`                 |
| :293-4 | `v.currentTime = offsetS; setCurS(offsetS);`                       | **保持不变**(挂载位置仍是开场)                                             |
| :370   | `Math.min(Math.max(curS, offsetS), endS)`                          | `Math.min(Math.max(curS, startBoundS), endS)`                              |
| :406-7 | `fmtClock(Math.max(0, clampedCurS - offsetS))` 等                  | **保持不变**(要的就是"相对本场开场"的时刻)                                 |
| :420   | `min={offsetS}`                                                    | `min={startBoundS}`                                                        |
| :434   | `windowStartS={offsetS}`                                           | `windowStartS={startBoundS}`                                               |
| :138-9 | `videoS: m.tS + offsetS`                                           | **保持不变**(标记画在事件真实位置,pre-roll 只影响点击落点)                 |

`:309` 的 effect 依赖数组补 `startBoundS`。

- [ ] **Step 6: `:278` 的 noFootage —— 必须用刚读到的 duration**

`:278` 在 `onReady` 里,此时刚 `const dur = v.duration` 并调了 `setDurationS(dur)`,
但 **state 还没提交**,`durationS` 仍是 0,`win.noFootage` 恒为 false。用它会让
:86-96 注释里记载的 seek↔clamp 死循环(CPU 打满)复活,并打红既有回归测试
`VideoTab.test.tsx:430-458`。

就地重算:

```ts
// Decide on the duration we JUST read -- durationS state has not committed yet.
const readyWin = computeVideoWindow({
  matchStartMs: source.startTime,
  matchEndMs: source.endTime,
  recordingStartedAtMs: startedAt,
  durationS: dur,
});
if (readyWin.noFootage) {
  // ...既有的 detach + 空态分支原样保留
}
```

- [ ] **Step 7: 三处 seek 落点改走 `seekTargetS`(注意其中一处后面还有 `setCurS`)**

- `:479-487`(后面跟着 `setCurS(videoS)`):

```ts
const videoS = seekTargetS(battleS, win);
v.currentTime = videoS;
setCurS(videoS);
```

- `:539-546` 与 `:557-567`(后面没有 `setCurS`):

```ts
v.currentTime = seekTargetS(battleS, win);
```

`:436-438` 标记条的 `onSeek` 收到的已经是**视频秒**(拖拽定位),**保持不变**。

- [ ] **Step 8: 不可达时刻标灰**

设计文档 §4.1 明写的要求。现状比"没做"更糟:`VideoMomentStrip.tsx:38-41` 的 `inWindow`
过滤把窗口外标记**直接丢掉**,缺头时那些时刻在标记条上**凭空消失**;`VideoMomentList`
把它们渲染成和可达时刻一模一样、同带 `title="定位到该时刻"` 的普通行。

两个组件各加一个 prop:

```ts
/** Combat seconds before this value have no footage (missing head). 0 = none. */
unreachableBeforeBattleS?: number;
```

`VideoTab` 传 `unreachableBeforeBattleS={win.missingHeadS}`。

- `VideoMomentStrip`:**仅当 `unreachableBeforeBattleS > 0` 时**,`videoS < winStart` 的
  标记不再丢弃,钉在最左端渲染,加 class `rpt-video-strip-mark--unreachable` 与
  `title="该时刻在录像开始之前"`。
  **`unreachableBeforeBattleS` 为 0(默认)时保持既有丢弃行为** ——
  `VideoMomentStrip.test.tsx:36-54` 断言的就是这条,必须继续绿。
- `VideoMomentList`:`m.tS < unreachableBeforeBattleS` 的行加 class `unreachable`
  与同一个 `title`。

`VideoMomentStrip.test.tsx` 追加一例(缺头时不丢弃、有 unreachable class);
**新建** `VideoMomentList.test.tsx`(第一行 `// @vitest-environment jsdom`),
断言 unreachable 行的 class 与 title。

- [ ] **Step 9: 缺头提示条与播放失败提示**

```ts
const [playbackFailed, setPlaybackFailed] = useState(false);
```

`<video>`(:379-384 附近)加 `onError={() => setPlaybackFailed(true)}`。播放器上方渲染:

```tsx
{
  win.missingHeadS > 0.5 && (
    <div className="rpt-video-note">
      缺头 {Math.round(win.missingHeadS)} 秒 —— 录像比开场晚,这段没有画面
    </div>
  );
}
{
  playbackFailed && (
    <div className="rpt-video-note rpt-video-note--error">
      无法播放该录像(建议 OBS 录制格式设为 Hybrid MP4)
    </div>
  );
}
```

> 文案里**必须**出现"缺头"二字 —— 设计文档 §4.1 与 Step 1 的断言都按这个词。

`styles.css`:顺手删掉 :4607-4619 已废弃的 `.rpt-video-dock` 那组死 CSS;加
`.rpt-video-note` / `.rpt-video-note--error` / `.rpt-video-strip-mark--unreachable` /
`.rpt-video-moment-row.unreachable`。**颜色变量先 grep 相邻规则照抄,不新造。**

- [ ] **Step 10: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/renderer/src/report/components/) && npm run typecheck`
Expected: 全 PASS,且**只有 Step 2 那两条既有断言**被改过

- [ ] **Step 11: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/VideoTab.tsx packages/desktop/src/renderer/src/report/components/VideoTab.test.tsx packages/desktop/src/renderer/src/report/components/VideoMomentStrip.tsx packages/desktop/src/renderer/src/report/components/VideoMomentStrip.test.tsx packages/desktop/src/renderer/src/report/components/VideoMomentList.tsx packages/desktop/src/renderer/src/report/components/VideoMomentList.test.tsx packages/desktop/src/renderer/src/styles.css
git commit -m "fix(desktop): 回放对齐 —— offsetS 不再被 clamp 成 0(点事件不再晚整个日志滞后量)+ pre-roll + 缺头显式化"
```

> **视觉基线会变,这是预期的。** `dev/main.tsx:386-392` 的 video 场景**故意**指向一个
> 404 的 fixture URL 好让它稳定出黑帧 —— 加了 `onError` 之后那一格会多出提示文案。
> 三档基线**必须在 CI 上重生成**,**本机绝不跑 `test:visual`**。

---

### Task 3: RecordingsStore schema 2 —— 一段素材对多场对局

设计文档 §4.3。第 1 段"连续录 + 定点分片"的前提。

**Files:**

- Modify: `packages/desktop/src/main/recordingsStore.ts`
- Modify: `packages/desktop/src/main/recordingsStore.test.ts`(含**迁移 16 处既有构造**)
- Modify: `packages/desktop/src/main/recorder.ts`(两处构造 `RecordingEntry`)
- Modify: `packages/desktop/src/preload/api.ts`(`getForMatch` 返回类型)

**Interfaces:**

- Produces:`RECORDING_SCHEMA`(**值导出**,recorder.ts 需要 value import);
  `RecordingEntry { schema; videoPath; startedAt; stoppedAt: number | null; matchIds: string[] }`;
  `associate(meta)` 命中即**追加**;`getForMatch(id)` 按 `matchIds.includes` 查。

- [ ] **Step 1: 先迁移既有测试里的 16 处构造(不迁移就全是类型错误)**

`recordingsStore.test.ts` 里 `store.add({... matchId: X })` 共 **16 处**
(:38、:51、:69、:91、:113、:119、:140、:146、:174、:180、:186、:192、:213、:219、:225、:248),
一律改成 `{ schema: 2, ..., matchIds: X === null ? [] : [X] }` —— 即
`matchId: null` → `matchIds: []`,`matchId: "m1"` → `matchIds: ["m1"]`,
并给每个对象补 `schema: 2,`。

`:58` 的 `expect(hit?.matchId).toBe("m1")` → `expect(hit?.matchIds).toEqual(["m1"])`。

> 动手前先跑一遍 grep 确认数量与行号:
> `(cd packages/desktop && grep -n "matchId:" src/main/recordingsStore.test.ts)`

- [ ] **Step 2: 改写一条既有用例(语义变了,不是编译错误)**

`recordingsStore.test.ts:63-82` 的 `it("associate:窗口不沾边 → null;已关联的不再被抢")`:

- **前半段保留**(窗口不沾边 → null);
- **后半段** `expect(store.associate({ id: "m2", … })).toBeNull()` 改成:

```ts
// schema 2:一段素材可承载多场,第二场不再被拒(设计文档 §4.3)
expect(
  store.associate({ id: "m2", startTime: T0, endTime: T0 + 50_000 }),
).not.toBeNull();
expect(store.list()[0]!.matchIds).toEqual(["m1", "m2"]);
```

- 标题改成 `"associate:窗口不沾边 → null;已关联的分片可被第二场追加"`。

- [ ] **Step 3: 写新失败测试**(复用文件里已有的 `setup()` / `fakeVideo()`)

```ts
describe("RecordingsStore schema 2", () => {
  it("背靠背两场认领同一分片(一期的已知损失,现在修好)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "chunk.mp4");
    store.add({
      schema: 2,
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 600_000,
      matchIds: [],
    });
    expect(
      store.associate({
        id: "m1",
        startTime: T0 + 10_000,
        endTime: T0 + 200_000,
      }),
    ).not.toBeNull();
    expect(
      store.associate({
        id: "m2",
        startTime: T0 + 300_000,
        endTime: T0 + 500_000,
      }),
    ).not.toBeNull();
    expect(store.getForMatch("m1")?.videoPath).toBe(v);
    expect(store.getForMatch("m2")?.videoPath).toBe(v);
    expect(new RecordingsStore(dir).list()[0]!.matchIds).toEqual(["m1", "m2"]);
  });

  it("重复 associate 同一场是幂等的", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideo(dir, "a.mp4"),
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchIds: [],
    });
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    expect(store.list()[0]!.matchIds).toEqual(["m1"]);
  });

  it("老 schema 行读入时惰性升级,不丢关联", () => {
    const { dir } = setup(); // setup() 已建好目录,不要重复 mkdirSync
    writeFileSync(
      join(dir, "recordings.ndjson"),
      JSON.stringify({
        videoPath: "/tmp/old.mp4",
        startedAt: T0,
        stoppedAt: T0 + 1000,
        matchId: "old-match",
      }) +
        "\n" +
        JSON.stringify({
          videoPath: "/tmp/orphan.mp4",
          startedAt: T0,
          stoppedAt: T0 + 1000,
          matchId: null,
        }) +
        "\n",
    );
    const store = new RecordingsStore(dir);
    expect(store.getForMatch("old-match")?.videoPath).toBe("/tmp/old.mp4");
    expect(store.list()[1]!.matchIds).toEqual([]);
    expect(store.list().every((e) => e.schema === 2)).toBe(true);
  });

  it("仍在录的分片(stoppedAt=null)可被关联", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideo(dir, "live.mp4"),
      startedAt: T0,
      stoppedAt: null,
      matchIds: [],
    });
    expect(
      store.associate({
        id: "m1",
        startTime: T0 + 10_000,
        endTime: T0 + 20_000,
      }),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/main/recordingsStore.test.ts)`
Expected: FAIL

- [ ] **Step 5: 改类型与迁移**

```ts
/** Current on-disk schema version for a recordings.ndjson line. */
export const RECORDING_SCHEMA = 2 as const;

export interface RecordingEntry {
  schema: typeof RECORDING_SCHEMA;
  videoPath: string;
  /** Wall-clock epoch ms of this chunk's FIRST FRAME -- the replay side's
   * alignment anchor (shared/videoTime.ts consumes it). */
  startedAt: number;
  /** null while the chunk is still being written. */
  stoppedAt: number | null;
  /**
   * Every match carried by this chunk. Schema 1 had a scalar matchId, so a
   * chunk could only ever be claimed once -- back-to-back matches sharing one
   * recording left the second with nothing. Phase 2 records continuously and
   * splits on match boundaries, so one chunk legitimately carries several
   * matches (design doc 4.3).
   */
  matchIds: string[];
}

/** Schema 1 shape, kept only so migration can read it. */
interface LegacyEntryV1 {
  videoPath: string;
  startedAt: number;
  stoppedAt: number;
  matchId: string | null;
}

function upgrade(raw: unknown): RecordingEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Partial<RecordingEntry> & Partial<LegacyEntryV1>;
  if (typeof o.videoPath !== "string" || typeof o.startedAt !== "number") {
    return null;
  }
  const stoppedAt = typeof o.stoppedAt === "number" ? o.stoppedAt : null;
  const matchIds = Array.isArray(o.matchIds)
    ? o.matchIds.filter((m): m is string => typeof m === "string")
    : typeof o.matchId === "string"
      ? [o.matchId]
      : [];
  return {
    schema: RECORDING_SCHEMA,
    videoPath: o.videoPath,
    startedAt: o.startedAt,
    stoppedAt,
    matchIds,
  };
}
```

`list()` 里 `out.push(JSON.parse(l) as RecordingEntry)` 改成
`const up = upgrade(JSON.parse(l)); if (up) out.push(up);`。

`overlapMs` 的 `if (typeof e.stoppedAt !== "number") return null;` 改成
`if (e.stoppedAt === null) return null;`。

`associate()` 开头与候选过滤:

```ts
const entries = this.list();
// Idempotent: a chunk already carrying this match needs no write.
const already = entries.find((e) => e.matchIds.includes(meta.id));
if (already) return already;
const candidates = entries.filter(
  (e) =>
    e.startedAt <= meta.endTime + TOLERANCE_MS &&
    (e.stoppedAt === null || e.stoppedAt >= meta.startTime - TOLERANCE_MS),
);
```

命中后 `hit.matchIds.push(meta.id)` 取代 `hit.matchId = meta.id`。
`getForMatch` 改成 `find((e) => e.matchIds.includes(matchId))`。
`prune()` 里两处 `e.matchId !== null` / `=== null` 改成
`e.matchIds.length > 0` / `=== 0`(**只做机械替换**,双闸是 Task 4)。

**删掉** `associate()` 注释末尾"背靠背第一个 meta 到达者胜出,第二场什么都拿不到,
一期接受"那句 —— 已不成立,留着会误导。

- [ ] **Step 6: 修 recorder.ts 两处构造点(不改这里 Task 3 单独会打断编译)**

`recorder.ts` 现在只有 `import type { RecordingEntry, RecordingsStore } from "./recordingsStore";`。
改成:

```ts
import { RECORDING_SCHEMA } from "./recordingsStore";
import type { RecordingEntry, RecordingsStore } from "./recordingsStore";
```

`closeOrphanRecording()`(:160-165 附近)与 `doClose()`(:295-300 附近)两处
`const entry: RecordingEntry = { … matchId: null }` 的 `matchId: null` 换成
`schema: RECORDING_SCHEMA,` + `matchIds: [],`。

- [ ] **Step 7: 修 preload 的类型谎言**

`packages/desktop/src/preload/api.ts:318`(`getForMatch` 的签名跨 :316-318 三行)
把返回类型里的 `stoppedAt: number` 改成 `stoppedAt: number | null`。

> preload 走 `ipcRenderer.invoke`,返回值是 `any`,typecheck **抓不到**这处不一致 ——
> 必须手动改。renderer 只消费 `url`/`startedAt`,是纯类型改动。

- [ ] **Step 8: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/main/) && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 9: Commit**

```bash
git add packages/desktop/src/main/recordingsStore.ts packages/desktop/src/main/recordingsStore.test.ts packages/desktop/src/main/recorder.ts packages/desktop/src/preload/api.ts
git commit -m "feat(desktop): 录像索引 schema 2 —— 一段素材可对多场对局(背靠背不再丢第二场)"
```

---

### Task 4: 双闸配额(数量 + 字节)

设计文档 §4.2。评估文档点名要求过、一期没做的那条。

> **一处刻意的行为变更,必须同步改文档与 UI 文案**:`recordingKeepCount = 0` 今天的
> 契约是"**完全不清理**"(`settingsStore.ts:40-42` 注释 + 既有测试标题"0 = 不删")。
> 新语义是"**数量闸关闭,字节保险丝与孤儿上限仍生效**" —— 因为一个能被关掉的保险丝
> 不是保险丝(§4.2 的整个目的就是防止吃满盘)。本 Task 必须:改注释、改设置页文案、
> 补一条断言该行为的测试。**别让它静默漂移。**

**Files:**

- Modify: `packages/desktop/src/main/recordingsStore.ts`
- Modify: `packages/desktop/src/main/recordingsStore.test.ts`(含**迁移 5 处既有 prune 调用**)
- Modify: `packages/desktop/src/main/settingsStore.ts`
- Modify: `packages/desktop/src/main/settingsStore.recording.test.ts`
- Modify: `packages/desktop/test/settingsStore.test.ts`(**不在 `src/main/` 下,单跑 `src/main/` 扫不到**)
- Modify: `packages/desktop/src/main/recorder.ts`、`packages/desktop/src/main/recorder.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts`
- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`(keepCount 文案)

**Interfaces:**

- Produces:`prune(opts: { keepCount: number; maxBytes: number }) → { deleted: number; freedBytes: number }`;
  `GladlogSettings.recordingMaxBytes: number`(默认 `80 * 1024 ** 3`);
  `RecorderService.pruneNow(): void`。

- [ ] **Step 1: 迁移既有调用与全量 settings 构造点**

1. `recordingsStore.test.ts` 的 :121、:122、:194、:233、:253 五处
   `store.prune(N)` → `store.prune({ keepCount: N, maxBytes: Number.POSITIVE_INFINITY })`;
   `toEqual({ deleted: N })` → `toEqual({ deleted: N, freedBytes: expect.any(Number) })`。
2. `test/settingsStore.test.ts:16-29` 的整对象 `toEqual({...})` 补
   `recordingMaxBytes: 80 * 1024 ** 3,`;`:69-81` 的 `const base = {...}` 同样补
   (它被传给 `redactSettings(s: GladlogSettings)`,缺字段是类型错误)。
3. `src/renderer/src/fixtureBridge.ts:46` 附近的完整 settings 对象补同一行。
4. `recorder.test.ts` 三处构造 `RecorderSettings`(:64、:154、:182)补
   `recordingMaxBytes: Number.POSITIVE_INFINITY,`。

> 动手前先 grep 确认没有遗漏:
> `(cd packages/desktop && grep -rn "recordingKeepCount" src test dev qa)`

- [ ] **Step 2: 写失败测试**

```ts
// 追加到 recordingsStore.test.ts
function fakeVideoOfSize(dir: string, name: string, bytes: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 0));
  return p;
}

describe("prune 双闸", () => {
  it("keepCount<=0 = 数量闸关闭:已关联的分片一个不删", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "a.mp4", 10),
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: ["m1"],
    });
    expect(
      store.prune({ keepCount: 0, maxBytes: Number.POSITIVE_INFINITY }).deleted,
    ).toBe(0);
    expect(store.getForMatch("m1")).not.toBeNull();
  });

  it("keepCount<=0 时字节保险丝仍然生效(刻意的行为变更)", () => {
    const { dir, store } = setup();
    for (let i = 0; i < 3; i++) {
      store.add({
        schema: 2,
        videoPath: fakeVideoOfSize(dir, `c${i}.mp4`, 1000),
        startedAt: T0 + i * 1000,
        stoppedAt: T0 + i * 1000 + 500,
        matchIds: [`m${i}`],
      });
    }
    expect(store.prune({ keepCount: 0, maxBytes: 1500 }).deleted).toBe(2);
  });

  it("字节闸触发:即使数量没超,也驱逐到总量以下", () => {
    const { dir, store } = setup();
    for (let i = 0; i < 4; i++) {
      store.add({
        schema: 2,
        videoPath: fakeVideoOfSize(dir, `c${i}.mp4`, 1000),
        startedAt: T0 + i * 1000,
        stoppedAt: T0 + i * 1000 + 500,
        matchIds: [`m${i}`],
      });
    }
    expect(store.prune({ keepCount: 100, maxBytes: 2500 }).deleted).toBe(2);
    expect(store.list().map((e) => e.matchIds[0])).toEqual(["m3", "m2"]);
  });

  it("分片里所有对局都掉出保留集才删", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "shared.mp4", 1000),
      startedAt: T0,
      stoppedAt: T0 + 600_000,
      matchIds: ["old", "new"],
    });
    for (let i = 0; i < 3; i++) {
      store.add({
        schema: 2,
        videoPath: fakeVideoOfSize(dir, `x${i}.mp4`, 10),
        startedAt: T0 + 900_000 + i * 1000,
        stoppedAt: T0 + 900_000 + i * 1000 + 10,
        matchIds: [`x${i}`],
      });
    }
    expect(store.prune({ keepCount: 3, maxBytes: 1e9 }).deleted).toBe(1);
  });

  it("分片被整体录取:keepCount 装不下它全部对局时仍整片保留", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "shared.mp4", 1000),
      startedAt: T0,
      stoppedAt: T0 + 600_000,
      matchIds: ["old", "new"],
    });
    expect(store.prune({ keepCount: 1, maxBytes: 1e9 }).deleted).toBe(0);
  });

  it("仍在录的分片(stoppedAt=null)永不被驱逐", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "live.mp4", 10_000),
      startedAt: T0,
      stoppedAt: null,
      matchIds: [],
    });
    expect(store.prune({ keepCount: 1, maxBytes: 1 }).deleted).toBe(0);
  });

  it("freedBytes 报告真实释放量", () => {
    const { dir, store } = setup();
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "a.mp4", 700),
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchIds: ["a"],
    });
    store.add({
      schema: 2,
      videoPath: fakeVideoOfSize(dir, "b.mp4", 300),
      startedAt: T0 + 10,
      stoppedAt: T0 + 11,
      matchIds: ["b"],
    });
    expect(store.prune({ keepCount: 1, maxBytes: 1e9 }).freedBytes).toBe(700);
  });
});
```

```ts
// 追加到 settingsStore.recording.test.ts
it("recordingMaxBytes 默认 80GB;非法值丢弃", () => {
  const s = new SettingsStore(
    join(mkdtempSync(join(tmpdir(), "gl-")), "settings.json"),
  );
  expect(s.get().recordingMaxBytes).toBe(80 * 1024 ** 3);
  expect(sanitizeSettingsPatch({ recordingMaxBytes: -1 })).not.toHaveProperty(
    "recordingMaxBytes",
  );
  expect(
    sanitizeSettingsPatch({ recordingMaxBytes: Number.NaN }),
  ).not.toHaveProperty("recordingMaxBytes");
  expect(sanitizeSettingsPatch({ recordingMaxBytes: 1024 })).toEqual({
    recordingMaxBytes: 1024,
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/main/recordingsStore.test.ts src/main/settingsStore.recording.test.ts)`
Expected: FAIL

- [ ] **Step 4: 实现设置字段 + 改契约文案**

`settingsStore.ts`:`GladlogSettings` 在 `recordingKeepCount` 之后加:

```ts
/** Hard disk fuse for the recordings directory. Deliberately looser than the
 * worst case of recordingKeepCount (15Mbps x 10min ~= 1.1GB/match x 50 ~=
 * 55GB), so the count gate is what normally bites and this only catches
 * unusually large chunks. Design doc 4.2 -- user decision 2026-08-02. */
recordingMaxBytes: number;
```

`DEFAULTS` 加 `recordingMaxBytes: 80 * 1024 ** 3,`;`sanitizeSettingsPatch` 照
`recordingKeepCount` 那段形状加同款校验。

**改 `recordingKeepCount` 的注释**(:40-42):把"0 = never clean up"改成
`0 = count gate off; the byte fuse (recordingMaxBytes) and the orphan cap still apply`。
`SettingsPanel.tsx` 里对应的中文说明同步改。

- [ ] **Step 5: 实现双闸 prune**

整体替换 `prune`:

```ts
  /** Retention: TWO gates, whichever bites first.
   * - count gate: keep the most recent `keepCount` MATCHES (not chunks -- one
   *   chunk can carry several, design doc 4.3). keepCount <= 0 disables THIS
   *   GATE ONLY; the byte fuse and the orphan cap still apply (behaviour change
   *   2026-08-02 -- a fuse you can switch off is not a fuse).
   * - byte gate: keep total on-disk size under `maxBytes`.
   * A chunk is deleted only when NONE of its matches is in the keep set, so a
   * chunk is admitted whole (its extra matches may push past keepCount).
   * Chunks still being written (stoppedAt === null) are never evicted. */
  prune(opts: { keepCount: number; maxBytes: number }): {
    deleted: number;
    freedBytes: number;
  } {
    const entries = this.list();
    this.reportUnindexedFiles(entries);

    const live = entries.filter((e) => e.stoppedAt === null);
    const closed = entries
      .filter((e) => e.stoppedAt !== null)
      .sort((a, b) => b.startedAt - a.startedAt);

    const countGateOff = opts.keepCount <= 0;
    const keptMatches = new Set<string>();
    const keep = new Set<RecordingEntry>();
    const orphans: RecordingEntry[] = [];
    for (const e of closed) {
      if (e.matchIds.length === 0) {
        orphans.push(e);
        continue;
      }
      const admits =
        countGateOff ||
        e.matchIds.some(
          (m) => keptMatches.has(m) || keptMatches.size < opts.keepCount,
        );
      if (admits) {
        for (const m of e.matchIds) keptMatches.add(m);
        keep.add(e);
      }
    }
    for (const e of orphans.slice(0, ORPHAN_KEEP_CAP)) keep.add(e);

    const sizeOf = (e: RecordingEntry): number => {
      try {
        return statSync(e.videoPath).size;
      } catch {
        return 0;
      }
    };
    let running = live.reduce((n, e) => n + sizeOf(e), 0);
    for (const e of closed) {
      if (!keep.has(e)) continue;
      const sz = sizeOf(e);
      if (running + sz > opts.maxBytes) {
        keep.delete(e);
        continue;
      }
      running += sz;
    }

    let deleted = 0;
    let freedBytes = 0;
    const survivors: RecordingEntry[] = [];
    for (const e of closed) {
      if (keep.has(e)) continue;
      const sz = sizeOf(e);
      let removed = true;
      try {
        if (existsSync(e.videoPath)) unlinkSync(e.videoPath);
      } catch {
        // Held open by vod:// playback on Windows -- keep the line and retry
        // next prune, so the file never becomes unreachable-but-on-disk (I4).
        removed = false;
      }
      if (removed) {
        deleted++;
        freedBytes += sz;
      } else {
        survivors.push(e);
      }
    }
    if (deleted === 0 && survivors.length === 0) {
      return { deleted: 0, freedBytes: 0 };
    }
    this.rewrite([...live, ...closed.filter((e) => keep.has(e)), ...survivors]);
    return { deleted, freedBytes };
  }
```

- [ ] **Step 6: 接线三处调用点 + 补一条接线测试**

1. `recorder.ts` 的 `RecorderSettings` 加 `recordingMaxBytes: number;`;
2. `:305` 改成:
   ```ts
   const s = deps.getSettings();
   deps.recordings.prune({
     keepCount: s.recordingKeepCount,
     maxBytes: s.recordingMaxBytes,
   });
   ```
3. `RecorderService` 加 `pruneNow(): void`:
   ```ts
       pruneNow() {
         try {
           const s = deps.getSettings();
           deps.recordings.prune({
             keepCount: s.recordingKeepCount,
             maxBytes: s.recordingMaxBytes,
           });
         } catch {
           /* retention must never break the main pipeline */
         }
       },
   ```
4. `doClose()` 的 catch 分支与 `closeOrphanRecording()` 末尾各调一次 `pruneNow()`;
5. `main/index.ts` 在 `createRecorderService(...)` 之后立刻 `recorder.pruneNow();`;
6. **新增一条 recorder 测试**:造一个 `stopRecord` 抛错的 fake,预置一条超额索引行,
   `onSegmentClose` 后断言该行被回收(证明失败路径也走配额)。

- [ ] **Step 7: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/main/ test/settingsStore.test.ts) && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add packages/desktop/src/main/recordingsStore.ts packages/desktop/src/main/recordingsStore.test.ts packages/desktop/src/main/settingsStore.ts packages/desktop/src/main/settingsStore.recording.test.ts packages/desktop/test/settingsStore.test.ts packages/desktop/src/main/recorder.ts packages/desktop/src/main/recorder.test.ts packages/desktop/src/main/index.ts packages/desktop/src/renderer/src/fixtureBridge.ts packages/desktop/src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(desktop): 录像双闸配额(数量+字节,默认 80GB)—— 失败路径与启动时也回收;keepCount=0 改为仅关数量闸"
```

---

### Task 5: 录制状态上屏(设置页 + 主界面)

设计文档 §4.5 / §2.9。状态面已铺到 preload,渲染层零消费者。**两个 bullet 都要做** ——
主界面那条才是真正治"OBS 没开 = 完全静默地不录"的。

**Files:**

- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`
- Create: `packages/desktop/src/renderer/src/components/SettingsPanel.recorder.test.tsx`
- Modify: `packages/desktop/src/renderer/src/App.tsx`
- Create: `packages/desktop/src/renderer/src/App.recorderBanner.test.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css`

**Interfaces:**

- Consumes: `bridge().recorder.getStatus()` / `bridge().recorder.onStatus(cb)`,载荷
  `RecorderStatus { enabled: boolean; connected: boolean; recording: boolean; lastError: string | null }`。
- Produces: 无。

> 事实核对过:`SettingsPanel` 是**具名导出、无 props**(`export function SettingsPanel()`);
> `App` 是**默认导出、props 全可选**(`<App />` 可直接挂);两者都走 `bridge()`。
> 目前**没有** SettingsPanel 的测试文件,`App.pagination.test.tsx` 是可照抄的范例。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/desktop/src/renderer/src/components/SettingsPanel.recorder.test.tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { bridge } from "../bridge";

vi.mock("../bridge");

type Status = {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
};

function mountWith(status: Status) {
  (bridge as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    settings: {
      get: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockResolvedValue({}),
    },
    recorder: {
      getStatus: vi.fn().mockResolvedValue(status),
      onStatus: vi.fn().mockReturnValue(() => {}),
      testConnection: vi.fn(),
      autoConfig: vi.fn(),
      getForMatch: vi.fn(),
    },
  });
  return render(<SettingsPanel />);
}

const base: Status = {
  enabled: true,
  connected: true,
  recording: false,
  lastError: null,
};

beforeEach(() => vi.clearAllMocks());

describe("SettingsPanel 录像状态", () => {
  it("未启用时明说未启用", async () => {
    const { container } = mountWith({ ...base, enabled: false });
    await waitFor(() =>
      expect(container.querySelector(".set-rec-status")?.textContent).toContain(
        "未启用",
      ),
    );
  });

  it("启用但没连上时明说未连接 —— 这正是一期静默漏录的场景", async () => {
    const { container } = mountWith({ ...base, connected: false });
    await waitFor(() =>
      expect(container.querySelector(".set-rec-status")?.textContent).toContain(
        "未连接",
      ),
    );
  });

  it("正在录时显示正在录制", async () => {
    const { container } = mountWith({ ...base, recording: true });
    await waitFor(() =>
      expect(container.querySelector(".set-rec-status")?.textContent).toContain(
        "正在录制",
      ),
    );
  });

  it("有 lastError 时把错误原文显示出来", async () => {
    mountWith({
      ...base,
      connected: false,
      lastError: "connect ECONNREFUSED 127.0.0.1:4455",
    });
    await waitFor(() => expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy());
  });
});
```

```tsx
// packages/desktop/src/renderer/src/App.recorderBanner.test.tsx
// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { bridge } from "./bridge";

vi.mock("./bridge");

type Status = {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
};

function mountWith(status: Status) {
  (bridge as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    matches: {
      page: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn(),
    },
    logs: { onMatchStored: () => () => {} },
    settings: { get: vi.fn().mockResolvedValue({ wowDirectory: "/wow" }) },
    recorder: {
      getStatus: vi.fn().mockResolvedValue(status),
      onStatus: vi.fn().mockReturnValue(() => {}),
    },
  });
  return render(<App />);
}

beforeEach(() => vi.clearAllMocks());

describe("App 录像未连接横幅", () => {
  it("启用 + 未连接 + 没在录 → 出现", async () => {
    const { container } = mountWith({
      enabled: true,
      connected: false,
      recording: false,
      lastError: null,
    });
    await waitFor(() =>
      expect(container.querySelector(".app-rec-warn")).toBeTruthy(),
    );
  });

  it("未启用 → 不出现", async () => {
    const { container } = mountWith({
      enabled: false,
      connected: false,
      recording: false,
      lastError: null,
    });
    await waitFor(() =>
      expect(container.querySelector(".app-rec-warn")).toBeNull(),
    );
  });

  it("已连接 → 不出现", async () => {
    const { container } = mountWith({
      enabled: true,
      connected: true,
      recording: false,
      lastError: null,
    });
    await waitFor(() =>
      expect(container.querySelector(".app-rec-warn")).toBeNull(),
    );
  });

  it("正在录制 → 不出现", async () => {
    const { container } = mountWith({
      enabled: true,
      connected: true,
      recording: true,
      lastError: null,
    });
    await waitFor(() =>
      expect(container.querySelector(".app-rec-warn")).toBeNull(),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/renderer/src/components/SettingsPanel.recorder.test.tsx src/renderer/src/App.recorderBanner.test.tsx)`
Expected: FAIL

- [ ] **Step 3: 设置页状态行**

`SettingsPanel.tsx` 的「对局录像(OBS)」组(现址 :353-470)最上方加:

```tsx
const [recStatus, setRecStatus] = useState<{
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
} | null>(null);

useEffect(() => {
  try {
    const api = bridge().recorder;
    if (!api?.getStatus) return;
    void api.getStatus().then(setRecStatus);
    return api.onStatus?.(setRecStatus);
  } catch {
    /* degraded / fixture bridge -- the row simply does not render */
  }
}, []);

function recStatusText(s: {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
}): string {
  if (!s.enabled) return "未启用";
  if (s.recording) return "正在录制";
  if (!s.connected) return "未连接";
  return "已就绪";
}
```

```tsx
{
  recStatus && (
    <div className="set-rec-status">
      <span
        className={`set-rec-dot set-rec-dot--${
          recStatus.recording ? "rec" : recStatus.connected ? "ok" : "off"
        }`}
      />
      {recStatusText(recStatus)}
      {recStatus.lastError && (
        <span className="set-rec-error">{recStatus.lastError}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 主界面横幅**

`App.tsx` 里照该文件既有 bridge 订阅的 try/catch 写法(见 `wowDir` 那个 effect)加:

```tsx
const [recWarn, setRecWarn] = useState(false);

useEffect(() => {
  const apply = (s: {
    enabled: boolean;
    connected: boolean;
    recording: boolean;
  }) => setRecWarn(s.enabled && !s.connected && !s.recording);
  try {
    const api = bridge().recorder;
    if (!api?.getStatus) return;
    void api.getStatus().then(apply);
    return api.onStatus?.(apply);
  } catch {
    /* the test stub may not have a recorder surface */
  }
}, []);
```

```tsx
{
  recWarn && <div className="app-rec-warn">录像未连接:这一场不会被录下</div>;
}
```

`styles.css` 补 `.set-rec-status` / `.set-rec-dot` / `.set-rec-error` / `.app-rec-warn`,
**颜色变量照该文件既有命名照抄,不新造**。

- [ ] **Step 5: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/renderer/) && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/components/SettingsPanel.tsx packages/desktop/src/renderer/src/components/SettingsPanel.recorder.test.tsx packages/desktop/src/renderer/src/App.tsx packages/desktop/src/renderer/src/App.recorderBanner.test.tsx packages/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): 录像状态上屏 —— 设置页状态行 + 主界面「不会被录下」横幅"
```

> 主界面横幅**可能影响视觉基线**(取决于 qa 场景里 recorder 桩的状态)。CI 视觉任务
> 变红就在 CI 上重生成,**本机绝不跑 `test:visual`**。

---

### Task 6: `CaptureBackend` 接口 + obs-websocket 适配(**只建不接线**)

设计文档 §4.4 / §6 / §2.10。

> **范围刻意收窄。** 让 `recorder.ts` 改路由到新接口经复核证明不可行:`probe()` 回答的
> 不是 `getRecordStatus()` 的问题、backend 吞错误会让 recorder 的 `lastError` 断言全灭、
> `isAlreadyActiveError` 的 C1 重试与"绝不停用户自己的录制"保证会变成死码、`withTimeout`
> 被绕过、`testConnection` 无处安放 —— 至少 5 类断言必须改,而那正是"重构不该改变行为"
> 的反面。
>
> 所以第 0 段**只建文件与单测,一行接线都不做**;recorder 的重新布线放到第 1 段,
> 与那时的状态机重设计一起做。

**Files:**

- Create: `packages/desktop/src/main/captureBackend.ts`
- Create: `packages/desktop/src/main/obsWebsocketBackend.ts`
- Create: `packages/desktop/src/main/obsWebsocketBackend.test.ts`
- Modify: `docs/plans/2026-08-02-obs-phase2-design.md`(§4.4 与 §6 回改)

**Interfaces:**

- Consumes: `ObsClientLike`(`obsClient.ts`,六个方法)、`DEFAULT_OBS_WS_URL`(`shared/protocol.ts`)。
- Produces:`CaptureChunk`、`BackendHealth`、`CaptureBackend`、`createObsWebsocketBackend`。
  **第 0 段没有任何生产代码消费它们** —— 刻意的。

- [ ] **Step 1: 写失败测试**

```ts
// packages/desktop/src/main/obsWebsocketBackend.test.ts
import { describe, expect, it } from "vitest";
import { createObsWebsocketBackend } from "./obsWebsocketBackend";
import type { ObsClientLike } from "./obsClient";

const T0 = 1_750_000_000_000;

function fake(overrides?: Partial<ObsClientLike>) {
  const calls: string[] = [];
  const client: ObsClientLike = {
    connect: async () => {
      calls.push("connect");
    },
    startRecord: async () => {
      calls.push("start");
    },
    stopRecord: async () => {
      calls.push("stop");
      return { outputPath: "/tmp/out.mp4" };
    },
    getRecordStatus: async () => ({ outputActive: false }),
    disconnect: async () => {
      calls.push("disconnect");
    },
    onClosed: () => {},
    ...overrides,
  };
  return { client, calls };
}

function setup(overrides?: Partial<ObsClientLike>) {
  const { client, calls } = fake(overrides);
  let t = T0;
  const backend = createObsWebsocketBackend({
    clientFactory: () => client,
    getConnection: () => ({ url: null, password: null }),
    now: () => (t += 1000),
  });
  return { backend, calls };
}

describe("obs-websocket backend 适配 CaptureBackend", () => {
  it("startContinuous 懒连接后起录", async () => {
    const { backend, calls } = setup();
    await backend.startContinuous();
    expect(calls).toEqual(["connect", "start"]);
  });

  it("重复 startContinuous 幂等", async () => {
    const { backend, calls } = setup();
    await backend.startContinuous();
    await backend.startContinuous();
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("splitChunk 退化成 stop+start,返回刚关闭的分片", async () => {
    const { backend, calls } = setup();
    await backend.startContinuous();
    const chunk = await backend.splitChunk();
    expect(chunk).toMatchObject({ videoPath: "/tmp/out.mp4" });
    expect(chunk!.stoppedAt).not.toBeNull();
    expect(calls).toEqual(["connect", "start", "stop", "start"]);
  });

  it("没在录时 splitChunk / stopContinuous 返回 null 且不碰 OBS", async () => {
    const { backend, calls } = setup();
    expect(await backend.splitChunk()).toBeNull();
    expect(await backend.stopContinuous()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("onChunkOpened 每次起录触发一次,startedAt 递增", async () => {
    const { backend } = setup();
    const opened: number[] = [];
    backend.onChunkOpened((c) => opened.push(c.startedAt));
    await backend.startContinuous();
    await backend.splitChunk();
    expect(opened).toHaveLength(2);
    expect(opened[1]!).toBeGreaterThan(opened[0]!);
  });

  it("连接失败时 lastError 置位、不上抛", async () => {
    const { backend } = setup({
      connect: async () => {
        throw new Error("refused");
      },
    });
    await backend.startContinuous();
    const h = await backend.probe();
    expect(h.ready).toBe(false);
    expect(h.lastError).toContain("refused");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `(cd packages/desktop && npx vitest run src/main/obsWebsocketBackend.test.ts)`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `captureBackend.ts`**

```ts
// packages/desktop/src/main/captureBackend.ts

/** One recorded chunk. A chunk may carry several matches (design doc 4.3). */
export interface CaptureChunk {
  videoPath: string;
  /** Wall-clock epoch ms of the chunk's first frame -- the replay anchor. */
  startedAt: number;
  /** null while the chunk is still being written. */
  stoppedAt: number | null;
}

export interface BackendHealth {
  ready: boolean;
  /** Selected video encoder id, when the backend can tell. */
  encoder: string | null;
  /** Whether the capture source is actually producing frames. */
  sourceActive: boolean;
  lastError: string | null;
}

/**
 * Capture-side abstraction, defined in CONTINUOUS-RECORDING terms rather than
 * per-match start/stop, because that is what phase 2's managed OBS instance
 * does (design doc 5.5). The external-OBS implementation degrades splitChunk
 * to stop+start; nothing in phase 0 consumes this yet -- recorder.ts is rewired
 * in phase 1 together with its state-machine redesign.
 */
export interface CaptureBackend {
  /** WoW is running -> begin recording continuously. Idempotent. */
  startContinuous(): Promise<void>;
  /** Stop and return the chunk that just closed, or null if not recording. */
  stopContinuous(): Promise<CaptureChunk | null>;
  /** Cut here. Returns the chunk that just closed, or null if not recording. */
  splitChunk(): Promise<CaptureChunk | null>;
  /** Notified whenever a new chunk starts (videoPath may be empty until the
   * backend learns it). */
  onChunkOpened(cb: (c: CaptureChunk) => void): void;
  probe(): Promise<BackendHealth>;
  shutdown(): Promise<void>;
}
```

- [ ] **Step 4: 实现 `obsWebsocketBackend.ts`**

```ts
import { DEFAULT_OBS_WS_URL } from "../shared/protocol";
import type {
  BackendHealth,
  CaptureBackend,
  CaptureChunk,
} from "./captureBackend";
import type { ObsClientLike } from "./obsClient";

/**
 * CaptureBackend over an EXTERNALLY running OBS (phase 1's model, kept in
 * phase 2 as the "use my own OBS" bypass). It has no real continuous mode:
 * startContinuous is one StartRecord and splitChunk degrades to StopRecord +
 * StartRecord -- acceptable here because file splitting is off, so StopRecord's
 * outputPath is trustworthy (design doc 5.7 / 6).
 */
export function createObsWebsocketBackend(deps: {
  clientFactory: () => ObsClientLike;
  getConnection: () => { url: string | null; password: string | null };
  now?: () => number;
}): CaptureBackend {
  const now = deps.now ?? Date.now;
  let client: ObsClientLike | null = null;
  let connected = false;
  let openedAt: number | null = null;
  let lastError: string | null = null;
  const openedCallbacks: Array<(c: CaptureChunk) => void> = [];

  async function ensureConnected(): Promise<void> {
    if (connected && client) return;
    const conn = deps.getConnection();
    client = deps.clientFactory();
    client.onClosed(() => {
      connected = false;
      openedAt = null;
    });
    await client.connect(
      conn.url ?? DEFAULT_OBS_WS_URL,
      conn.password ?? undefined,
    );
    connected = true;
  }

  async function beginRecord(): Promise<void> {
    await ensureConnected();
    await client!.startRecord();
    openedAt = now();
    lastError = null;
    for (const cb of openedCallbacks) {
      cb({ videoPath: "", startedAt: openedAt, stoppedAt: null });
    }
  }

  async function endRecord(): Promise<CaptureChunk | null> {
    if (openedAt === null || !client) return null;
    const startedAt = openedAt;
    const { outputPath } = await client.stopRecord();
    openedAt = null;
    return { videoPath: outputPath, startedAt, stoppedAt: now() };
  }

  return {
    async startContinuous() {
      if (openedAt !== null) return; // idempotent
      try {
        await beginRecord();
      } catch (e) {
        lastError = String(e);
      }
    },
    async stopContinuous() {
      try {
        return await endRecord();
      } catch (e) {
        lastError = String(e);
        return null;
      }
    },
    async splitChunk() {
      if (openedAt === null) return null;
      try {
        const closed = await endRecord();
        await beginRecord();
        return closed;
      } catch (e) {
        lastError = String(e);
        return null;
      }
    },
    onChunkOpened(cb) {
      openedCallbacks.push(cb);
    },
    async probe(): Promise<BackendHealth> {
      return {
        ready: connected,
        encoder: null, // not reachable over obs-websocket (design doc 2.5)
        sourceActive: connected,
        lastError,
      };
    },
    async shutdown() {
      try {
        await endRecord();
      } catch {
        /* best effort on the quit path */
      }
      try {
        await client?.disconnect();
      } catch {
        /* same */
      }
      connected = false;
      client = null;
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `(cd packages/desktop && npx vitest run src/main/) && npm run typecheck`
Expected: 全 PASS。**`recorder.ts` / `recorder.test.ts` 一个字都不该动。**

- [ ] **Step 6: 回改设计文档两处**

1. §6 的 `stopContinuous(): Promise<void>;` → `Promise<CaptureChunk | null>;`
   (调用方要拿到刚关闭的分片才能落索引,返回 void 会逼它再查一次)。
2. §4.4 现在写着"第 0 段先定义接口,并让**现有的 obs-websocket 实现去适配它** ——
   这样第 0 段结束时一期功能完全可用,且接口已被一个真实现验证过",会被读成"第 0 段
   就把生产链路接过去"。改成:"第 0 段只建接口与 obs-websocket 实现**并单测**,
   **不接线**;recorder 的重新布线在第 1 段与状态机重设计一起做(理由见 stage0 计划
   Task 6 的框)。"

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/captureBackend.ts packages/desktop/src/main/obsWebsocketBackend.ts packages/desktop/src/main/obsWebsocketBackend.test.ts docs/plans/2026-08-02-obs-phase2-design.md
git commit -m "feat(desktop): CaptureBackend 接口 + obs-websocket 适配(只建不接线,布线随第 1 段)"
```

---

### Task 7: Windows 门测脚本

设计文档 §3(那道门)+ §9.4。**这是要交给用户跑的东西**,产出决定第 1 段计划怎么写。

**Files:**

- Create: `packages/desktop/scripts/obsGateCheck.ts`(**`.ts`,不是 `.mts`** ——
  `scripts/` 下现有的是 `.ts` 与 `.mjs`)
- Modify: `packages/desktop/package.json`

**Interfaces:**

- Consumes: Task 1 的 `computeVideoWindow`(算 headroom,**Global Constraints 的谓词单源
  要求,必须真的 import**);`obs-websocket-js`(已是 desktop 依赖)。
- Produces: 一份 stdout 表格。**不产出可复用模块** —— 一次性探针。

- [ ] **Step 1: 写脚本**

```ts
// packages/desktop/scripts/obsGateCheck.ts
/**
 * OBS phase-2 gate check -- run this ON WINDOWS, with WoW running.
 *
 *   npm run recorder:gatecheck --workspace=packages/desktop
 *
 * Answers, in one shot, everything design doc 3 says must be confirmed on real
 * hardware before the managed-OBS work starts. THROWAWAY probe: hardcodes,
 * writes to a temp directory, touches no app code.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import OBSWebSocket from "obs-websocket-js";

import { computeVideoWindow } from "../src/shared/videoTime";

const OBS_VERSION = "32.2.1";
const OBS_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/OBS-Studio-${OBS_VERSION}-Windows-x64.zip`;
const OBS_SHA256 =
  "db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de";
const OBS_BYTES = 187_817_017;
const WS_PORT = 4466;
const WS_PASSWORD = "gladlog-gatecheck";
const OVERLAYS = [
  "RTSS",
  "RTSSHooksLoader64",
  "MSIAfterburner",
  "NVIDIA Share",
  "GeForceExperience",
];

const row = (k: string, v: string) => console.log(`${k.padEnd(12)} ${v}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd: string): string =>
  spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
    encoding: "utf-8",
  }).stdout ?? "";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms),
    ),
  ]);
}

function dirSizeMb(dir: string): number {
  let bytes = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else bytes += statSync(p).size;
    }
  };
  walk(dir);
  return Math.round(bytes / 1_000_000);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.error("这个脚本只能在 Windows 上跑 —— 它要验的就是 Windows 行为。");
    process.exit(2);
  }

  const root = join(tmpdir(), "gladlog-obs-gate");
  mkdirSync(root, { recursive: true });
  const zipPath = join(root, "obs.zip");
  const obsRoot = join(root, OBS_VERSION);
  const recDir = join(root, "rec");
  mkdirSync(recDir, { recursive: true });

  // --- download + verify ------------------------------------------------
  if (!existsSync(zipPath) || statSync(zipPath).size !== OBS_BYTES) {
    console.log(`下载 OBS ${OBS_VERSION}(179MB,只下一次)…`);
    const res = await fetch(OBS_URL);
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as never),
      createWriteStream(zipPath),
    );
  }
  const got = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  row(
    "download",
    got === OBS_SHA256 ? `OK (${OBS_BYTES}B)` : `哈希不符 ${got}`,
  );
  if (got !== OBS_SHA256) process.exit(1);

  // --- extract with the system tar (bsdtar) -- assumption under test -----
  const obsExe = join(obsRoot, "bin", "64bit", "obs64.exe");
  if (!existsSync(obsExe)) {
    mkdirSync(obsRoot, { recursive: true });
    const r = spawnSync("tar", ["-xf", zipPath, "-C", obsRoot], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      row("extract", `tar -xf 失败:${(r.stderr ?? "").slice(0, 200)}`);
      process.exit(1);
    }
  }
  row(
    "extract",
    existsSync(obsExe)
      ? `OK (${dirSizeMb(obsRoot)}MB,全量未裁剪)`
      : "obs64.exe 不在预期路径",
  );

  // --- write a minimal portable config ----------------------------------
  writeFileSync(join(obsRoot, "portable_mode.txt"), "");
  const cfg = join(obsRoot, "config", "obs-studio");
  mkdirSync(join(cfg, "plugin_config", "obs-websocket"), { recursive: true });
  mkdirSync(join(cfg, "basic", "profiles", "gladlog"), { recursive: true });
  mkdirSync(join(cfg, "basic", "scenes"), { recursive: true });

  writeFileSync(
    join(cfg, "user.ini"),
    [
      "[General]",
      "FirstRun=true",
      "",
      "[Basic]",
      "Profile=gladlog",
      "ProfileDir=gladlog",
      "SceneCollection=gladlog",
      "SceneCollectionFile=gladlog",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cfg, "global.ini"),
    `[General]\nLastVersion=${OBS_VERSION}\n`,
  );
  writeFileSync(
    join(cfg, "plugin_config", "obs-websocket", "config.json"),
    JSON.stringify({
      first_load: false,
      server_enabled: true,
      server_port: WS_PORT,
      server_password: WS_PASSWORD,
      auth_required: true,
      alerts_enabled: false,
    }),
  );
  writeFileSync(
    join(cfg, "basic", "profiles", "gladlog", "basic.ini"),
    [
      "[General]",
      "Name=gladlog",
      "",
      "[Output]",
      "Mode=Advanced",
      "",
      "[AdvOut]",
      "RecType=Standard",
      `RecFilePath=${recDir}`,
      "RecFormat2=hybrid_mp4",
      "RecEncoder=obs_x264",
      "RecSplitFile=true",
      "",
      "[Video]",
      "AutoRemux=false",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cfg, "basic", "profiles", "gladlog", "recordEncoder.json"),
    JSON.stringify({ rate_control: "CBR", bitrate: 8000, keyint_sec: 1 }),
  );
  writeFileSync(
    join(cfg, "basic", "scenes", "gladlog.json"),
    JSON.stringify({
      name: "gladlog",
      current_scene: "gladlog",
      current_program_scene: "gladlog",
      sources: [
        {
          name: "gladlog",
          id: "scene",
          versioned_id: "scene",
          settings: { items: [] },
        },
      ],
    }),
  );

  // --- environment checks (design doc 3's top three risks) --------------
  const gpuList = ps("Get-CimInstance Win32_VideoController | % { $_.Name }")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const gpuPref = ps(
    "try { (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences').PSObject.Properties | " +
      "? { $_.Name -like '*Wow*' } | % { \"$($_.Name)=$($_.Value)\" } } catch { '' }",
  ).trim();
  row(
    "gpu",
    `显卡 ${gpuList.length} 块:${gpuList.join(" / ")}` +
      (gpuList.length > 1
        ? ` —— 多卡机器,WoW 的 GPU 偏好:${gpuPref || "(未设置)"};` +
          "起录后请对照 OBS 日志里 'Loading up D3D11 on adapter' 那行是否同一块"
        : "(单卡,无适配器不匹配风险)"),
  );

  const wowElevated = ps(
    "try { $p = Get-Process Wow -ErrorAction Stop; " +
      "$p | % { (Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\").CommandLine } | Out-Null; 'running' } " +
      "catch { 'absent' }",
  ).trim();
  const selfAdmin = ps(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ).trim();
  row(
    "integrity",
    `WoW 进程 ${wowElevated};本脚本管理员权限=${selfAdmin} —— ` +
      "若 WoW 提权而这里是 False,钩取会失败(设计文档 §3 第 2 号成因)",
  );

  const running = ps("Get-Process | % { $_.ProcessName }").split(/\r?\n/);
  const hits = OVERLAYS.filter((o) =>
    running.some((p) => p.trim().toLowerCase() === o.toLowerCase()),
  );
  row(
    "hooks",
    hits.length ? `冲突覆盖层在场:${hits.join(", ")}` : "无已知冲突覆盖层",
  );

  // --- spawn ------------------------------------------------------------
  const sentinel = join(cfg, ".sentinel");
  if (existsSync(sentinel)) {
    for (const f of readdirSync(sentinel)) {
      if (f.startsWith("run_")) rmSync(join(sentinel, f), { force: true });
    }
  }
  const bin = join(obsRoot, "bin", "64bit");
  const child = spawn(
    obsExe,
    [
      "--portable",
      "--multi",
      "--only-bundled-plugins",
      "--minimize-to-tray",
      "--disable-updater",
      "--disable-missing-files-check",
      "--collection",
      "gladlog",
      "--profile",
      "gladlog",
      "--scene",
      "gladlog",
      "--websocket_port",
      String(WS_PORT),
      "--websocket_password",
      WS_PASSWORD,
    ],
    { cwd: bin, stdio: "ignore" },
  );

  const obs = new OBSWebSocket();
  // MUST be attached before StartRecord: SplitRecordFile returns no filename,
  // and StopRecord.outputPath keeps returning the FIRST chunk (design doc 2.5).
  const chunks: Array<{ path: string; at: number }> = [];
  obs.on("RecordFileChanged", (d: { newOutputPath: string }) =>
    chunks.push({ path: d.newOutputPath, at: Date.now() }),
  );
  obs.on(
    "RecordStateChanged",
    (d: { outputState: string; outputPath?: string }) => {
      if (d.outputState.endsWith("STARTED") && d.outputPath) {
        chunks.push({ path: d.outputPath, at: Date.now() });
      }
    },
  );

  let hello: { obsWebSocketVersion?: string };
  try {
    hello = await withTimeout(
      obs.connect(`ws://127.0.0.1:${WS_PORT}`, WS_PASSWORD),
      20_000,
      "websocket 连接",
    );
    row("spawn", "OK(连得上就说明事件循环没被模态框阻塞)");
    row("websocket", `OK obs-websocket ${hello.obsWebSocketVersion ?? "?"}`);
  } catch (e) {
    row("spawn", `连不上:${String(e)} —— 去看一眼屏幕上有没有弹窗`);
    child.kill();
    process.exit(1);
  }

  const profile = await obs.call("GetProfileList");
  row(
    "profile",
    profile.currentProfileName === "gladlog"
      ? "OK 生效的是 gladlog(便携路径 cwd 假设成立)"
      : `生效的是 ${profile.currentProfileName} —— 静默回退了,cwd 假设不成立`,
  );

  const kinds = await obs
    .call("GetInputKindList")
    .catch(() => ({ inputKinds: [] as string[] }));
  row(
    "encoders",
    `输入类型 ${kinds.inputKinds.length} 种,game_capture ${
      kinds.inputKinds.includes("game_capture") ? "在" : "不在"
    }`,
  );

  await obs.call("CreateInput", {
    sceneName: "gladlog",
    inputName: "gc",
    inputKind: "game_capture",
    inputSettings: {
      capture_mode: "any_fullscreen",
      priority: 2,
      anti_cheat_hook: true,
    },
    sceneItemEnabled: true,
  });
  await sleep(5000); // give the hook time to attach
  const shotPath = join(root, "shot.png");
  const shot = await obs
    .call("SaveSourceScreenshot", {
      sourceName: "gc",
      imageFormat: "png",
      imageFilePath: shotPath,
    })
    .then(() => "OK")
    .catch((e) => String(e));
  row(
    "capture",
    shot === "OK"
      ? `截图已存 ${shotPath} —— 打开看是不是黑的`
      : `截图失败:${shot}`,
  );

  // --- record + split ---------------------------------------------------
  const recordStart = Date.now();
  await obs.call("StartRecord");
  await sleep(20_000);
  await obs
    .call("SplitRecordFile")
    .catch((e) => row("split", `SplitRecordFile 失败:${String(e)}`));
  await sleep(3000);
  await obs.call("StopRecord");
  await sleep(2000);
  const recordEnd = Date.now();

  row(
    "split",
    chunks.length
      ? `拿到 ${chunks.length} 个分片路径:${chunks.map((c) => c.path).join(" | ")}`
      : "没收到任何 RecordFileChanged / RecordStateChanged 路径",
  );

  // headroom through the SAME predicate the product uses (shared-predicate rule)
  const first = chunks[0];
  if (first) {
    const w = computeVideoWindow({
      matchStartMs: first.at + 5000, // simulated opening 5s into the chunk
      matchEndMs: recordEnd,
      recordingStartedAtMs: first.at,
      durationS: (recordEnd - first.at) / 1000,
    });
    row("headroom", `${w.headroomS.toFixed(2)}s(带符号;二期目标恒为正)`);
  } else {
    row("headroom", "无分片路径,算不出");
  }

  const files = readdirSync(recDir).map((f) => statSync(join(recDir, f)).size);
  const total = files.reduce((n, x) => n + x, 0);
  const secs = (recordEnd - recordStart) / 1000;
  row(
    "bitrate",
    `${(total / 1_000_000).toFixed(1)}MB / ${secs.toFixed(0)}s → 约 ${(
      (total * 8) /
      secs /
      1e6
    ).toFixed(1)} Mbps(用来定设计文档 §10 U2)`,
  );

  await obs.disconnect();
  child.kill();
  console.log("\n产物目录(截图与录像都在,自己看完再删):", root);
}

main().catch((e) => {
  console.error("门测失败:", e);
  process.exit(1);
});
```

- [ ] **Step 2: 加 npm 脚本**

`packages/desktop/package.json` 的 `scripts` 加(与既有 `verify:vision` 同款):

```json
"recorder:gatecheck": "tsx scripts/obsGateCheck.ts"
```

- [ ] **Step 3: 在 mac 上确认能过 lint 并友好退出**

Run: `npx eslint packages/desktop/scripts/obsGateCheck.ts --quiet && (cd packages/desktop && npm run recorder:gatecheck)`
Expected: eslint 零告警;脚本打印"只能在 Windows 上跑"并 exit 2

> **不要**把 `npm run typecheck` 当这个文件的验收 —— `tsconfig.json` 的 `include` 是
> `["src","test","dev","qa"]`,**`scripts/` 不在里面**。

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/scripts/obsGateCheck.ts packages/desktop/package.json
git commit -m "chore(desktop): OBS 二期门测脚本 —— 下载/解压/无头启动/GPU/提权/钩子/采集/分片/码率/headroom 一次跑完"
```

- [ ] **Step 5: 交给用户跑,把输出贴回来**

**不是代码工作。** 产出是设计文档 §3 那五个确认项的真实答案,第 1 段的实施计划据此才能写。

---

## 全部完成后

- [ ] Run: `npm run presubmit`
      Expected: 全 workspace 绿。lint 覆盖 `scripts/`,新增的 `obsGateCheck.ts` 在范围内。

- [ ] **视觉基线**:Task 2 的 `onError` 提示与 Task 5 的主界面横幅都可能让 CI 视觉任务
      变红,**这是预期的**。在 CI 上重生成三档基线,**本机绝不跑 `test:visual`**。

- [ ] **§9.1 基线数字**:对本机 `<userData>/recordings/recordings.ndjson` 里现有的行,
      **用 `computeVideoWindow` 的 `headroomS`**(不要手算,那会再造一份谓词)逐条算出
      带符号 headroom,报中位数与分布。这是"修复要给前后数字"规矩里的**前**,
      二期收官时给对应的**后**。
