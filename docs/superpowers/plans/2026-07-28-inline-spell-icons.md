# AI Analysis Text Inline Icons (backlog #15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In zh reply mode, render English spell/spec names in the AI generated text (finding card 3 fields + comparison explanation) as "Icon + Chinese Name", revealing the English original name on hover; in en mode, only add the icon without changing the name. Storage/prompt/audit/export remain completely unchanged.

**Architecture:** Render-layer post-processing (spec Plan A). The analysis side adds a zhCN spell name generated artifact + a lazy inverted index of "English name → id (icon set only)"; the desktop side adds a pure function scanner `renderRichText` (first-word bucketed + longest match) replacing matched segments with `<SpellInline>`/`<SpecInline>`, at 6 integration points.

**Tech Stack:** TypeScript, React, vitest, wago.tools DB2 CSV (datagen), electron-vite.

**Spec:** `docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md`

## Global Constraints

- Commits: commit directly to main, do not create branches or PRs (project convention).
- Only pre-push gate: `npm run presubmit` (= lint + typecheck + full workspace test + verify:vision + electron-vite build). **Do not** just run the desktop triad.
- Never add pipes in the gate chain (`npm run typecheck | tail` returns the exit code of tail); never `cd` in compound commands (use absolute paths or a `(cd … && …)` subshell).
- Large generated data (>1MB) must use `.json` files (vite is configured with `json.stringify`), never `.ts` object literals (due to a past 22s first-paint incident).
- renderer/preload from `src/main/*` is restricted to type-only imports (not applicable to this plan, but don't accidentally violate it).
- Visual baselines are generated single-source in CI (linux), **never run `test:visual` locally**; see Task 8 for baseline update instructions.
- `npm run typecheck` must use tsc --noEmit, never `tsc -b`.
- Time unit convention: derive output / CandidateEvent.t = relative seconds (this plan does not add new time conversions).

**Pre-verified facts** (tested during planning phase, executor does not need to re-verify):
`https://wago.tools/db2/SpellName/csv?build=12.1.0.68629&locale=zhCN` returns a zhCN CSV, untranslated entries fallback to English in the same column (tested with curl, `ID,Name_lang` columns, `17,真言术:盾`).

---

### Task 1: datagen — zhCN 技能名生成物 + manifest 登记

**Files:**

- Modify: `packages/analysis/scripts/datagen/lib/wagoCsv.ts`(fetchTable 加 locale 参数)
- Create: `packages/analysis/scripts/datagen/genSpellNamesZh.ts`
- Create: `packages/analysis/test/datagen.spellNamesZh.test.ts`
- Modify: `packages/analysis/scripts/datagen/writeManifest.ts`
- Create(生成): `packages/analysis/src/data/spellNamesZhGenerated.json`
- Modify: `packages/analysis/src/data/datagen-manifest.json`(脚本生成)
- Modify: `docs/commands/update-wow-data.md`(步骤 2b 登记)

**Interfaces:**

- Consumes: `parseCsv/fetchLatestBuild/fetchTable/assertMinRows`(`lib/wagoCsv`)、`writeArtifact`(`lib/emit`)、`spellIconsGenerated.json` 的 `ids` 键集、`spellNames.json`(enUS 对照)。
- Produces: `spellNamesZhGenerated.json` = `Record<spellId, zh名>`,**仅含**「有图标 且 zh≠en(真翻译)」的条目;`transformSpellNamesZh(csvZh, iconIds, enMap)` 纯函数。

- [ ] **Step 1: 写失败的 transform 单测**

`packages/analysis/test/datagen.spellNamesZh.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { transformSpellNamesZh } from "../scripts/datagen/genSpellNamesZh";

describe("transformSpellNamesZh", () => {
  const csv =
    'ID,Name_lang\n740,宁静\n17,真言术:盾\n999,"Test Spell"\n25,昏迷\n';
  const iconIds = new Set(["740", "17", "999"]);
  const enMap: Record<string, string> = {
    "740": "Tranquility",
    "17": "Power Word: Shield",
    "999": "Test Spell",
    "25": "Stun",
  };

  test("仅收:有图标 且 zh 与 en 不同(真翻译)", () => {
    expect(transformSpellNamesZh(csv, iconIds, enMap)).toEqual({
      "740": "宁静",
      "17": "真言术:盾",
    });
    // 999:zh==en(wago 未翻译回落)→ 丢弃,运行时兜底链本来就落英文;
    // 25:无图标 → 丢弃(倒排索引也只收图标集,存了也没人查)。
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/analysis/test/datagen.spellNamesZh.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: fetchTable 加 locale + 写生成脚本**

`lib/wagoCsv.ts` 的 `fetchTable` 改为(缓存键必须带 locale,否则与 enUS 缓存互撞):

```ts
export async function fetchTable(
  table: string,
  build: string,
  cacheDir?: string,
  locale?: string,
): Promise<string> {
  let cacheFile: string | undefined;
  const cacheKey = locale ? `${table}-${locale}-${build}.csv` : `${table}-${build}.csv`;
  if (cacheDir) {
    cacheFile = path.join(cacheDir, cacheKey);
    if (fs.existsSync(cacheFile)) {
      return fs.readFileSync(cacheFile, "utf8");
    }
  }

  const url =
    `https://wago.tools/db2/${table}/csv?build=${encodeURIComponent(build)}` +
    (locale ? `&locale=${encodeURIComponent(locale)}` : "");
  // …函数其余部分(fetch/写缓存)保持原样,仅 url/cacheFile 来源变化。
```

`genSpellNamesZh.ts`(结构照抄 `genSpellNames.ts`):

```ts
import { readFileSync } from "fs";
import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertMinRows,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

/** zhCN 技能名表:仅收「有图标 且 与 enUS 名不同」的条目。
 * wago 未翻译条目同列回落英文 → 与 enMap 相等即未翻译,丢弃(运行时
 * 兜底链 本场日志名 > 本表 > 英文原样,缺项天然落英文)。 */
export function transformSpellNamesZh(
  csvText: string,
  iconIds: ReadonlySet<string>,
  enMap: Record<string, string>,
): Record<string, string> {
  const { rows } = parseCsv(csvText);
  const map: Record<string, string> = {};
  for (const row of rows) {
    const id = row.ID;
    const zh = row.Name_lang;
    if (!iconIds.has(id)) continue;
    if (!zh || zh === enMap[id]) continue;
    map[id] = zh;
  }
  return map;
}

export async function main(): Promise<void> {
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;
  const icons = JSON.parse(
    readFileSync(dataDir + "spellIconsGenerated.json", "utf8"),
  ) as { ids: Record<string, number> };
  const enMap = JSON.parse(
    readFileSync(dataDir + "spellNames.json", "utf8"),
  ) as Record<string, string>;

  const build = await fetchLatestBuild();
  const csv = await fetchTable(
    "SpellName",
    build,
    process.env.DATAGEN_CACHE,
    "zhCN",
  );
  const map = transformSpellNamesZh(
    csv,
    new Set(Object.keys(icons.ids)),
    enMap,
  );
  // 图标集 4.2 万,绝大多数玩家技能有真翻译;跌破 1 万说明 locale 参数
  // 或过滤逻辑坏了,宁可红。
  assertMinRows(Object.keys(map), 10000, "SpellName(zhCN)");
  writeArtifact(dataDir + "spellNamesZhGenerated.json", JSON.stringify(map));
  console.log(Object.keys(map).length, build);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genSpellNamesZh.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/analysis/test/datagen.spellNamesZh.test.ts`
Expected: PASS。

- [ ] **Step 5: 真跑生成物 + manifest**

```bash
export DATAGEN_CACHE=$(mktemp -d)
npx tsx packages/analysis/scripts/datagen/genSpellNamesZh.ts
```

Expected: stdout 打条目数(1 万–4 万区间)+ build 号;`ls -la packages/analysis/src/data/spellNamesZhGenerated.json` 体积应在几百 KB–1.5MB。

`writeManifest.ts` 的 `artifacts` 里加(照 spellNames.json 条目样式):

```ts
"spellNamesZhGenerated.json": {
  entries: Object.keys(readJson("spellNamesZhGenerated.json")).length,
  bytes: statSync(dataDir + "spellNamesZhGenerated.json").size,
},
```

然后 `npx tsx packages/analysis/scripts/datagen/writeManifest.ts`,`git diff` 确认 manifest 新增该项、build 不变。

`docs/commands/update-wow-data.md` 步骤 4 的 `# 2. 法术名` 之后加一行:

```bash
# 2b. 法术名 zhCN(内联图标显示名;依赖 6b 的图标表已存在 —— 全量刷新时把本步挪到 6b 之后)
npx tsx packages/analysis/scripts/datagen/genSpellNamesZh.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/scripts/datagen packages/analysis/test/datagen.spellNamesZh.test.ts packages/analysis/src/data/spellNamesZhGenerated.json packages/analysis/src/data/datagen-manifest.json docs/commands/update-wow-data.md
git commit -m "feat(analysis): zhCN 技能名生成物(仅图标集∩真翻译,#15 数据层)"
```

---

### Task 2: analysis — zh 表/observed 集/英文名倒排索引的运行时模块

**Files:**

- Modify: `packages/analysis/src/data/spellEffectData.ts`(加载完成探针 + 快照 getter)
- Create: `packages/analysis/src/data/spellNamesZh.ts`
- Create: `packages/analysis/src/data/observedSpellIds.ts`
- Create: `packages/analysis/src/data/spellNameLookup.ts`
- Modify: `packages/analysis/src/index.ts`(导出)
- Create: `packages/analysis/test/spellNameLookup.test.ts`

**Interfaces:**

- Consumes: `spellNamesZhGenerated.json`(Task 1)、`SPELL_ICONS_GENERATED`、`ensureSpellNames`。
- Produces(index.ts 导出,Task 5 消费):
  - `SPELL_NAMES_ZH_GENERATED: Record<string, string>`
  - `OBSERVED_SPELL_IDS: ReadonlySet<string>`
  - `englishNameIndex(): ReadonlyMap<string, readonly string[]> | null`(英文名→候选 id 升序,仅图标集;spellNames 未载完返回 null,UI 下次渲染自愈——ensure 契约的展示路径条款)

- [ ] **Step 1: 写失败的单测**

`packages/analysis/test/spellNameLookup.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { ensureSpellNames } from "../src/data/spellEffectData";
import { englishNameIndex } from "../src/data/spellNameLookup";
import { SPELL_NAMES_ZH_GENERATED } from "../src/data/spellNamesZh";
import { OBSERVED_SPELL_IDS } from "../src/data/observedSpellIds";

describe("spellNameLookup", () => {
  test("英文名倒排:载入后可查,仅图标集,id 升序", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(idx).not.toBeNull();
    // 740 宁静:有图标、名字稳定
    expect(idx!.get("Tranquility")).toContain("740");
    // id 1 "Word of Recall (OLD)" 在 spellNames 里但不在图标集 → 不入索引
    expect(idx!.get("Word of Recall (OLD)")).toBeUndefined();
    for (const ids of idx!.values()) {
      const nums = ids.map(Number);
      expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    }
  });

  test("zh 表与 observed 集装载", () => {
    expect(SPELL_NAMES_ZH_GENERATED["740"]).toBe("宁静");
    expect(OBSERVED_SPELL_IDS.has("17")).toBe(true); // 真言术:盾,语料必有
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/analysis/test/spellNameLookup.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现四个模块改动**

`spellEffectData.ts`:`spellNamesLoad` 的 `.then` 里置位一个模块级 `let spellNamesLoaded = false;`,并导出:

```ts
let spellNamesLoaded = false;
const spellNamesLoad = import("./spellNames.json").then((m) => {
  spellNamesMap = (m.default ?? m) as unknown as Record<string, string>;
  spellNamesLoaded = true;
});

/** spellNames 是否已后台载完(spellNameLookup 建索引的门;别用
 * Object.keys 判空——41 万键每次数一遍)。 */
export const spellNamesReady = (): boolean => spellNamesLoaded;
export function getSpellNamesSnapshot(): Record<string, string> {
  return spellNamesMap;
}
```

`spellNamesZh.ts`(静态 import:~1MB 经 vite json.stringify 是几 ms 的 JSON.parse,不走 12MB 表那套后台加载;firstPaint 预算门在 CI 兜底):

```ts
import raw from "./spellNamesZhGenerated.json";

/** zhCN 技能名(datagen 产物,仅图标集∩真翻译)。缺项 = 未翻译或无图标,
 * 消费方兜底链:本场日志名 > 本表 > 英文原样。 */
export const SPELL_NAMES_ZH_GENERATED = raw as unknown as Record<
  string,
  string
>;
```

`observedSpellIds.ts`(23KB,静态 import 无压力):

```ts
import raw from "./observedSpellIdsGenerated.json";

/** 语料观测过的 spellId(字符串,与全仓 id 口径一致)。 */
export const OBSERVED_SPELL_IDS: ReadonlySet<string> = new Set(
  (raw as unknown as number[]).map(String),
);
```

`spellNameLookup.ts`:

```ts
import { SPELL_ICONS_GENERATED } from "./spellIconsGenerated";
import { getSpellNamesSnapshot, spellNamesReady } from "./spellEffectData";

let index: ReadonlyMap<string, readonly string[]> | null = null;

/** 英文技能名 → 候选 id 列表(升序)。仅收有图标的 id(图标集=观测∪
 * SpellCooldowns∪候选,已是"值得显示"的宇宙)。spellNames 12MB 表未载完
 * 时返回 null —— 展示路径可降级(ensure 契约),下次渲染自愈。 */
export function englishNameIndex(): ReadonlyMap<
  string,
  readonly string[]
> | null {
  if (index) return index;
  if (!spellNamesReady()) return null;
  const names = getSpellNamesSnapshot();
  const m = new Map<string, string[]>();
  for (const id in SPELL_ICONS_GENERATED) {
    const n = names[id];
    if (!n) continue;
    const arr = m.get(n);
    if (arr) arr.push(id);
    else m.set(n, [id]);
  }
  for (const arr of m.values()) arr.sort((a, b) => Number(a) - Number(b));
  index = m;
  return index;
}
```

`index.ts` 加导出(放在既有 `getEnglishSpellName` 导出附近):

```ts
export { SPELL_NAMES_ZH_GENERATED } from "./data/spellNamesZh";
export { OBSERVED_SPELL_IDS } from "./data/observedSpellIds";
export { englishNameIndex } from "./data/spellNameLookup";
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/analysis/test/spellNameLookup.test.ts`
Expected: PASS。再跑 `npx vitest run --dir packages/analysis` 确认没碰坏别的(尤其 spellEffectData 消费方)。

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src packages/analysis/test/spellNameLookup.test.ts
git commit -m "feat(analysis): 英文名倒排索引(图标集)+ zh 表/observed 集运行时导出(#15)"
```

---

### Task 3: desktop — 专精名共享表(SPEC_NAMES_ZH 上浮 + 英文短语→specId)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/data/specNames.ts`
- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx`(删本地表,改 import)
- Create: `packages/desktop/src/renderer/src/report/data/specNames.test.ts`

**Interfaces:**

- Consumes: `SPEC_SLUGS`(`report/data/gameConstants.ts`,specId→slug)。
- Produces:
  - `SPEC_NAMES_ZH: Record<string, string>`(41 条,"Restoration Druid"→"恢复德鲁伊";内容=原 ProComparisonVerified 表原样搬家)
  - `SPEC_ID_BY_EN: Record<string, number>`("Restoration Druid"→105;键集与 SPEC_NAMES_ZH 完全一致)

- [ ] **Step 1: 写失败的一致性单测**

`specNames.test.ts`(防两表漂移+防 slug 断链,这是本任务唯一值得测的东西):

```ts
import { describe, expect, test } from "vitest";
import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "./specNames";
import { SPEC_SLUGS } from "./gameConstants";

describe("specNames 一致性", () => {
  test("两表键集一致,specId 全部有图标 slug", () => {
    expect(Object.keys(SPEC_ID_BY_EN).sort()).toEqual(
      Object.keys(SPEC_NAMES_ZH).sort(),
    );
    for (const [en, id] of Object.entries(SPEC_ID_BY_EN)) {
      expect(SPEC_SLUGS[id], `${en} → ${id}`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/data/specNames.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 建共享表 + 换 import**

`specNames.ts`:把 `ProComparisonVerified.tsx` 第 48–89 行的 `SPEC_NAMES_ZH` **原样搬入**(41 条,一条不改),再补 `SPEC_ID_BY_EN` —— specId 以 `gameConstants.ts` 的 `SPEC_SLUGS` 为准逐条对照(slug 形如 `druid_restoration`,与英文短语一一对应;DH 的 Devourer=1480、Evoker 三系=1467/1468/1473 之类全在 SPEC_SLUGS 里):

```ts
/** 英文专精短语 → specId(SPEC_SLUGS 键)。与 SPEC_NAMES_ZH 键集必须一致
 * (specNames.test 防漂移)。 */
export const SPEC_ID_BY_EN: Record<string, number> = {
  "Blood Death Knight": 250,
  "Frost Death Knight": 251,
  "Unholy Death Knight": 252,
  // …其余 38 条:对照 SPEC_SLUGS 逐条填(druid 102/103/104/105、
  // hunter 253/254/255、mage 62/63/64、monk 268/269/270、paladin 65/66/70、
  // priest 256/257/258、rogue 259/260/261、shaman 262/263/264、
  // warlock 265/266/267、warrior 71/72/73、DH 577/581/1480、
  // evoker 1467/1468/1473)——执行时打开 gameConstants.ts 核对每一个数字,
  // 测试的 SPEC_SLUGS 断言会抓填错的。
};
```

`ProComparisonVerified.tsx`:删除本地 `SPEC_NAMES_ZH` 常量,顶部加
`import { SPEC_NAMES_ZH } from "../data/specNames";`,`specZh` 函数保持不动。

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/data/specNames.test.ts && npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: 双 PASS(后者证明搬家没碰坏消费方)。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/data packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx
git commit -m "refactor(desktop): SPEC_NAMES_ZH 上浮共享表 + 英文短语→specId(#15)"
```

---

### Task 4: desktop — SpellInline/SpecInline 组件 + ChipIcon 上浮 + CSS

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/SpellInline.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx`(删本地 ChipIcon,改 import)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Create: `packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx`

**Interfaces:**

- Consumes: `SpellIcon`(IPC+磁盘缓存)、`SPELL_ICONS_GENERATED`、`specIconUrl`(`report/data/gameConstants`)。
- Produces(Task 5/6 消费):
  - `SpellInline({ spellId, display, original }: { spellId: string; display: string; original: string })` — 图标(有表项才渲)+ display 文本,`title=original`(对账锚点)。
  - `SpecInline({ specId, display, original }: { specId: number; display: string; original: string })` — 专精图标(CDN,`specIconUrl`)+ display。
  - `ChipIcon({ spellId }: { spellId?: string })` — 语义原样从 FindingsList 搬出(含空 label 防兜底字符重复的注释,一字不改)。

- [ ] **Step 1: 写失败的组件测试**

`SpellInline.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SpecInline, SpellInline } from "./SpellInline";

describe("SpellInline", () => {
  test("title=英文原名,正文=display,有图标条目渲染图标占位", () => {
    // 740 Tranquility 在 SPELL_ICONS_GENERATED(泳道在用)
    const { container } = render(
      <SpellInline spellId="740" display="宁静" original="Tranquility" />,
    );
    const el = container.querySelector(".rpt-inline-spell")!;
    expect(el.getAttribute("title")).toBe("Tranquility");
    expect(el.textContent).toContain("宁静");
    // bridge 桩缺席 → SpellIcon 走 fallback 占位(空 label → 空字符),
    // 断言占位节点存在即可(真图走 IPC,测试环境不取)。
    expect(container.querySelector(".rpt-spellicon-fallback")).not.toBeNull();
  });

  test("无图标条目:只出文本,不渲染图标节点", () => {
    const { container } = render(
      <SpellInline
        spellId="1"
        display="召回"
        original="Word of Recall (OLD)"
      />,
    );
    expect(container.querySelector(".rpt-spellicon-fallback")).toBeNull();
    expect(container.textContent).toBe("召回");
  });

  test("SpecInline 渲染专精图标 img + display", () => {
    const { container } = render(
      <SpecInline
        specId={105}
        display="恢复德鲁伊"
        original="Restoration Druid"
      />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("druid_restoration");
    expect(container.textContent).toContain("恢复德鲁伊");
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现组件 + 搬 ChipIcon + CSS**

`SpellInline.tsx`:

```tsx
import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import { specIconUrl } from "../data/gameConstants";
import { SpellIcon } from "./SpellIcon";

/** AI 正文内联技能:图标(有表项才渲)+ 显示名;title=英文原名 ——
 * 替换纯展示,审计/导出用的存储文本不动,hover 即可对账。 */
export function SpellInline({
  spellId,
  display,
  original,
}: {
  spellId: string;
  display: string;
  original: string;
}) {
  const icon = SPELL_ICONS_GENERATED[spellId];
  return (
    <span className="rpt-inline-spell" title={original}>
      {icon ? <SpellIcon icon={icon} label="" size={14} /> : null}
      {display}
    </span>
  );
}

/** AI 正文内联专精:CDN 图标(specIconUrl,竞技场小地图同先例;视觉测试
 * 由 stubExternal 打桩)+ 显示名。 */
export function SpecInline({
  specId,
  display,
  original,
}: {
  specId: number;
  display: string;
  original: string;
}) {
  const url = specIconUrl(specId);
  return (
    <span className="rpt-inline-spell" title={original}>
      {url ? (
        <img
          src={url}
          alt=""
          width={14}
          height={14}
          className="rpt-inline-spec-img"
        />
      ) : null}
      {display}
    </span>
  );
}

// ChipIcon:从 FindingsList.tsx 原样搬入(含「传空 label 是刻意的」整段
// 注释,一字不改),FindingsList 与 KeyMomentAxis 都从这里 import。
export function ChipIcon({ spellId }: { spellId?: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  if (!icon) return null;
  return <SpellIcon icon={icon} label="" size={14} />;
}
```

(执行时把 FindingsList 里 ChipIcon 的原注释块一并搬来替换上面的占位注释;
FindingsList 删本地定义,改 `import { ChipIcon } from "./SpellInline";`。)

`styles.css` 追加:

```css
/* AI 正文内联技能/专精(#15):图标与文字基线对齐,不撑行高 */
.rpt-inline-spell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  vertical-align: -2px;
}
.rpt-inline-spell .rpt-spellicon,
.rpt-inline-spell .rpt-inline-spec-img {
  border-radius: 2px;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx && npx vitest run packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`
Expected: 双 PASS(后者证 ChipIcon 搬家无损)。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components packages/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): SpellInline/SpecInline 内联组件 + ChipIcon 上浮(#15)"
```

---

### Task 5: desktop — inlineRich 扫描器(纯函数,可注入依赖)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/inlineRich.tsx`
- Create: `packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`

**Interfaces:**

- Consumes: `englishNameIndex/OBSERVED_SPELL_IDS/SPELL_NAMES_ZH_GENERATED`(Task 2)、`SPEC_ID_BY_EN/SPEC_NAMES_ZH`(Task 3)、`SpellInline/SpecInline`(Task 4)、`ReportSource`(`derive/types`)。
- Produces(Task 6/7 消费):
  - `makeRichText(source: ReportSource, lang: "zh" | "en", deps?: RichDeps): (text?: string | null) => ReactNode`
  - `buildMatchSpellIndex(source: ReportSource): { ids: ReadonlySet<string>; logNames: ReadonlyMap<string, string> }`
  - `RichDeps`(测试注入用:`{ nameIndex, zhNames, observed, specByName, specZh }`)

- [ ] **Step 1: 写失败的单测**

`inlineRich.test.tsx`(全部走注入依赖,不碰 12MB 真表;fixture 教训:数组可缺,`?? []` 防御由 buildMatchSpellIndex 用例覆盖):

```tsx
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ReportSource } from "./types";
import {
  buildMatchSpellIndex,
  makeRichText,
  type RichDeps,
} from "./inlineRich";

const deps: RichDeps = {
  nameIndex: new Map<string, readonly string[]>([
    ["Tranquility", ["740"]],
    ["Ice Block", ["45438"]],
    ["Block", ["107"]],
    ["Power Word: Shield", ["17"]],
    ["Chaos Bolt", ["116858", "999116"]],
  ]),
  zhNames: { "740": "宁静", "45438": "寒冰屏障", "17": "真言术:盾" },
  observed: new Set(["116858"]),
  specByName: { "Restoration Druid": 105 },
  specZh: { "Restoration Druid": "恢复德鲁伊" },
};
const emptySource = { units: {} } as unknown as ReportSource;
const rich = makeRichText(emptySource, "zh", deps);

const textOf = (node: React.ReactNode): string =>
  render(<span>{node}</span>).container.textContent ?? "";

describe("renderRichText(经 makeRichText)", () => {
  test("CJK 邻接命中:英文名换成中文名", () => {
    expect(textOf(rich("你的Tranquility没用"))).toBe("你的宁静没用");
  });

  test("最长匹配:Ice Block 不被 Block 截胡", () => {
    const { container } = render(<span>{rich("Cast Ice Block now")}</span>);
    expect(container.textContent).toContain("寒冰屏障");
    expect(container.textContent).not.toContain("Block"); // 整段无残留英文
  });

  test("多词带冒号名整体命中", () => {
    expect(textOf(rich("Power Word: Shield absorbed"))).toContain("真言术:盾");
  });

  test("词内不命中(boundary):Blockade 不触发 Block", () => {
    expect(textOf(rich("The Blockade held"))).toBe("The Blockade held");
  });

  test("歧义消解:本场 id 优先于 observed", () => {
    const src = {
      units: {
        a: { casts: [{ spellId: 999116, spellName: "混沌之箭" }] },
      },
    } as unknown as ReportSource;
    const r = makeRichText(src, "zh", deps);
    // 999116 在本场且日志名中文 → display 走本场日志名
    expect(textOf(r("Chaos Bolt hit"))).toContain("混沌之箭");
  });

  test("歧义消解:本场没有 → observed(116858),再没有 → 最小 id", () => {
    // 本场空,observed 只有 116858 → 选 116858;zh 词典无该 id → 英文原样兜底
    expect(textOf(rich("Chaos Bolt hit"))).toContain("Chaos Bolt");
  });

  test("en 模式:不换名(图标由组件负责,文本原样)", () => {
    const r = makeRichText(emptySource, "en", deps);
    expect(textOf(r("Tranquility was available"))).toBe(
      "Tranquility was available",
    );
  });

  test("专精短语:zh 换名", () => {
    expect(textOf(rich("Restoration Druid died"))).toContain("恢复德鲁伊");
  });

  test("无命中原样返回同一字符串(=== 短路,不拆节点)", () => {
    const t = "没有任何英文技能名";
    expect(rich(t)).toBe(t);
  });

  test("nameIndex 未就绪(null)→ 全文原样", () => {
    const r = makeRichText(emptySource, "zh", { ...deps, nameIndex: null });
    expect(r("Tranquility")).toBe("Tranquility");
  });

  test("空/undefined 输入透传", () => {
    expect(rich(undefined)).toBeNull();
    expect(rich("")).toBe("");
  });
});

describe("buildMatchSpellIndex", () => {
  test("五类事件数组全防御缺失(fixture 剥数组不抛)", () => {
    const src = {
      units: {
        a: { casts: [{ spellId: 740, spellName: "宁静" }] },
        b: {}, // 无任何事件数组
      },
    } as unknown as ReportSource;
    const idx = buildMatchSpellIndex(src);
    expect(idx.ids.has("740")).toBe(true);
    expect(idx.logNames.get("740")).toBe("宁静");
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现扫描器**

`inlineRich.tsx`(算法:首词分桶 + 桶内按名长降序尝试 `startsWith` + 后界非 ASCII 字母;41k 名字的巨型交替 regex 编译成本不可控,已否决):

```tsx
import type { ReactNode } from "react";

import {
  OBSERVED_SPELL_IDS,
  SPELL_NAMES_ZH_GENERATED,
  englishNameIndex,
} from "@gladlog/analysis";

import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "../data/specNames";
import { SpecInline, SpellInline } from "../components/SpellInline";
import type { ReportSource } from "./types";

export interface RichDeps {
  /** 英文技能名→候选 id(升序);null=12MB 表未载完,整段降级原样。 */
  nameIndex: ReadonlyMap<string, readonly string[]> | null;
  zhNames: Record<string, string>;
  observed: ReadonlySet<string>;
  specByName: Record<string, number>;
  specZh: Record<string, string>;
}

const defaultDeps = (): RichDeps => ({
  nameIndex: englishNameIndex(),
  zhNames: SPELL_NAMES_ZH_GENERATED,
  observed: OBSERVED_SPELL_IDS,
  specByName: SPEC_ID_BY_EN,
  specZh: SPEC_NAMES_ZH,
});

type Entry =
  | { name: string; kind: "spell"; ids: readonly string[] }
  | { name: string; kind: "spec"; specId: number };

const ASCII = /[A-Za-z]/;
const firstToken = (s: string): string => /^[A-Za-z']+/.exec(s)?.[0] ?? "";

/** 首词→候选条目(桶内名长降序=最长匹配优先)。索引是 analysis 侧单例,
 * 以其身份缓存整张桶表(每次 makeRichText 重建 41k 桶不划算)。 */
let bucketCache: {
  idx: RichDeps["nameIndex"];
  map: Map<string, Entry[]>;
} | null = null;
function entryBuckets(deps: RichDeps): Map<string, Entry[]> | null {
  if (!deps.nameIndex) return null;
  if (bucketCache && bucketCache.idx === deps.nameIndex) return bucketCache.map;
  const m = new Map<string, Entry[]>();
  const add = (e: Entry) => {
    const k = firstToken(e.name);
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  };
  for (const [name, ids] of deps.nameIndex) add({ name, kind: "spell", ids });
  for (const [name, specId] of Object.entries(deps.specByName))
    add({ name, kind: "spec", specId });
  for (const arr of m.values())
    arr.sort((a, b) => b.name.length - a.name.length);
  bucketCache = { idx: deps.nameIndex, map: m };
  return m;
}

export interface MatchSpellIndex {
  ids: ReadonlySet<string>;
  logNames: ReadonlyMap<string, string>;
}

/** 本场 spellId→日志名(CN 日志=中文名)。五类事件数组全 ?? []:
 * 裁剪 fixture 会剥数组(toLegacySafe 同款教训),缺面绝不能抛。 */
export function buildMatchSpellIndex(source: ReportSource): MatchSpellIndex {
  const ids = new Set<string>();
  const logNames = new Map<string, string>();
  type Ev = { spellId?: number | string; spellName?: string };
  type UnitLike = Partial<
    Record<"casts" | "petCasts" | "damageOut" | "healOut" | "auraEvents", Ev[]>
  >;
  const eat = (evs?: Ev[]) => {
    for (const e of evs ?? []) {
      if (e.spellId == null) continue;
      const id = String(e.spellId);
      ids.add(id);
      if (e.spellName && !logNames.has(id)) logNames.set(id, e.spellName);
    }
  };
  for (const u of Object.values(source.units ?? {}) as UnitLike[]) {
    eat(u.casts);
    eat(u.petCasts);
    eat(u.damageOut);
    eat(u.healOut);
    eat(u.auraEvents);
  }
  return { ids, logNames };
}

interface Ctx {
  match: MatchSpellIndex;
  lang: "zh" | "en";
  deps: RichDeps;
}

function renderEntry(
  e: Entry,
  original: string,
  ctx: Ctx,
  key: number,
): ReactNode {
  if (e.kind === "spec") {
    const display =
      ctx.lang === "zh" ? (ctx.deps.specZh[e.name] ?? original) : original;
    return (
      <SpecInline
        key={key}
        specId={e.specId}
        display={display}
        original={original}
      />
    );
  }
  const id =
    e.ids.find((x) => ctx.match.ids.has(x)) ??
    e.ids.find((x) => ctx.deps.observed.has(x)) ??
    e.ids[0]!;
  const display =
    ctx.lang === "zh"
      ? (ctx.match.logNames.get(id) ?? ctx.deps.zhNames[id] ?? original)
      : original;
  return (
    <SpellInline key={key} spellId={id} display={display} original={original} />
  );
}

function renderRichText(text: string, ctx: Ctx): ReactNode {
  const buckets = entryBuckets(ctx.deps);
  if (!buckets) return text;
  const out: ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  let key = 0;
  while (i < text.length) {
    // 只在 ASCII 单词起点尝试(前一字符不是 ASCII 字母;CJK 邻接天然是起点)
    if (!ASCII.test(text[i]!) || (i > 0 && ASCII.test(text[i - 1]!))) {
      i++;
      continue;
    }
    const token = firstToken(text.slice(i, i + 48));
    let hit: Entry | null = null;
    for (const e of buckets.get(token) ?? []) {
      if (!text.startsWith(e.name, i)) continue;
      const after = text[i + e.name.length];
      if (after === undefined || !ASCII.test(after)) {
        hit = e;
        break; // 桶内名长降序 → 首个命中即最长
      }
    }
    if (!hit) {
      i += token.length || 1;
      continue;
    }
    if (plainStart < i) out.push(text.slice(plainStart, i));
    out.push(renderEntry(hit, text.slice(i, i + hit.name.length), ctx, key++));
    i += hit.name.length;
    plainStart = i;
  }
  if (out.length === 0) return text; // 无命中:原字符串直返(=== 短路)
  if (plainStart < text.length) out.push(text.slice(plainStart));
  return out;
}

/** 每场/每语言构建一次(接入点 useMemo),返回的渲染函数按段调用。 */
export function makeRichText(
  source: ReportSource,
  lang: "zh" | "en",
  deps: RichDeps = defaultDeps(),
): (text?: string | null) => ReactNode {
  const match = buildMatchSpellIndex(source);
  return (text) =>
    text ? renderRichText(text, { match, lang, deps }) : (text ?? null);
}
```

注意 `firstToken` 用 `'`(撇号)入词:"Death's Advance" 的桶键是 `Death's`;
文本 token 同规则切,两边一致即可命中。

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/derive/inlineRich.tsx packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx
git commit -m "feat(desktop): inlineRich 富文本扫描器(首词分桶+最长匹配,#15 核心)"
```

---

### Task 6: 接线 — FindingsList / KeyMomentAxis / StructuredAnalysisPanel(含 chips 补图标)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`

**Interfaces:**

- Consumes: `makeRichText`(Task 5)、`ChipIcon`(Task 4)。
- Produces: `FindingsList`/`KeyMomentAxis` 新增可选 prop `rich?: (text?: string | null) => ReactNode`(缺省 = 现状纯文本,老调用点零破坏)。

- [ ] **Step 1: 写失败的组件测试**

`FindingsList.test.tsx` 追加用例(沿用该文件既有的 findings fixture 构造方式):

```tsx
test("rich prop:explanation 里的技能名渲染为 SpellInline(title=英文)", () => {
  const deps: RichDeps = {
    nameIndex: new Map([["Tranquility", ["740"] as readonly string[]]]),
    zhNames: { "740": "宁静" },
    observed: new Set<string>(),
    specByName: {},
    specZh: {},
  };
  const rich = makeRichText(
    { units: {} } as unknown as ReportSource,
    "zh",
    deps,
  );
  const { container } = render(
    <FindingsList
      findings={[
        {
          eventIds: [],
          severity: "high",
          category: "cooldown-usage",
          title: "Tranquility 未使用",
          explanation: "整场 Tranquility 一次没按。",
        },
      ]}
      onSelect={() => {}}
      rich={rich}
    />,
  );
  const inline = container.querySelectorAll('[title="Tranquility"]');
  expect(inline.length).toBe(2); // title + explanation 各一处
  expect(container.textContent).toContain("宁静");
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`
Expected: 新用例 FAIL(无 rich prop)。

- [ ] **Step 3: 三组件接线**

`FindingsList.tsx`:

- props 加 `rich?: (text?: string | null) => ReactNode;`(注释:`/** AI 正文富渲染(#15 内联图标);缺省纯文本。 */`)。
- 三处文本包裹:`{rich ? rich(f.title) : f.title}`、`{rich ? rich(f.explanation) : f.explanation}`、`{rich ? rich(f.deepDive.text) : f.deepDive.text}`。
- (ChipIcon 已在 Task 4 改为 import,此处无事。)

`KeyMomentAxis.tsx`:

- 同样加 `rich` prop,同样包裹 `e.f.title` / `e.f.explanation` / `e.f.deepDive.text` 三处。
- 深挖 chips 按钮内加 `<ChipIcon spellId={c.spellId} />`(import 自 `./SpellInline`),对齐 FindingsList 的 chip 结构:`<ChipIcon spellId={c.spellId} />⏱ {mmss(c.t)} {c.label}`。

`StructuredAnalysisPanel.tsx`:

- import `makeRichText`;组件体内(`lang` state 已存在,`dataReady` 门已存在):

```tsx
// #15 内联图标:每场/每语言构建一次;dataReady 翻真后重建(索引从 null
// 变可用,展示路径自愈——ensure 契约)。
const rich = useMemo(
  () => makeRichText(source, lang ?? "zh"),
  [source, lang, dataReady],
);
```

- 四个渲染点(两个 `<KeyMomentAxis …>`、两个 `<FindingsList …>`)都传 `rich={rich}`。

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/`
Expected: 全 PASS(含 MatchReport.initialView 等既有用例,证 prop 可选性没破坏老调用)。

- [ ] **Step 5: 真眼验收(run-ui 试验台)**

用 run-ui skill 起 dev:ui,打开带 findings 的样例,确认:zh 下英文技能名显示为图标+中文名、hover 出英文;时间轴卡与列表卡一致;chips 有图标。截图留档。

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components
git commit -m "feat(desktop): finding 卡三字段接入内联图标,KeyMomentAxis chips 补图标(#15)"
```

---

### Task 7: 接线 — ProComparisonVerified 对比解说

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`

**Interfaces:**

- Consumes: `makeRichText`(Task 5;该组件已有 `source: ReportSource` prop 与 `lang`)。

- [ ] **Step 1: 写失败的测试**

`ProComparisonVerified.test.tsx` 追加(沿用该文件既有的 result 注入方式;若其测试经 fixtureBridge 灌 result,则在灌入的 `report` 文本里放 "Tranquility" 并断言渲染后出现 `title="Tranquility"` 的节点)。注入 deps 不可行时(组件内部 `makeRichText` 用默认 deps,走真索引),测试改为:`await ensureAnalysisData()` 后渲染,断言 `container.querySelector('[title="Tranquility"]')` 非空——真索引里 740 必然存在,行为稳定。

```tsx
test("对比解说富渲染:英文技能名出内联节点", async () => {
  await ensureAnalysisData(); // 12MB 表载完,englishNameIndex 可用
  // …按本文件既有模式渲染出带 report 文本 "use Tranquility earlier" 的状态…
  expect(container.querySelector('[title="Tranquility"]')).not.toBeNull();
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

```tsx
import { makeRichText } from "../derive/inlineRich";
// 组件体内:
const rich = useMemo(() => makeRichText(source, lang), [source, lang]);
```

`result.report` 渲染处改为 `<p style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rich(result.report)}</p>`(换行由 pre-wrap 保留,rich 输出的字符串片段不动换行符)。

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components
git commit -m "feat(desktop): 对比解说接入内联图标(#15 收尾)"
```

---

### Task 8: 门禁、push、CI、视觉基线、backlog 收账

**Files:**

- Modify: `docs/BACKLOG.md`(#15 标题行加 ✅ 与落地记录)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png`(CI 生成,人审后覆盖)

- [ ] **Step 1: 全量门禁**

```bash
npm run presubmit
```

Expected: 全绿。红了修到绿,**不许跳过任何一步**(typecheck 红最可能在 CI 才含的 test 文件;lint 是全仓口径)。

- [ ] **Step 2: backlog 收账 + push**

`docs/BACKLOG.md` #15 标题行改为:
`## 15. AI 分析文本内联图标(技能/职业名 → 图标+中文名)✅(2026-07-28 落地:渲染层后处理 inlineRich + zhCN 词典生成物;spec docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md)`

```bash
git add docs/BACKLOG.md
git commit -m "docs: backlog #15 收账"
git push
```

- [ ] **Step 3: 盯 CI(按 headSha 选 run,不抓 latest)**

```bash
SHA=$(git rev-parse HEAD)
RUN=$(gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
gh run watch "$RUN" --exit-status
```

Expected: test job 绿;frontend-qa job 若因视觉基线红 → 预期内,走 Step 4。

- [ ] **Step 4: 视觉基线重生成(仅当 report 场景像素变了;CI 单源)**

```bash
gh workflow run visual-baseline.yml --ref main
# 轮询完成(gh run watch 会提前退出,不可靠 —— 循环查 status)
RUN=$(gh run list --workflow visual-baseline.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run download $RUN -n visual-baselines -D /tmp/bl
for f in /tmp/bl/scenes.spec.ts/*.png; do n=$(basename $f); cmp -s "$f" packages/desktop/qa/__screenshots__/scenes.spec.ts/$n || echo "DIFF $n"; done
```

DIFF 的每一张逐张 Read 人审 —— 变化必须能用本次改动解释(finding 卡/时间轴卡/对比区出现图标与中文名;**其他区域不许动**)。审过后 `cp` 覆盖、commit、push,回 Step 3 盯到全绿。

- [ ] **Step 5: 汇报验收数字**

按验证规则给前后对照:同一 fixture 场景,改前 finding 正文英文技能名 N 处 0 替换,改后 N 处中 M 处渲染为内联节点(M/N 与词典覆盖一致),含截图。

---

## Self-Review 记录(计划定稿前跑过)

1. **Spec 覆盖**:数据层(Task 1/2)、倒排+消解(2/5)、SPEC 上浮(3)、组件(4)、扫描器+en 模式+兜底链(5)、六接入点+chips(6/7)、视觉基线/presubmit/收账(8)。wago zhCN ⚠ 已在计划期实测通过,写进 Global Constraints。停用词表按 spec 属「真误伤再加」,无任务,合规。
2. **占位符**:Task 3 的 38 条 specId 留了「对照 SPEC_SLUGS 逐条填」——这不是 TBD:数字以 gameConstants.ts 现文件为唯一事实源,照抄比在计划里二手复写更不易错,且一致性测试兜底。其余无占位。
3. **类型一致**:`rich?: (text?: string | null) => ReactNode` 在 5/6/7 三处签名一致;`RichDeps`/`MatchSpellIndex`/`Entry` 单处定义;`ChipIcon` 搬家后唯一来源 `SpellInline.tsx`。
