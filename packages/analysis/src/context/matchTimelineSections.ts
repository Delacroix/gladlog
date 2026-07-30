import {
  CombatAbsorbAction,
  ICombatUnit,
  LogEvent,
} from "@gladlog/parser-compat";

import { getEnglishSpellName } from "../data/spellEffectData";
import { IPlayerCCTrinketSummary } from "../utils/ccTrinketAnalysis";
import {
  cdAvailableAt,
  fmtTime,
  FORBEARANCE_GATED_IDS,
  getUnitHpAtTimestamp,
  getUnitManaAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  IDamageBucket,
  IMajorCooldownInfo,
  isHealerSpec,
  selfForbearanceActiveAt,
  specToBenchmarkKey,
  specToString,
  USABLE_WHILE_CC_SPELL_IDS,
  toRenderSecond,
} from "../utils/cooldowns";
import {
  COUNTERFACTUAL_WINDOW_S,
  DECISIVE_MARGIN_PCT,
  ICounterfactualHit,
  IMitigationAuditRow,
} from "../utils/counterfactual";
import { wasLockedOutThroughWindow } from "../utils/deathOutcomeAnalysis";
import { getHpPercentAtTime } from "../utils/killWindowTargetSelection";
import { benchmarks } from "../utils/specBaselines";
import {
  DMG_SPIKE_THRESHOLD,
  getTopDamageSourcesInWindow,
} from "./timelineHelpers";

// ── Rot Pressure (F147) ─────────────────────────────────────────────────────

const DOT_SPELL_IDS = new Set<string>([
  "980",
  "172",
  "30108",
  "461531",
  "63106",
  "205179",
  "361695", // Warlock
  "589",
  "34914",
  "2944",
  "390978", // Priest
  "164812",
  "8921",
  "164815",
  "93402",
  "202347",
  "1079",
  "155722",
  "1822",
  "192090",
  "106830", // Druid
  "1943",
  "703",
  "2818",
  "122233",
  "121411", // Rogue
  "191587",
  "55078",
  "55095", // DK
  "188389", // Shaman
  "269747",
  "271788",
  "118253",
  "217200", // Hunter
  "12654", // Mage
  "115767",
  "84617", // Warrior
  "357209", // Evoker
]);

const DOT_SPELL_NAMES = new Set<string>([
  "agony",
  "corruption",
  "unstable affliction",
  "wither",
  "shadow word: pain",
  "vampiric touch",
  "devouring plague",
  "sunfire",
  "moonfire",
  "stellar flare",
  "rip",
  "rake",
  "thrash",
  "rupture",
  "garrote",
  "deadly poison",
  "crimson tempest",
  "virulent plague",
  "blood plague",
  "frost fever",
  "flame shock",
  "serpent sting",
  "ignite",
  "deep wounds",
  "fire breath",
]);

interface IDotInterval {
  spellId: string;
  spellName: string;
  startMs: number;
  endMs: number;
}

function extractPlayerDotIntervals(
  player: ICombatUnit,
  matchStartMs: number,
  matchEndMs: number,
): IDotInterval[] {
  const intervals: IDotInterval[] = [];
  const openDots = new Map<string, number>();

  const sortedEvents = player.auraEvents ?? [];

  for (const event of sortedEvents) {
    const ts = event.logLine.timestamp;
    if (ts > matchEndMs) continue;

    const spellId = event.spellId ?? "";
    const spellName = getEnglishSpellName(spellId, event.spellName);
    const spellNameLower = spellName.toLowerCase();

    const isDot =
      DOT_SPELL_IDS.has(spellId) ||
      [...DOT_SPELL_NAMES].some((name) => spellNameLower.includes(name));
    if (!isDot) continue;

    const auraType = event.logLine.parameters[11];
    if (auraType === "BUFF") continue;

    const stateKey = `${spellId}:${event.srcUnitId}`;
    if (event.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (!openDots.has(stateKey)) {
        openDots.set(stateKey, ts);
      }
    } else if (event.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      const startMs = openDots.get(stateKey);
      if (startMs !== undefined) {
        intervals.push({
          spellId,
          spellName,
          startMs,
          endMs: ts,
        });
        openDots.delete(stateKey);
      }
    }
  }

  for (const [stateKey, startMs] of openDots) {
    const spellId = stateKey.split(":")[0];
    const spellName = getEnglishSpellName(spellId, "");
    intervals.push({
      spellId,
      spellName,
      startMs,
      endMs: matchEndMs,
    });
  }

  return intervals;
}

/**
 * Rot Pressure Detection (F147). Emits a [ROT PRESSURE] entry for each player that
 * sustains ≥4 consecutive seconds below 40% HP with ≥3 active DoTs, where the recent
 * damage was majority periodic. Pushes entries via the `addEntry` callback.
 */
export function emitRotPressureEntries(params: {
  allPlayers: ICombatUnit[];
  matchStartMs: number;
  matchEndMs: number;
  matchDurationS: number;
  pid: (name: string) => string;
  addEntry: (timeSeconds: number, ...lines: string[]) => void;
}): void {
  const {
    allPlayers,
    matchStartMs,
    matchEndMs,
    matchDurationS,
    pid,
    addEntry,
  } = params;

  for (const player of allPlayers) {
    const dotIntervals = extractPlayerDotIntervals(
      player,
      matchStartMs,
      matchEndMs,
    );
    const durationSeconds = Math.floor(matchDurationS);
    const dotCounts = new Array(durationSeconds + 1).fill(0);
    for (const interval of dotIntervals) {
      const startSec = Math.max(
        0,
        Math.ceil((interval.startMs - matchStartMs) / 1000),
      );
      const endSec = Math.min(
        durationSeconds,
        Math.floor((interval.endMs - matchStartMs) / 1000),
      );
      for (let t = startSec; t <= endSec; t++) {
        dotCounts[t]++;
      }
    }

    let consecutiveRotSeconds = 0;
    let emittedForThisBlock = false;

    for (let t = 0; t <= durationSeconds; t++) {
      const tsMs = matchStartMs + t * 1000;
      const dotCount = dotCounts[t];

      const hp = getUnitHpAtTimestamp(player, tsMs, HP_SAMPLE_RADIUS_MS);

      if (hp !== null && hp < 40 && dotCount >= 3) {
        consecutiveRotSeconds++;
        if (consecutiveRotSeconds >= 4 && !emittedForThisBlock) {
          const windowStartMs = tsMs - 4000;
          const windowEndMs = tsMs;

          let periodicDmg = 0;
          let totalDmg = 0;

          for (const dmg of player.damageIn) {
            if (
              dmg.timestamp >= windowStartMs &&
              dmg.timestamp <= windowEndMs
            ) {
              const amount = Math.abs(dmg.effectiveAmount || dmg.amount);
              totalDmg += amount;
              if (
                dmg.logLine.event === "SPELL_PERIODIC_DAMAGE" ||
                dmg.logLine.event === "SPELL_PERIODIC_DAMAGE_SUPPORT"
              ) {
                periodicDmg += amount;
              }
            }
          }

          if (totalDmg === 0 || periodicDmg / totalDmg >= 0.5) {
            addEntry(
              t,
              `${fmtTime(t)}  [ROT PRESSURE]   ${pid(player.name)} (${specToString(player.spec)}) at ${Math.round(hp)}% HP with ${dotCount} active DoTs`,
            );
            emittedForThisBlock = true;
          }
        }
      } else {
        consecutiveRotSeconds = 0;
        emittedForThisBlock = false;
      }
    }
  }
}

// ── [DMG SPIKE] events ──────────────────────────────────────────────────────

/**
 * Emits [DMG SPIKE] entries for each pressure window at or above DMG_SPIKE_THRESHOLD,
 * annotating HP velocity, absorbs, and top damage sources. Pushes entries via `addEntry`.
 */
export function emitDmgSpikeEntries(params: {
  pressureWindows: IDamageBucket[];
  friends: ICombatUnit[];
  matchStartMs: number;
  pid: (name: string) => string;
  playerIdMap?: Map<string, number>;
  enemyIdMap?: Map<string, number>;
  addEntry: (timeSeconds: number, ...lines: string[]) => void;
}): void {
  const {
    pressureWindows,
    friends,
    matchStartMs,
    pid,
    playerIdMap,
    enemyIdMap,
    addEntry,
  } = params;

  for (const pw of pressureWindows) {
    if (pw.totalDamage < DMG_SPIKE_THRESHOLD) continue;
    const dmgM = (pw.totalDamage / 1_000_000).toFixed(2);
    const windowSec = Math.round(pw.toSeconds - pw.fromSeconds);
    // B20: Prevent Infinityk DPS on sub-second windows
    const dpsK = Math.round(pw.totalDamage / Math.max(1, windowSec) / 1000);

    const targetUnit = friends.find((f) => f.name === pw.targetName);
    // 采样时刻必须先归到渲染网格:本行的时间戳经 fmtTime 向下取整,而 [STATE]
    // 按整数秒采样。用小数秒 pw.fromSeconds 取样会命中另一个 advancedAction,
    // 于是同一显示秒下两行 HP 打架(2026-07-20 eval 26/50 场,中位 7pp)。
    // 半径全程统一 HP_SAMPLE_RADIUS_MS,与 [STATE] tick 一致(同时刻 + 同半径
    // ⇒ 必然取到同一条读数)。曾经关键窗口收窄到 ±1.5s,已删,见 cooldowns.ts。
    const fromSec = toRenderSecond(pw.fromSeconds);
    const toSec = toRenderSecond(pw.toSeconds);
    const hpFrom = targetUnit
      ? getUnitHpAtTimestamp(
          targetUnit,
          matchStartMs + fromSec * 1000,
          HP_SAMPLE_RADIUS_MS,
        )
      : null;
    const hpTo = targetUnit
      ? getUnitHpAtTimestamp(
          targetUnit,
          matchStartMs + toSec * 1000,
          HP_SAMPLE_RADIUS_MS,
        )
      : null;
    let hpStr = "";
    if (hpFrom !== null && hpTo !== null) {
      const hpDelta = hpTo - hpFrom;
      const hpVelocity = hpDelta / Math.max(1, windowSec);
      const sign = hpVelocity > 0 ? "+" : "";
      // labelBias fix (3 independent judge batches, 2026-07-15): a [DMG SPIKE]
      // whose target ends the window at equal-or-higher HP reads as a severity
      // verdict on a non-event. Keep the tag and the percent format (the
      // Layer-A HP gate parses them) but state the outcome explicitly.
      const outcomeTag = hpDelta >= 0 ? " — healed through" : "";
      hpStr = ` (${hpFrom}% -> ${hpTo}% HP, ${sign}${hpVelocity.toFixed(0)}%/s${outcomeTag})`;
    }

    const benchmarkKey = targetUnit ? specToBenchmarkKey(targetUnit.spec) : "";
    let b = benchmarks.bySpec[benchmarkKey];

    // Fallback logic for missing specs: try generic spec for same class (e.g. Shadow -> Holy Priest baseline)
    if (!b && targetUnit) {
      const className = benchmarkKey.split(" ")[0];
      const fallbackKey = Object.keys(benchmarks.bySpec).find((k) =>
        k.startsWith(className),
      );
      if (fallbackKey) b = benchmarks.bySpec[fallbackKey];
    }

    const fromMs = matchStartMs + pw.fromSeconds * 1000;
    const toMs = matchStartMs + pw.toSeconds * 1000;
    const windowEvents =
      targetUnit?.damageIn.filter(
        (d) => d.logLine.timestamp >= fromMs && d.logLine.timestamp <= toMs,
      ) ?? [];
    const totalAbsorbed = windowEvents.reduce((sum, d) => {
      if (d.logLine.event === LogEvent.SPELL_ABSORBED) {
        return sum + ((d as unknown as CombatAbsorbAction).absorbedAmount ?? 0);
      }
      return sum;
    }, 0);

    const absorbStr =
      totalAbsorbed > 100_000
        ? ` (${(totalAbsorbed / 1_000_000).toFixed(2)}M absorbed)`
        : "";

    const topSources = targetUnit
      ? getTopDamageSourcesInWindow(
          targetUnit,
          toMs,
          pw.toSeconds * 1000 - pw.fromSeconds * 1000,
          3,
          playerIdMap,
          enemyIdMap,
        )
      : [];
    const sourceStr =
      topSources.length > 0
        ? `\n                 Top sources: ${topSources.join(", ")}`
        : "";

    addEntry(
      pw.fromSeconds,
      `${fmtTime(pw.fromSeconds)}–${fmtTime(pw.toSeconds)}  [DMG SPIKE]   ${pid(pw.targetName)} (${pw.targetSpec}): ${dmgM}M in ${windowSec}s (${dpsK}k DPS)${hpStr}${absorbStr}${sourceStr}`,
    );
  }
}

// ── [MANA] markers (F144) ───────────────────────────────────────────────────

/**
 * Adds [MANA] context markers every 30s for long matches (>300s). Pushes entries via
 * `addEntry`. Caller gates the whole block on matchDurationS > 300.
 */
export function emitManaMarkerEntries(params: {
  owner: ICombatUnit;
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  matchStartMs: number;
  matchDurationS: number;
  friendlyDeathAtByName: Map<string, number>;
  enemyDeathAtByName: Map<string, number>;
  pid: (name: string) => string;
  enemyPid: (name: string) => string;
  addEntry: (timeSeconds: number, ...lines: string[]) => void;
}): void {
  const {
    owner,
    friends,
    enemies,
    matchStartMs,
    matchDurationS,
    friendlyDeathAtByName,
    enemyDeathAtByName,
    pid,
    enemyPid,
    addEntry,
  } = params;

  const friendlyHealers = [
    owner,
    ...friends.filter((f) => f.id !== owner.id),
  ].filter((u) => isHealerSpec(u.spec));
  const enemyHealers = enemies.filter((u) => isHealerSpec(u.spec));
  if (friendlyHealers.length > 0 || enemyHealers.length > 0) {
    for (let t = 0; t <= Math.floor(matchDurationS); t += 30) {
      const tsMs = matchStartMs + t * 1000;

      const friendlyParts: string[] = [];
      for (const u of friendlyHealers) {
        const deathAt = friendlyDeathAtByName.get(u.name);
        const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
        if (isDead) continue;

        const mana = getUnitManaAtTimestamp(u, tsMs);
        if (mana) {
          const pct =
            mana.max > 0 ? Math.round((mana.current / mana.max) * 100) : 0;
          friendlyParts.push(`${pid(u.name)}:${pct}%`);
        }
      }

      const enemyParts: string[] = [];
      for (const u of enemyHealers) {
        const deathAt = enemyDeathAtByName.get(u.name);
        const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
        if (isDead) continue;

        const mana = getUnitManaAtTimestamp(u, tsMs);
        if (mana) {
          const pct =
            mana.max > 0 ? Math.round((mana.current / mana.max) * 100) : 0;
          enemyParts.push(`${enemyPid(u.name)}:${pct}%`);
        }
      }

      if (friendlyParts.length > 0 || enemyParts.length > 0) {
        let manaParts: string;
        if (friendlyParts.length > 0 && enemyParts.length > 0) {
          manaParts = `friends ${friendlyParts.join(" ")} / enemies ${enemyParts.join(" ")}`;
        } else if (friendlyParts.length > 0) {
          manaParts = `friends ${friendlyParts.join(" ")}`;
        } else {
          manaParts = `enemies ${enemyParts.join(" ")}`;
        }
        addEntry(t, `${fmtTime(t)}  [MANA]   ${manaParts}`);
      }
    }
  }
}

// ── [DEATH] events ──────────────────────────────────────────────────────────

/**
 * A 形态(减伤核算)独立口径披露(#17b Task4 复核 Important #2)——每条
 * arith/immunity/mechanic 行各算各的,不建模同窗叠加。卡片头部已有中文版
 * 「逐条独立口径,不建模叠加」,prompt 面此前漏了同一句话;
 * buildMatchContext 的闭包在 auditLines 非空时把它塞进数组第一行。
 * causalLint 安全:陈述计算口径,不含因果动词。
 */
export const MITIGATION_AUDIT_INDEPENDENT_NOTE =
  "Mitigation audit note: each row below is an independent single-technique estimate — no stacking/interaction across rows is modeled";

/**
 * 减伤核算(A 形态)单行格式化(#17b Task4)——buildMatchContext 的
 * counterfactualOf 闭包与本文件的测试共用同一个格式化器,数字/措辞不重复
 * 定义第二遍(门规谓词即规范)。kind=arith 挡量已由 Task1
 * computeMitigationAudit 反推,这里只管渲染;maxHp 缺失时(blockedPctMaxHp
 * undefined)省略百分比括注,不外推。
 */
export function formatMitigationAuditLine(row: IMitigationAuditRow): string {
  const overlap = row.activeOverlapS.toFixed(1);
  if (row.kind === "arith") {
    const blockedK = Math.round((row.blockedAmount ?? 0) / 1000);
    const pctPart =
      row.blockedPctMaxHp !== undefined
        ? ` (≈${row.blockedPctMaxHp}% max HP)`
        : "";
    return `Mitigation audit: ${row.spellName} blocked ~${blockedK}k${pctPart} over ${overlap}s active`;
  }
  if (row.kind === "immunity") {
    const dmgK = Math.round((row.damageTakenDuringImmunity ?? 0) / 1000);
    return `Mitigation audit: ${row.spellName} immunity covered ${overlap}s (~${dmgK}k dmg observed during coverage)`;
  }
  return `Mitigation audit: ${row.spellName} active ${overlap}s (mechanic — redirect/reflect, not modeled in the arithmetic)`;
}

/**
 * 反事实(B/窄门,仅 decisive)单行格式化(#17b Task4)。causalLint 兼容:
 * 用假设式("would have")而非因果动词("led to/caused/resulted in")。
 * margin 数字直接引用 DECISIVE_MARGIN_PCT(Task1 单源常量),不重新定义。
 */
export function formatDecisiveCounterfactualLine(
  hit: ICounterfactualHit,
): string {
  const subject =
    hit.source === "missed-external" && hit.casterName
      ? `${hit.spellName} from ${hit.casterName}`
      : hit.spellName;
  return `Counterfactual (arithmetic, single-factor): ${subject} would have cut window damage below lethal (margin >${DECISIVE_MARGIN_PCT}% max HP)`;
}

/**
 * Emits friendly [DEATH] entries: unused-defensive / trinket-availability annotations,
 * a deferred resource snapshot, HP trajectory, and top damage sources in the final 10s.
 * `S` is the caller's deferred-snapshot placeholder type; `requestSnapshotPlaceholder`
 * and `addEntry` are passed in so the caller's closure state is preserved.
 */
export function emitFriendlyDeathEntries<S>(params: {
  friendlyDeaths: Array<{
    spec: string;
    name: string;
    atSeconds: number;
    note?: string;
  }>;
  unitsByName: Map<string, ICombatUnit>;
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  owner: ICombatUnit;
  ownerCDs: IMajorCooldownInfo[];
  teammateCDs: Array<{
    player: ICombatUnit;
    spec: string;
    cds: IMajorCooldownInfo[];
  }>;
  matchStartMs: number;
  pid: (name: string) => string;
  playerIdMap?: Map<string, number>;
  enemyIdMap?: Map<string, number>;
  /**
   * 减伤核算/反事实(#17b Task4):按 (死者名, 死亡时刻) 取一组已格式化好的
   * 行(auditLines/decisiveLines,已用 formatMitigationAuditLine /
   * formatDecisiveCounterfactualLine 渲染)。**必须带 atSeconds** ——同一
   * 玩家在同一场 combat 内死两次时,只按名字找会把两次死亡都渲染成第一次
   * 的数字(2026-07-30 复核发现的 critical bug,c.f. task-4-report.md 修复
   * 记录)。可选,缺省不出行——老调用零破坏。空数组同样不出行(诚实伦理:
   * 宁缺不占位)。
   */
  counterfactualOf?: (
    victimName: string,
    atSeconds: number,
  ) => {
    auditLines: string[];
    decisiveLines: string[];
  };
  requestSnapshotPlaceholder: (
    timeSeconds: number,
    forceFull?: boolean,
    bypassDebounce?: boolean,
  ) => S;
  addEntry: (timeSeconds: number, ...lines: (string | S)[]) => void;
}): void {
  const {
    friendlyDeaths,
    unitsByName,
    ccTrinketSummaries,
    owner,
    ownerCDs,
    teammateCDs,
    matchStartMs,
    pid,
    playerIdMap,
    enemyIdMap,
    counterfactualOf,
    requestSnapshotPlaceholder,
    addEntry,
  } = params;

  for (const death of friendlyDeaths) {
    const dyingUnit = unitsByName.get(death.name);
    let unusedDefensives = "";
    let trinketAvailable = false;
    if (dyingUnit) {
      const summary = ccTrinketSummaries.find(
        (s) => s.playerName === death.name,
      );
      if (
        summary &&
        (summary.trinketType === "Gladiator" ||
          summary.trinketType === "Adaptation")
      ) {
        const cooldownSec = summary.trinketCooldownSeconds;
        let lastUse: number | undefined;
        for (let i = summary.trinketUseTimes.length - 1; i >= 0; i--) {
          const t = summary.trinketUseTimes[i];
          if (t <= death.atSeconds) {
            lastUse = t;
            break;
          }
        }
        trinketAvailable =
          lastUse === undefined || death.atSeconds - lastUse >= cooldownSec;
      }

      // F145: Teammate Defensive Persistence Check — find big buttons that were available at death
      const allPlayerCDs = [
        ...ownerCDs.filter(() => owner.name === death.name),
        ...teammateCDs
          .filter((tc) => tc.player.name === death.name)
          .flatMap((tc) => tc.cds),
      ];

      const isLockedOut = summary
        ? wasLockedOutThroughWindow(summary, death.atSeconds)
        : false;
      const forbearance = selfForbearanceActiveAt(
        dyingUnit,
        Array.from(unitsByName.values()),
        death.atSeconds,
        matchStartMs,
      );

      const readyAtDeath = allPlayerCDs
        .filter((cd) => cd.tag === "Defensive" || cd.tag === "External")
        // 单源谓词(BACKLOG #18 Minor #3):死亡时刻可用性与
        // candidateFindings 的 death-unused-defensive / external-unused
        // 共享同一判定,不再走 availableWindows(该表另含 GRACE_SECONDS
        // 短窗裁剪,是为"更廉价替代品"建议服务的,不适用于死亡时点查询)。
        .filter((cd) => cdAvailableAt(cd, death.atSeconds))
        // B12/C3: only flag if it was actually usable (not locked out through the lethal window, or is a CC-breaking defensive)
        .filter(
          (cd) => !isLockedOut || USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId),
        )
        // Forbearance: a paladin can't press Spellwarding/BoP/LoH/Divine Shield if it self-applied
        // Forbearance in the last 30s — don't list those as "unused" (false accusation).
        .filter((cd) => !(forbearance && FORBEARANCE_GATED_IDS.has(cd.spellId)))
        .map((cd) => cd.spellName);

      if (readyAtDeath.length > 0) {
        unusedDefensives = ` (Unused: ${readyAtDeath.join(", ")})`;
      }
    }

    const trinketPart = trinketAvailable ? " (PvP Trinket available)" : "";
    const notePart = death.note ? ` [${death.note}]` : "";
    const deathLines: (string | S)[] = [
      `${fmtTime(death.atSeconds)}  [DEATH]  ${pid(death.name)} (${death.spec} — friendly)${unusedDefensives}${trinketPart}${notePart}`,
      // 锚定在渲染时刻:这条 [RES] 紧贴上面那行 [DEATH],自己不带时间戳,
      // 读者(和门规)只能把它读成与死亡同刻。此前取 T-3s(无注释、随
      // c54d051 整体移植带入),于是冷却若恰在这 3 秒内转好,台账写"冷却中"
      // 而同刻的 DEATHS WITH MISSED OPTIONS 写"available" —— 两边各自对
      // 自己的时刻都没算错,是渲染把两个时刻并置成了一个。
      // 同一行的 unusedDefensives 与 MISSED OPTIONS 块都在 death.atSeconds
      // 求值,这里跟它们对齐。2026-07-20 全语料:3/1245 场因此自相矛盾。
      requestSnapshotPlaceholder(death.atSeconds, true, true),
    ];
    if (dyingUnit) {
      // HP trajectory
      const checkpoints = [15, 10, 5, 3, 2, 1];
      const trajectory: string[] = [];
      for (const secondsBefore of checkpoints) {
        // Deaths are critical windows: the surrounding [STATE] ticks sample at
        // ±1.5s — use the identical radius so a trace checkpoint and a STATE
        // line about the same second resolve to the same advanced sample.
        // Integer-second grid (floor) — the same instants the [STATE] ticks
        // sample — so a checkpoint and a co-second STATE line resolve to the
        // SAME advanced sample and can never print different numbers.
        const pct = getHpPercentAtTime(
          dyingUnit,
          Math.floor(death.atSeconds) - secondsBefore,
          matchStartMs,
          1_500,
        );
        if (pct !== null)
          trajectory.push(`${Math.round(pct)}% at T-${secondsBefore}s`);
      }
      if (trajectory.length > 0) {
        deathLines.push(`               HP: ${trajectory.join(" → ")} → dead`);
      }

      // Top damage sources in final COUNTERFACTUAL_WINDOW_S seconds — same
      // window as the death-recap counterfactual (#17b Task4)/M-1 hardening:
      // uses shared helper to avoid duplication, and the window length is
      // derived from the constant (not a sibling literal) so the caption
      // can't silently drift from the counterfactual math it describes.
      const deathMs = matchStartMs + death.atSeconds * 1000;
      const topSources = getTopDamageSourcesInWindow(
        dyingUnit,
        deathMs,
        COUNTERFACTUAL_WINDOW_S * 1000,
        3,
        playerIdMap,
        enemyIdMap,
      );
      if (topSources.length > 0) {
        deathLines.push(
          `               Top damage in final ${COUNTERFACTUAL_WINDOW_S}s: ${topSources.join(", ")}`,
        );
      }

      // Mitigation audit / decisive counterfactual (#17b Task4) — caller
      // (buildMatchContext) already ran Task1's counterfactual.ts functions
      // and formatted the lines via formatMitigationAuditLine /
      // formatDecisiveCounterfactualLine; we just thread + indent them here.
      // Omitted param or empty arrays → no lines (honest-by-default, no
      // placeholder for the silent marginal/fatal tiers).
      if (counterfactualOf) {
        const { auditLines, decisiveLines } = counterfactualOf(
          death.name,
          death.atSeconds,
        );
        for (const line of auditLines)
          deathLines.push(`               ${line}`);
        for (const line of decisiveLines)
          deathLines.push(`               ${line}`);
      }
    }

    addEntry(death.atSeconds, ...deathLines);
  }
}

/**
 * Emits enemy [DEATH] entries: the death line, a [ROSTER] removal line, a deferred
 * resource snapshot, HP trajectory, and top damage sources in the final 10s.
 */
export function emitEnemyDeathEntries<S>(params: {
  enemyDeaths: Array<{ spec: string; name: string; atSeconds: number }>;
  unitsByName: Map<string, ICombatUnit>;
  matchStartMs: number;
  enemyPid: (name: string) => string;
  playerIdMap?: Map<string, number>;
  enemyIdMap?: Map<string, number>;
  requestSnapshotPlaceholder: (
    timeSeconds: number,
    forceFull?: boolean,
    bypassDebounce?: boolean,
  ) => S;
  addEntry: (timeSeconds: number, ...lines: (string | S)[]) => void;
}): void {
  const {
    enemyDeaths,
    unitsByName,
    matchStartMs,
    enemyPid,
    playerIdMap,
    enemyIdMap,
    requestSnapshotPlaceholder,
    addEntry,
  } = params;

  for (const death of enemyDeaths) {
    const dyingUnit = unitsByName.get(death.name);
    const deathLines: (string | S)[] = [
      `${fmtTime(death.atSeconds)}  [DEATH]  ${enemyPid(death.name)} (${death.spec} — enemy)`,
      `${fmtTime(death.atSeconds)}  [ROSTER]  enemy ${enemyPid(death.name)} removed (dead)`,
      // 锚定在渲染时刻:这条 [RES] 紧贴上面那行 [DEATH],自己不带时间戳,
      // 读者(和门规)只能把它读成与死亡同刻。此前取 T-3s(无注释、随
      // c54d051 整体移植带入),于是冷却若恰在这 3 秒内转好,台账写"冷却中"
      // 而同刻的 DEATHS WITH MISSED OPTIONS 写"available" —— 两边各自对
      // 自己的时刻都没算错,是渲染把两个时刻并置成了一个。
      // 同一行的 unusedDefensives 与 MISSED OPTIONS 块都在 death.atSeconds
      // 求值,这里跟它们对齐。2026-07-20 全语料:3/1245 场因此自相矛盾。
      requestSnapshotPlaceholder(death.atSeconds, true, true),
    ];

    if (dyingUnit) {
      // HP trajectory
      const checkpoints = [15, 10, 5, 3, 2, 1];
      const trajectory: string[] = [];
      for (const secondsBefore of checkpoints) {
        // Deaths are critical windows: the surrounding [STATE] ticks sample at
        // ±1.5s — use the identical radius so a trace checkpoint and a STATE
        // line about the same second resolve to the same advanced sample.
        // Integer-second grid (floor) — the same instants the [STATE] ticks
        // sample — so a checkpoint and a co-second STATE line resolve to the
        // SAME advanced sample and can never print different numbers.
        const pct = getHpPercentAtTime(
          dyingUnit,
          Math.floor(death.atSeconds) - secondsBefore,
          matchStartMs,
          1_500,
        );
        if (pct !== null)
          trajectory.push(`${Math.round(pct)}% at T-${secondsBefore}s`);
      }
      if (trajectory.length > 0) {
        deathLines.push(`               HP: ${trajectory.join(" → ")} → dead`);
      }

      // Top damage sources in final COUNTERFACTUAL_WINDOW_S seconds — derived
      // from the constant (see friendly-death twin above / M-1 hardening).
      const deathMs = matchStartMs + death.atSeconds * 1000;
      const topSources = getTopDamageSourcesInWindow(
        dyingUnit,
        deathMs,
        COUNTERFACTUAL_WINDOW_S * 1000,
        3,
        playerIdMap,
        enemyIdMap,
      );
      if (topSources.length > 0) {
        deathLines.push(
          `               Top damage in final ${COUNTERFACTUAL_WINDOW_S}s: ${topSources.join(", ")}`,
        );
      }
    }

    addEntry(death.atSeconds, ...deathLines);
  }
}
