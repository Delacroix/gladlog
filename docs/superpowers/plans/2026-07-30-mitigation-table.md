# 减伤 {百分比, 学派} 表(#17 地基)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 白名单 35 个主防御/外置的 `{pct, schoolMask}` 表:DB2 生成底 + 策展覆盖,无第三态防腐,本期零消费者。

**Architecture:** datagen 新脚本挖 `SpellEffect` 的 `EffectAura==87`(AURA_MOD_DAMAGE_PERCENT_TAKEN)行 → `mitigationGenerated.json`;`mitigationData.ts` 双层合并(overrides 恒赢)+ `NO_MITIGATION_IDS` 显式登记;35 条人审 + 语料 sanity 验收。

**Tech Stack:** TypeScript、vitest、wago.tools DB2 CSV。

**Spec:** `docs/superpowers/specs/2026-07-30-mitigation-table-design.md`
**工作目录:** 一律 worktree `/Users/mingjianliu/code/gladlog-wt-small`(main;依赖已装)。主检出 `/Users/mingjianliu/code/gladlog` 被用户占用,**绝对不碰**。

## Global Constraints

- 直接 commit 到 worktree main,最终 push;复合命令绝不裸 `cd`;门禁链绝不加管道;push 前 `npm run presubmit`。
- 测试 workspace 口径(`npm test --workspace=packages/analysis`)。
- **白名单单源**:35 条 id 只从 `spellIdLists.bigDefensiveSpellIds ∪ externalDefensiveSpellIds` 派生(21+14),任何文件不得复制 id 数组;
- **无第三态**:`MITIGATION_TABLE ∪ NO_MITIGATION_IDS ⊇ 白名单`,防腐测试断言;
- 生成层只认 `EffectAura===87`,歧义/挖不出**不猜**进 unresolved;策展覆盖恒赢;
- schoolMask 与日志 `spellSchoolId` 同位义(0x1 物理 … 0x7F 全);pct∈(0,100],免疫=100;
- datagen 支持 `DATAGEN_BUILD` 环境钉 build(genSpellNamesZh 先例)——**生成必须钉 `DATAGEN_BUILD=12.1.0.68629`**(与仓内其他生成物同 build,manifest 不许漂)。

---

### Task 1: datagen — genMitigation.ts + 生成物 + 登记

**Files:**

- Create: `packages/analysis/scripts/datagen/genMitigation.ts`
- Test: `packages/analysis/test/datagen.mitigation.test.ts`(新)
- Modify: `packages/analysis/scripts/datagen/writeManifest.ts`(artifacts 加条目)
- Create(生成): `packages/analysis/src/data/mitigationGenerated.json`
- Modify: `packages/analysis/src/data/datagen-manifest.json`(脚本生成)
- Modify: `docs/commands/update-wow-data.md`(步骤 6g 登记)

**Interfaces:**

- Consumes: `parseCsv/fetchLatestBuild/fetchTable/assertColumns`(`lib/wagoCsv`)、`writeArtifact`(`lib/emit`)、`spellIdLists`(default export,`packages/analysis/src/data/spellIdLists.ts`)。
- Produces:
  - `transformMitigation(csvText, whitelistIds): { entries: Record<string, { pct: number; schoolMask: number }>; unresolved: Array<{ id: string; reason: string }> }`(纯函数,导出)
  - `mitigationGenerated.json` = `{ entries, unresolved }`(unresolved 落盘——策展层要看着它填)

- [ ] **Step 1: 写失败的 transform 单测**

`packages/analysis/test/datagen.mitigation.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { transformMitigation } from "../scripts/datagen/genMitigation";

// SpellEffect CSV 最小样:列名以真表为准(实现者先 fetchTable 抽真 CSV 头核对,
// 下面用 genTalentModifiers 已消费过的列名)
const HEADER =
  "ID,DifficultyID,EffectAura,EffectBasePointsF,EffectMiscValue_0,SpellID,Effect";
const row = (
  spellId: string,
  aura: string,
  points: string,
  misc: string,
  diff = "0",
) =>
  `${Math.random().toString().slice(2, 8)},${diff},${aura},${points},${misc},${spellId},6`;

describe("transformMitigation", () => {
  const WL = new Set(["22812", "33206", "642", "97462"]);

  test("87 行:负 points 取绝对值,mask 透传;非白名单/非 87 行忽略", () => {
    const csv = [
      HEADER,
      row("22812", "87", "-20", "127"), // Barkskin: 20% 全学派
      row("33206", "87", "-40", "127"), // Pain Suppression: 40%
      row("99999", "87", "-30", "127"), // 非白名单 → 忽略
      row("22812", "4", "-15", "1"), // 非 87 aura → 忽略
    ].join("\n");
    const r = transformMitigation(csv, WL);
    expect(r.entries).toEqual({
      "22812": { pct: 20, schoolMask: 127 },
      "33206": { pct: 40, schoolMask: 127 },
    });
    expect(r.unresolved).toEqual([]);
  });

  test("同 spell 多条 87 行且值不同 → 不猜,进 unresolved", () => {
    const csv = [
      HEADER,
      row("97462", "87", "-10", "127"),
      row("97462", "87", "-15", "127"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["97462"]));
    expect(r.entries["97462"]).toBeUndefined();
    expect(r.unresolved).toEqual([
      { id: "97462", reason: "multiple-conflicting-87-rows" },
    ]);
  });

  test("同 spell 多条 87 行但值相同 → 收敛为一条(非歧义)", () => {
    const csv = [
      HEADER,
      row("642", "87", "-20", "126"),
      row("642", "87", "-20", "126"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toEqual({ pct: 20, schoolMask: 126 });
  });

  test("白名单内零命中 87 行 → 不进 entries 也不进 unresolved(缺席由防腐测试在合并层抓)", () => {
    const csv = [HEADER, row("642", "4", "-20", "1")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries).toEqual({});
    expect(r.unresolved).toEqual([]);
  });

  test("DifficultyID 非 0 的行忽略(genDrCategories 同款去重口径)", () => {
    const csv = [HEADER, row("642", "87", "-20", "127", "1")].join("\n");
    expect(transformMitigation(csv, new Set(["642"])).entries).toEqual({});
  });

  test("正 points(非减伤语义)→ unresolved 而非收录", () => {
    const csv = [HEADER, row("642", "87", "25", "127")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toBeUndefined();
    expect(r.unresolved).toEqual([{ id: "642", reason: "positive-points" }]);
  });
});
```

⚠ 实现者第一步:`DATAGEN_CACHE=$(mktemp -d) `下先拉一次真 `SpellEffect` CSV,核对表头列名(`EffectAura/EffectBasePointsF/EffectMiscValue_0/SpellID/DifficultyID` 是否与 genTalentModifiers.ts:142-147 消费的一致);不一致则按真列名修正测试与实现,报告写明。

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- datagen.mitigation`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`genMitigation.ts`(结构照 genSpellNamesZh.ts:DATAGEN_BUILD 覆盖 + main 自启动):

```ts
import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertColumns,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";
import spellIdLists from "../../src/data/spellIdLists";

/** AURA_MOD_DAMAGE_PERCENT_TAKEN:EffectBasePointsF=负百分比,
 * EffectMiscValue_0=学派掩码(与日志 spellSchoolId 同位义)。 */
const MITIGATION_AURA = "87";

export interface IMitigationRaw {
  pct: number;
  schoolMask: number;
}

export function transformMitigation(
  csvText: string,
  whitelistIds: ReadonlySet<string>,
): {
  entries: Record<string, IMitigationRaw>;
  unresolved: Array<{ id: string; reason: string }>;
} {
  const { rows } = parseCsv(csvText);
  const seen = new Map<string, IMitigationRaw[]>();
  for (const row of rows) {
    if (row.DifficultyID !== "0") continue;
    if (row.EffectAura !== MITIGATION_AURA) continue;
    const id = row.SpellID;
    if (!whitelistIds.has(id)) continue;
    const points = Number(row.EffectBasePointsF);
    const mask = Number(row.EffectMiscValue_0);
    const arr = seen.get(id) ?? [];
    arr.push({ pct: points, schoolMask: mask }); // 暂存原始符号,收敛时判
    seen.set(id, arr);
  }
  const entries: Record<string, IMitigationRaw> = {};
  const unresolved: Array<{ id: string; reason: string }> = [];
  for (const [id, hits] of seen) {
    const uniq = [...new Set(hits.map((h) => `${h.pct}:${h.schoolMask}`))];
    if (uniq.length > 1) {
      unresolved.push({ id, reason: "multiple-conflicting-87-rows" });
      continue;
    }
    const h = hits[0]!;
    if (h.pct >= 0) {
      unresolved.push({ id, reason: "positive-points" });
      continue;
    }
    entries[id] = {
      pct: Math.abs(Math.round(h.pct)),
      schoolMask: h.schoolMask,
    };
  }
  return { entries, unresolved };
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const csv = await fetchTable("SpellEffect", build, process.env.DATAGEN_CACHE);
  const wl = new Set([
    ...spellIdLists.bigDefensiveSpellIds,
    ...spellIdLists.externalDefensiveSpellIds,
  ]);
  const r = transformMitigation(csv, wl);
  const outPath = new URL(
    "../../src/data/mitigationGenerated.json",
    import.meta.url,
  ).pathname;
  writeArtifact(outPath, JSON.stringify(r, null, 2)); // 小表,pretty 便于人审 diff
  console.log(
    `entries=${Object.keys(r.entries).length} unresolved=${r.unresolved.length}`,
    build,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genMitigation.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

(`assertColumns` 在拉到真 CSV 后按真列名加进 main;写法照 genDrCategories.ts:34-38。)

- [ ] **Step 4: 跑测确认通过 + 真跑生成物**

```bash
npm test --workspace=packages/analysis -- datagen.mitigation
export DATAGEN_CACHE=$(mktemp -d)
DATAGEN_BUILD=12.1.0.68629 npx tsx packages/analysis/scripts/datagen/genMitigation.ts
```

Expected: 测试 PASS;stdout 打 entries/unresolved 计数(量级预期:35 条里 87 行直挖命中十几到二十几条,unresolved+零命中共十条上下——实际数字进报告)。`writeManifest.ts` artifacts 加:

```ts
"mitigationGenerated.json": {
  entries: Object.keys(readJson("mitigationGenerated.json").entries).length,
  unresolved: readJson("mitigationGenerated.json").unresolved.length,
  bytes: statSync(dataDir + "mitigationGenerated.json").size,
},
```

`DATAGEN_BUILD=12.1.0.68629 npx tsx packages/analysis/scripts/datagen/writeManifest.ts`,git diff 核对 build 仍 68629。`update-wow-data.md` 步骤 4 的 6f 之后加:

```bash
# 6g. 减伤表(#17 地基;白名单=big∪external 35 条,策展覆盖在 mitigationData.ts)
npx tsx packages/analysis/scripts/datagen/genMitigation.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add packages/analysis docs/commands/update-wow-data.md
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "feat(analysis): 减伤表生成层 genMitigation(SpellEffect aura87,歧义不猜进 unresolved)"
```

---

### Task 2: mitigationData.ts 双层合并 + 35 条人审策展 + 防腐测试

**Files:**

- Create: `packages/analysis/src/data/mitigationData.ts`
- Modify: `packages/analysis/src/index.ts`(导出)
- Test: `packages/analysis/test/mitigationData.test.ts`(新)

**Interfaces:**

- Consumes: Task 1 的 `mitigationGenerated.json`、`spellIdLists`。
- Produces(#17 未来消费;index 导出):
  - `IMitigationEntry = { pct: number; schoolMask: number }`
  - `MITIGATION_TABLE: Record<string, IMitigationEntry>`(合并后)
  - `NO_MITIGATION_IDS: ReadonlySet<string>`
  - `MITIGATION_OVERRIDES: Record<string, IMitigationEntry>`(导出仅为测试可断言键面)

- [ ] **Step 1: 写失败的防腐测试**

`packages/analysis/test/mitigationData.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  MITIGATION_OVERRIDES,
  MITIGATION_TABLE,
  NO_MITIGATION_IDS,
} from "../src/data/mitigationData";
import spellIdLists from "../src/data/spellIdLists";

const WL = new Set([
  ...spellIdLists.bigDefensiveSpellIds,
  ...spellIdLists.externalDefensiveSpellIds,
]);

describe("减伤表防腐(无第三态)", () => {
  test("白名单全覆盖:TABLE ∪ NO_MITIGATION_IDS ⊇ 白名单,且无第三态", () => {
    const missing = [...WL].filter(
      (id) => !(id in MITIGATION_TABLE) && !NO_MITIGATION_IDS.has(id),
    );
    expect(missing).toEqual([]); // 缺谁红谁,错误信息直接可读
  });

  test("两态互斥:登记为无减伤的 id 不得同时在表里", () => {
    const both = Object.keys(MITIGATION_TABLE).filter((id) =>
      NO_MITIGATION_IDS.has(id),
    );
    expect(both).toEqual([]);
  });

  test("值域:pct∈(0,100],schoolMask∈(0,0x7F]", () => {
    for (const [id, e] of Object.entries(MITIGATION_TABLE)) {
      expect(e.pct, id).toBeGreaterThan(0);
      expect(e.pct, id).toBeLessThanOrEqual(100);
      expect(e.schoolMask, id).toBeGreaterThan(0);
      expect(e.schoolMask, id).toBeLessThanOrEqual(0x7f);
    }
  });

  test("表不越界:TABLE/OVERRIDES/NO_MITIGATION_IDS 的键都在白名单内", () => {
    for (const id of Object.keys(MITIGATION_TABLE))
      expect(WL.has(id), id).toBe(true);
    for (const id of Object.keys(MITIGATION_OVERRIDES))
      expect(WL.has(id), id).toBe(true);
    for (const id of NO_MITIGATION_IDS) expect(WL.has(id), id).toBe(true);
  });
});

describe("锚点(游戏事实,实现期人审后钉死)", () => {
  // 实现者人审 35 条后,挑 3 个跨来源锚点写死——下面三条是候选,
  // 若人审值不同以人审为准改断言并在注释记录依据:
  test("Barkskin 22812:20% 全学派", () => {
    expect(MITIGATION_TABLE["22812"]).toEqual({ pct: 20, schoolMask: 0x7f });
  });
  test("Pain Suppression 33206:40% 全学派", () => {
    expect(MITIGATION_TABLE["33206"]).toEqual({ pct: 40, schoolMask: 0x7f });
  });
  test("Divine Shield 642:免疫=100", () => {
    expect(MITIGATION_TABLE["642"]?.pct).toBe(100);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- mitigationData`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 + 35 条人审填充**

`mitigationData.ts`:

```ts
import generated from "./mitigationGenerated.json";

export interface IMitigationEntry {
  /** 减伤百分比,0-100;免疫类=100。 */
  pct: number;
  /** 作用学派掩码,与日志 spellSchoolId 同位义(0x7F 全/0x7E 仅魔法/0x1 仅物理)。 */
  schoolMask: number;
}

/** 策展覆盖层(恒赢):每条注明来源与覆盖原因。生成层挖不出(unresolved/
 * 零命中)或挖错(与游戏事实不符)的条目在这里定值。 */
export const MITIGATION_OVERRIDES: Record<string, IMitigationEntry> = {
  // 逐条形如:
  // "642": { pct: 100, schoolMask: 0x7f }, // Divine Shield:免疫,游戏事实;生成层零命中(免疫不走 aura87)
  // …实现者按人审结果填…
};

/** 白名单内确无(百分比型)减伤属性的条目——纯吸收盾/治疗/仅特殊机制类,
 * 每条注明原因。与 MITIGATION_TABLE 互斥,防腐测试把守无第三态。 */
export const NO_MITIGATION_IDS: ReadonlySet<string> = new Set([
  // "xxxxx", // 技能名:原因(如 纯吸收盾,无百分比减伤语义)
]);

const gen = (
  generated as unknown as {
    entries: Record<string, IMitigationEntry>;
  }
).entries;

/** 合并表:生成底 + 策展覆盖恒赢(spellEffectData 双层同款)。 */
export const MITIGATION_TABLE: Record<string, IMitigationEntry> = {
  ...gen,
  ...MITIGATION_OVERRIDES,
};
```

**人审流程(本任务的核心工作,不许省)**:35 条逐条过——生成值与游戏事实
(技能 tooltip 语义)对照;分歧/缺失逐条决定进 OVERRIDES(带注释)还是
NO_MITIGATION_IDS(带原因)。产出一张 35 行清单进报告:id/技能名/生成值/
终值/来源(generated|override|no-mitigation)/依据一句。**拿不准的条目在报告
里单独立「待人拍板」节**,不许拍脑袋定值——控制器会把该节呈给用户。
`index.ts` 导出四个符号(挨着既有 data 导出)。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis`(全量)+ `npm run typecheck`
Expected: 全绿(锚点值若与人审不符,以人审为准改断言并注明依据)。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "feat(analysis): 减伤表双层合并 + 35 条人审策展 + 无第三态防腐(#17 地基)"
```

---

### Task 3: 语料 sanity + 门禁 + push + 收账

**Files:**

- Modify: `docs/BACKLOG.md`(#17.2 地基条目注记)

- [ ] **Step 1: 语料 sanity(official-data 纪律:官方表也要实测)**

一次性脚本(/tmp,跑完删):本机库找 2-3 场含明确大减伤窗的对局(如
`auraEvents` 里 22812/33206/871 的 applied→removed 窗口 ≥4s 且窗口内
damageIn ≥5 条),对每个窗口计算:窗口内每秒承伤均值 vs 窗口前 10s 每秒
承伤均值的折减比,与表值同量级判定(±10pp 级容差;吸收/护甲/目标切换等
混杂因素不建模,只防**系统性**挖错——如表说 40% 实测只降 5%,或方向反了)。
每个抽样窗口的数字进报告;明显不符 → 停下报告,别硬调表值。

- [ ] **Step 2: presubmit + push**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-small && npm run presubmit)
# 绿后:
git -C /Users/mingjianliu/code/gladlog-wt-small push
# 若远端有新提交:fetch + rebase origin/main + 重跑 presubmit 再 push
```

- [ ] **Step 3: 按 headSha 盯 CI**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-small rev-parse HEAD)
# gh run list 按 headSha 选 → gh run watch <id> --exit-status(空则 sleep 20 重查)
```

本计划纯 analysis 数据层,视觉基线不应动;frontend-qa 若红即异常,如实报告。

- [ ] **Step 4: BACKLOG 收账**

`docs/BACKLOG.md` #17 第 2 子件(「减伤百分比表 + 分学派伤害拆分」)加注:
`✅ 表层地基(2026-07-30:MITIGATION_TABLE 双层 35 条无第三态,spec docs/superpowers/specs/2026-07-30-mitigation-table-design.md;学派覆盖率已量化 148/148 窗口 ≥90% 可归因;分学派伤害拆分消费留 #17 主体)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "docs: backlog #17.2 表层地基收账"
git -C /Users/mingjianliu/code/gladlog-wt-small push
```

- [ ] **Step 5: 汇报**

35 行人审清单(含「待人拍板」节若有)、生成/覆盖/无减伤三态计数、语料
sanity 数字、CI 结论。

---

## Self-Review 记录(定稿前跑过)

1. **Spec 覆盖**:生成层含锚点验证与 unresolved 落盘(T1)、双层合并/无第三态/值域/表不越界(T2)、人审 35 条 + 语料 sanity(T2/T3)、update-wow-data 登记(T1)、零消费者(全计划无接入点)。
2. **占位符**:T2 的 OVERRIDES/NO_MITIGATION_IDS 内容由人审产生——这是任务本体而非 TBD,且「拿不准立待拍板节」有明确出口;锚点断言标注「人审后钉死,候选值可改需注依据」。
3. **类型一致**:`IMitigationEntry` T1(IMitigationRaw 同形)/T2 一致;`transformMitigation` 返回形状与 json 产物一致;测试消费的四个导出与实现一致。
