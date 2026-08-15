# Offensive Deep Dive (Non-Death Finding Deep Dive) Design

**Goal:** Ensure the deep dive round (deepDive multi-turn questioning) also covers non-death findings, using offensive evidence that **mirrors** the death path to balance the coach's current bias towards death windows—non-death mistakes can also secure a deep dive seat and be thoroughly explained.

**Architecture:** Add a new "offensive pack builder" sibling + a dispatcher, reusing the existing `deepen()` / `buildDeepDivePrompt` / `auditDeepDives` scaffolding; **the survival (death) path remains completely untouched**, ensuring zero regression for the recently validated death deep dives.

**Tech Stack:** TypeScript monorepo. Analysis is in `packages/analysis`, deep dive service is in `packages/desktop/src/main`, triggered in the renderer. Eval harmonics are in `packages/eval/scripts`, with outputs in `$GLADLOG_EVAL_HOME` (defaults to `~/code/gladlog-eval-private`).

## Global Constraints

- **Single Source of Truth for Predicates Ironclad Rule**: The offensive pack strictly consumes `analyzeBurstLedger` / `analyzeOutgoingCCChains` / `computeOffensiveWindows` / `getHpPercentAtTime` — the **exact same batch of predicates** used when generating similar candidates in `candidateFindings.ts`, calculating no new facts. See CLAUDE.md "Predicates as Specifications".
- **Placeholder Discipline**: All numbers in the deep dive narrative must be `{{key.field}}` placeholders, interpolated only after the claimChecker; names use `sn()` to strip realm numbers; do not encode structured numerical values into key names (HP/hit rate/DR split into independent placeholder fields). See [[gladlog-deepdive-eval]].
- **Type Checking** `npm run typecheck` (never `tsc -b`). Before desktop push: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`.
- **Deep Dive Builder is inside `packages/analysis`**, using relative imports to fetch utils predicates (no need to export from index).
- Eval subagent responder/judge uniformly uses sonnet; cross-AI = sonnet + gemini (agy); agy output redirected to file (do not use `| tail`).

---

## Background / Current State

Deep Dive Current State (Death-Oriented):

- `buildDeepDivePack(combat, finding, findingIndex, candidates, ownerName?)` gathers **survival evidence** around the finding's reference event `[minT-30, maxT+10]`: friendly CC (`analyzePlayerCCAndTrinket`), friendly defensive + timing (`annotateDefensiveTimings`), enemy offensive CDs, owner HP, dispels, owner positioning (fix 3).
- `hasCoachableSignal` determines "friendly controllable mistakes": defensives used too early/late, ≥3s hard CC missing trinket usage, low-priority dispel wasting GCD, positioning mistakes.
- renderer (`StructuredAnalysisPanel.tsx`) sorts findings by `SEVERITY_RANK`, takes the top `DEEP_DIVE_MAX=2` that pass the gate to build packs, in a single `deepen()` call. `death` candidates have severity=high, almost dominating the 2 seats.

Non-death candidate types **already exist** (`candidateFindings.ts`, each bringing offensive facts):

| type                           | Trigger Condition (already pre-curated)            | Built-in facts                                          |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------- |
| `unconverted-burst`            | Burst unconverted to kill with no immunity         | target, damageM, hpStart, hpEnd, defensive, allyAligned |
| `burst-into-immunity`          | Main target gains immunity during burst            | target, immunity, overlap                               |
| `off-target-in-window`         | Hit percentage on window target too low in kill window | target, onTargetPct, offTarget                          |
| `juked-kick`                   | Kick baited by fake cast                           | kick, fake                                              |
| `dr-clipped-cc`                | owner CC lands on 25%/Immune DR                    | spell, target, dr                                       |
| ~~`cd-waste`~~ **(Excluded, see below)** | Never-used **survival** major cooldown (pure defensive wall), whole-round `t:0` | spell, unit(healer)                                     |

**Scope Correction (discovered via spec self-check):** `cd-waste` **does not enter this design**. Two reasons: (1) It is a
whole-round observation (`t:0`, `cdWasteEvents` commented as "whole-round observation, not
time-specific"), and the window-style pack builder filtering `c.t > 0` would directly evaluate to null, leaving no time anchor to deep dive into;
(2) It is actually a "never-used **survival** defensive wall" (healer anchored, `isThroughput` excluded),
which is fundamentally a survival category rather than an offensive mistake. Therefore, the offensive deep dive covers **5 categories of window-style non-death mistakes**: unconverted-burst
/ burst-into-immunity / off-target-in-window / juked-kick / dr-clipped-cc. If cd-waste
requires coaching, a separate whole-round mechanism needs to be established (add to backlog, not in this design).

Reusable predicates (all in `packages/analysis/src/utils/*`, already used by candidateFindings):

- `analyzeBurstLedger(owner, allies, enemies, combat)` → burst windows, each containing `dominantTarget`{`hpStartPct`, `hpEndPct`, `damage`, `defensivesHit`[{spellName, isImmunity, overlapSeconds}]}, `allyCDsOverlapping`, `spells`.
- `analyzeOutgoingCCChains(friends, enemies, combat)` → friendly outgoing CC chains against enemies (target, applications[{casterName, spellName, atSeconds, drInfo.level}]).
- `computeOffensiveWindows(enemies, friends, combat)` / `auditWindowTargeting` → offensive windows + targeting audit.
- `analyzeKickAudit(owner, enemies, combat)` → kick audit (juked).
- `getHpPercentAtTime(unit, t, startTime)` → HP percentage of any unit at a specific time (already used in the death path).
- `isHealerSpec(spec)` → identify enemy healer.

---

## Components

### 1. `buildOffensiveDeepDivePack(combat, finding, findingIndex, candidates, ownerName?): DeepDivePack | null`

New function, a sibling to `buildDeepDivePack`, outputting **the exact same `DeepDivePack` shape** (`deepen`/`prompt`/`audit` fully reused). Window anchoring is identical to the death path: `[min(eventIds.t)-30, max(eventIds.t)+10]`, filtered by `inWin`.

Collections within the window (all entering facts, numerical values via placeholders, names using `sn()` short names):

- **`target-hp`** — Enemy target health trajectory: points sampled via `getHpPercentAtTime(target, tPt)` within the window (mirroring the owner-HP split), facts `{t, hp, unit=sn(target), role:"enemy-target"}`.
- **`enemy-defensive`** — Defensives answering the burst (non-immunity): from the ledger `dominantTarget.defensivesHit.filter(!isImmunity)`, facts `{t, spell, unit=sn(target), role:"enemy"}`.
- **`immunity`** — Immunities: `defensivesHit.filter(isImmunity)`, facts `{t, spell, unit=sn(target), overlap, role:"enemy"}`.
- **`our-cc`** — Friendly outgoing CC against the **enemy healer**: `analyzeOutgoingCCChains` filtering target=enemy healer and caster∈friends, within the window, facts `{t, spell, unit=sn(enemyHealer), caster=sn(caster), role:"owner"|"teammate"}`.
- **`our-cd`** — Friendly offensive cooldown alignment: friendly offensive CD casts within the window (`extractMajorCooldowns` offensive tag, or ledger `allyCDsOverlapping`), facts `{t, spell, unit=sn(caster), role:"owner"|"teammate"}`.
- **Type-specific exclusive items** (inheriting built-in facts from candidates):
  - unconverted-burst → `off-target` if there are targeting issues; the core is the target-hp + enemy-defensive combination.
  - burst-into-immunity → `immunity` item (overlap seconds).
  - off-target-in-window → `off-target` item facts `{t, onTargetPct, target=sn, offTarget=sn(offTarget), role:"owner"}`.
  - juked-kick → `juked-kick` item facts `{t, kick, fake, role:"owner"}` + nearby enemy hard-casts within the window (`our-cd` not applicable, pulling enemy hard-cast context).
  - dr-clipped-cc → `dr-clip` item facts `{t, spell, target=sn, dr, role:"owner"}`, reusing the CC chain context of `our-cc`.

**Execution of the two categories (juked-kick / dr-clipped-cc) takes a subset**: They are point events, not laying out a full mirror—juked-kick pulls nearby enemy casts, dr-clip pulls CC chains. Conversion of the three categories (unconverted-burst / burst-into-immunity / off-target) takes the full mirror. (cd-waste is excluded, see background scope correction.)

Each category uses an independent `try/catch`; if advanced logs/geometry are missing, that category is absent (same as the death pack). Truncation reuses the "closest to focal moment" logic from the death pack (`PACK_MAX_ITEMS`).

`PackItem.kind` union extension: `| "target-hp" | "enemy-defensive" | "immunity" | "our-cc" | "our-cd" | "off-target" | "juked-kick" | "dr-clip"`.

### 2. Dispatcher

Add routing above `buildDeepDivePack` and `buildOffensiveDeepDivePack`: For each finding, check the candidate `type` referenced by its `eventIds`—

- Hits death/death-setup → Survival builder + `hasCoachableSignal`.
- Hits one of the 5 window-style non-death types → Offensive builder + `hasOffensiveCoachableSignal`.
- Mixed → Take the dominant one (majority of referenced candidates; ties favor death, as the death coaching value anchor is stronger).

The dispatcher is placed in the renderer's selection logic (see Component 4), not inside the builder (separation of concerns, same as placing the fix 1 gate on the caller side).

### 3. `hasOffensiveCoachableSignal(items: PackItem[]): boolean`

Parallel to `hasCoachableSignal`. Non-death candidates are already pre-curated as mistakes, so the gate is light—requiring an offensive story to be present:

- Has `target-hp` bottoming out at a certain threshold (e.g., ≤35%) **and** an `enemy-defensive` or `immunity` answered it → "Should swap/should wait/should CC healer" story is established; or
- Has an `off-target` item (hit rate is already below good); or
- Has a `juked-kick` item; or
- Has a `dr-clip` item.
  Criteria entirely use pack facts, sharing the same source as the candidate pre-curation.

### 4. Seat Selection (renderer, `StructuredAnalysisPanel.tsx`)

- Survival: Still takes the top `DEEP_DIVE_MAX=2` passing `hasCoachableSignal` sorted by severity.
- **1 Guaranteed Seat**: Picks the best 1 among non-death findings (passing `hasOffensiveCoachableSignal`; if multiple, sorted by candidate severity/damage to take top-1).
- Merges ≤3 packs, via **a single** `deepen()` call. `DEEP_DIVE_MAX` semantics remain unchanged (survival limit), adding a new constant `OFFENSIVE_DEEP_DIVE_MAX=1`.

### 5. Prompt Extension (`buildDeepDivePrompt`)

The same prompt accommodates both survival + offensive packs (both entering deepen once). Additions:

- Offensive item legend (Add a line to HARD RULES, explaining what target-hp/enemy-defensive/immunity/our-cc/our-cd/off-target/juked-kick/dr-clip each are, and role semantics).
- Offensive coaching framework: "you had the kill set up — coach what to change to close it(swap to the exposed target, hold burst past the immunity, lock their healer first)".
- Other disciplines remain unchanged (only reference pack keys, no raw numbers, no causality, clean window whitespace, firm verdict).
- `PROMPT_VERSION` 11→12 (invalidating old caches).

### 6. Audit

`auditDeepDives` **remains unchanged**: Placeholder resolution + raw number ban + causalLint + citedKeys⊆pack. Offensive numerical facts (hpStart/hpEnd/onTargetPct/dr/overlap) use placeholders; names use `sn()` short names to avoid realm number false positives.

---

## 数据流

```
初轮 findings
  └→ 分发器(按候选 type 路由)
       ├→ 死亡类 → buildDeepDivePack → hasCoachableSignal → ≤2 生存 pack
       └→ 非死亡类 → buildOffensiveDeepDivePack → hasOffensiveCoachableSignal → ≤1 进攻 pack
  └→ 合并 ≤3 pack → 一次 deepen() → 一个 prompt(含生存+进攻段)
  └→ 模型输出 → auditDeepDives(占位符/裸数字/因果/cited)
  └→ 渲染深挖笔记 + chips(跳进攻窗口锚点)
```

---

## 测试

1. **单测**(`packages/analysis/src/analysis/offensiveDeepDive.test.ts` 或并入 `deepDive.test.ts`):
   - `buildOffensiveDeepDivePack` 在合成 unconverted-burst / burst-into-immunity fixture 上产出预期 kind + facts(target-hp、enemy-defensive、immunity)。
   - `hasOffensiveCoachableSignal`:target 触底+防御接 → true;off-target → true;juked → true;纯中性 → false。
   - 分发器路由:death finding → 生存;unconverted-burst finding → 进攻;混合 → 主导。
2. **确定性扫描**(`packages/eval/scripts/deepDiveOffensiveScan.ts`,镜像 `deepDiveScan`):对语料每个非死亡候选跑完整 buildOffensiveDeepDivePack + gate,断言无崩溃 / role 缺失 / facts↔items 不一致 / 残留数字(名字类),统计逐类型过门率、每包 mean 条数。`NUMERIC_FIELDS` 加 `hpStart/hpEnd/onTargetPct/dr/overlap`。
3. **谓词单源单测**:断言进攻 pack 的 target HP / 防御与 `analyzeBurstLedger` 同值(或直接消费,天然同源)。

---

## 大规模 A/B 测试(交付验证,用户强调)

镜像走位价值 eval(`deepDivePositionValue{Gen,Audit}.ts`),但对比的是**进攻深挖上线前后**:

- **before**:非死亡 finding 不深挖(现状——席位全给死亡,非死亡沉默)。
- **after**:进攻深挖上线(保底席 + 进攻 pack)。
- **语料**:公开对局 ≥200 场(复用 `gladlog-eval-private/corpus` 的 deepdive-2v2 / 220 / hi / public-dps ≈578 文件,去重)。
- **生成**:对每个过 `hasOffensiveCoachableSignal` 的非死亡 finding 出 v12 进攻 prompt;sonnet responder 产 deepDive JSON;回构 pack + auditDeepDives 解析。
- **盲评**:sonnet + gemini(agy)盲评 actionability 1–5;揭盲按类型(转化三类 / 执行两类)分桶。
- **对照锚**:同批死亡深挖(生存桶)进盲评,证明 judge 尺子正常 + 进攻不劣于生存。
- **指标**:
  - 产出率(过门后模型真产出 vs 诚实留白 vs 审计毙),逐类型。
  - 价值均值(combined + 逐 judge),进攻 vs 生存对照。
  - **零 filler 硬指标**(两 judge 均无 ≤2 分),同修 1+2 标准。
  - 净新增覆盖:多少非死亡 finding 现在有深挖(before 为沉默)。
- **决策规则**:进攻深挖价值均值落在可行动区(≥3.5)且零 filler → 上线成立;若某类型系统性偏低/filler → 该类型收紧门或降级(不做 spec 定制参数,用户铁律)。

---

## 边界 / YAGNI

- **不做全局锚点**(BACKLOG #13):进攻深挖仍是放大镜——只在初轮已标记的非死亡 finding 窗口内收证据,不全局扫新问题。全局发现是独立 brainstorm。
- **执行两类拿子集证据**,非完整镜像(用户确认)。
- **cd-waste 排除**:whole-round + 生存类,无窗口锚点,不进本设计(记 backlog)。
- **不做 spec 定制参数**:门阈值全 spec 无关。
- 进攻 pack 缺高级日志(无坐标/详细伤害)时优雅缺席,不抛。
