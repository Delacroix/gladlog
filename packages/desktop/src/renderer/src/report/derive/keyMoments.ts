import {
  analyzeBurstLedger,
  analyzePlayerCCAndTrinket,
  computeOwnerPositionEvents,
  DEFENSIVE_TAGS,
  detectHealingGaps,
  DR_LEVEL_LABEL,
  extractMajorCooldowns,
  type IDRInfo,
  isBurstConverted,
  isHealerSpec,
  isMeleeSpec,
  POSITION_MISTAKES,
  reconstructDispelSummary,
  reconstructEnemyCDTimeline,
  stayedInHadRealCost,
  trinketSpellIds,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

export type KeyMomentKind =
  | "death"
  | "burst-band"
  | "defensive"
  | "dispel"
  | "cc"
  | "heal-gap"
  | "position";

export interface KeyMoment {
  /** 相对秒(自 combat start)。 */
  t: number;
  /** burst-band 专用:带状区间终点。 */
  toT?: number;
  kind: KeyMomentKind;
  /** 两级时刻(P0-2):major = 死亡/爆发带(完整药丸),minor = 防御/驱散/
   * 控制(小字行,同类连发可折叠)。finding 卡永远 major 级。 */
  weight: "major" | "minor";
  side: "friendly" | "enemy";
  title: string;
  detail?: string;
  unitNames: string[];
  /** 跳转秒(= t),回放 seek 契约。 */
  jumpT: number;
}

const MAJOR_KINDS: ReadonlySet<KeyMomentKind> = new Set([
  "death",
  "burst-band",
]);

const TRINKETS = new Set<string>(trinketSpellIds);
const CC_MIN_S = 3;

const shortName = (n: string): string => n.split("-")[0] ?? n;

/** cc detail 的 DR 档位后缀(#10 T2)。谓词单源:直接用 analysis 的
 * DR_LEVEL_LABEL 文案,不在这里发明第二套措辞。"Full"(未被 DR 削)不加
 * 后缀——对绝大多数首次命中的 CC 都成立,逐条标"满时长"是噪声。 */
const drSuffix = (drInfo: IDRInfo | null): string =>
  drInfo && drInfo.level !== "Full"
    ? ` · DR:${DR_LEVEL_LABEL[drInfo.level]}`
    : "";

/**
 * 关键时刻轴数据(spec: 2026-07-18-ai-analysis-key-moment-axis-design)。
 * 六类事件(#10 T3 新增 heal-gap),谓词全部复用 analysis;每类独立
 * try/catch,单类失败不拖垮。
 */
export function deriveKeyMoments(
  source: ReportSource,
  ownerId?: string,
): KeyMoment[] {
  const out: Array<Omit<KeyMoment, "weight">> = [];
  let legacy: ReturnType<typeof toLegacySafe>;
  try {
    legacy = toLegacySafe(source);
  } catch {
    return [];
  }
  const start = legacy.startTime;
  const rel = (ms: number) => (ms - start) / 1000;
  const units = Object.values(legacy.units);
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  const petsOf = (side: typeof friends) => {
    const ids = new Set(side.map((u) => u.id));
    return units.filter((u) => u.ownerId && ids.has(u.ownerId));
  };
  const friendlyPets = petsOf(friends);
  const enemyPets = petsOf(enemies);
  const owner =
    (ownerId ? players.find((u) => u.id === ownerId) : undefined) ??
    players.find((u) => u.id === legacy.playerId) ??
    friends[0];
  // 走位块(下方)复用这三个——deepDive.ts:411 同款「顺手捕获,不重复算」。
  let enemyTl: ReturnType<typeof reconstructEnemyCDTimeline> | null = null;
  let ownerCds: ReturnType<typeof extractMajorCooldowns> | undefined;
  let ownerCcSummary: ReturnType<typeof analyzePlayerCCAndTrinket> | undefined;

  // death
  try {
    for (const u of players) {
      for (const d of u.deathRecords ?? []) {
        const side =
          u.reaction === CombatUnitReaction.Friendly ? "friendly" : "enemy";
        out.push({
          t: rel(d.timestamp),
          kind: "death",
          side,
          title: side === "friendly" ? "阵亡" : "击杀",
          unitNames: [u.name],
          jumpT: rel(d.timestamp),
        });
      }
    }
  } catch {
    /* 单类失败不拖垮 */
  }

  // burst-band:我方 = owner 爆发账本(isBurstConverted 单源标转化)
  try {
    if (owner && !isHealerSpec(owner.spec)) {
      const allies = friends.filter((u) => u.id !== owner.id);
      for (const b of analyzeBurstLedger(owner, allies, enemies, legacy)) {
        const t = b.dominantTarget;
        const converted = t !== null && isBurstConverted(t);
        out.push({
          t: b.fromSeconds,
          toT: b.toSeconds,
          kind: "burst-band",
          side: "friendly",
          title: converted ? "爆发(已转化)" : "爆发(未转化)",
          detail: t
            ? `${(t.damage / 1_000_000).toFixed(2)}M → ${shortName(t.unitName)}`
            : undefined,
          unitNames: [owner.name, ...(t ? [t.unitName] : [])],
          jumpT: b.fromSeconds,
        });
      }
    }
  } catch {
    /* 同上 */
  }
  // burst-band:敌方 = aligned burst windows(同 [OFFENSIVE WINDOW] 谓词)
  try {
    enemyTl = reconstructEnemyCDTimeline(enemies, legacy, owner, friends);
    for (const w of enemyTl.alignedBurstWindows) {
      out.push({
        t: w.fromSeconds,
        toT: w.toSeconds,
        kind: "burst-band",
        side: "enemy",
        title: "敌方爆发",
        detail: w.activeCDs.map((c) => c.spellName).join(" + "),
        unitNames: [...new Set(w.activeCDs.map((c) => c.playerName))],
        jumpT: w.fromSeconds,
      });
    }
  } catch {
    /* 同上 */
  }

  // defensive:我方大防御 CD 施放(Defensive/External 且非 throughput)+ 饰品
  try {
    for (const u of friends) {
      const cds = extractMajorCooldowns(u, legacy);
      if (u === owner) ownerCds = cds;
      for (const cd of cds) {
        if (!DEFENSIVE_TAGS.has(cd.tag) || cd.isThroughput) continue;
        for (const cast of cd.casts) {
          out.push({
            t: cast.timeSeconds,
            kind: "defensive",
            side: "friendly",
            title: cd.spellName,
            detail: cast.timingLabel,
            unitNames: [u.name],
            jumpT: cast.timeSeconds,
          });
        }
      }
      for (const c of u.spellCastEvents ?? []) {
        if (!c.spellId || !TRINKETS.has(c.spellId)) continue;
        out.push({
          t: rel(c.timestamp),
          kind: "defensive",
          side: "friendly",
          title: "交饰品",
          unitNames: [u.name],
          jumpT: rel(c.timestamp),
        });
      }
    }
  } catch {
    /* 同上 */
  }

  // dispel:Critical/High(F163 同源口径)
  try {
    const ds = reconstructDispelSummary(
      friends,
      enemies,
      legacy,
      friendlyPets,
      enemyPets,
    );
    for (const e of [...ds.allyCleanse, ...ds.ourPurges]) {
      if (e.priority !== "Critical" && e.priority !== "High") continue;
      out.push({
        t: e.timeSeconds,
        kind: "dispel",
        side: "friendly",
        title: `${e.dispelSpellName}(${e.priority})`,
        detail: `解掉 ${e.removedSpellName}`,
        unitNames: [e.sourceName, e.targetName],
        jumpT: e.timeSeconds,
      });
    }
  } catch {
    /* 同上 */
  }

  // cc:我方被控(≥3s 或触发饰品);控制成功(≥3s 或目标为治疗)
  try {
    for (const u of friends) {
      const s = analyzePlayerCCAndTrinket(u, enemies, legacy, enemyPets);
      if (u === owner) ownerCcSummary = s;
      for (const cc of s.ccInstances) {
        if (cc.durationSeconds < CC_MIN_S && cc.trinketState !== "used")
          continue;
        out.push({
          t: cc.atSeconds,
          kind: "cc",
          side: "enemy",
          title: `被控:${cc.spellName}`,
          detail: `${cc.durationSeconds.toFixed(0)}s${
            cc.trinketState === "used" ? " · 交饰品解" : ""
          }${drSuffix(cc.drInfo)}`,
          // 施法者 + 受控者都进 unitNames,回放才能同时高亮敌方施法者
          unitNames: [cc.sourceName, u.name],
          jumpT: cc.atSeconds,
        });
      }
    }
    for (const e of enemies) {
      const s = analyzePlayerCCAndTrinket(e, friends, legacy, friendlyPets);
      for (const cc of s.ccInstances) {
        if (cc.durationSeconds < CC_MIN_S && !isHealerSpec(e.spec)) continue;
        out.push({
          t: cc.atSeconds,
          kind: "cc",
          side: "friendly",
          title: `控制成功:${cc.spellName}`,
          detail: `${cc.durationSeconds.toFixed(0)}s → ${shortName(e.name)}${drSuffix(cc.drInfo)}`,
          unitNames: [cc.sourceName, e.name],
          jumpT: cc.atSeconds,
        });
      }
    }
  } catch {
    /* 同上 */
  }

  // heal-gap:治疗空窗(owner 为治疗时)——门规同谓词 detectHealingGaps,
  // 与 healerMetrics 的 healingGapSeconds/Count 共享同一检测器(#10 T3)。
  try {
    if (owner && isHealerSpec(owner.spec)) {
      for (const g of detectHealingGaps(owner, friends, enemies, legacy)) {
        out.push({
          t: g.fromSeconds,
          toT: g.toSeconds,
          kind: "heal-gap",
          side: "friendly",
          title: `治疗空窗 ${g.durationSeconds.toFixed(1)}s`,
          detail: `${g.mostDamagedSpec}(${shortName(g.mostDamagedName)})承受 ${Math.round(g.mostDamagedAmount / 1000)}k`,
          unitNames: [owner.name],
          jumpT: g.fromSeconds,
        });
      }
    }
  } catch {
    /* 同上 */
  }

  // position:走位失误(#10 T4)——三类真失误进轴,谓词与深挖 deepDive.ts 的
  // hasCoachableSignal 同源:KITED/SPLIT_PUSH/HEALER_TRAINED 不算失误(可能是
  // 正确判断或救不了),STAYED_IN 必须用 stayedInHadRealCost 证明付出了真实
  // HP 代价才进轴——不是「HP 100%→98% 也算失误」的噪声。
  if (owner && enemyTl) {
    try {
      // agy 复核实锤:ownerCds/ownerCcSummary 是「顺手捕获」,不是保证——若
      // friends 里排在 owner 前面的某个队友让 defensive/cc 块提前抛出,循环
      // 会在到达 owner 之前中止,两个变量永远停在 undefined。此处兜底直接
      // 现算 owner 自己的一份,不依赖前面的块跑没跑到 owner。
      const posEvents = computeOwnerPositionEvents({
        owner,
        enemies,
        combat: legacy,
        burstWindows: enemyTl.alignedBurstWindows,
        ownerCooldowns: ownerCds ?? extractMajorCooldowns(owner, legacy),
        ownerCCSummary:
          ownerCcSummary ??
          analyzePlayerCCAndTrinket(owner, enemies, legacy, enemyPets),
        isHealer: isHealerSpec(owner.spec),
        ownerIsMelee: isMeleeSpec(owner.spec),
        friends,
      });
      for (const e of posEvents) {
        // 白名单单源(analysis 的 POSITION_MISTAKES,deepDive.ts 同一份)——
        // KITED/SPLIT_PUSH/HEALER_TRAINED 不算「失误」,不进轴。STAYED_IN
        // 在此基础上再叠一道 stayedInHadRealCost(付出真实 HP 代价才算)。
        if (!POSITION_MISTAKES.has(e.type)) continue;
        if (
          e.type === "STAYED_IN" &&
          !stayedInHadRealCost(e.ownerHpMinPct, e.ownerHpStartPct)
        ) {
          continue;
        }
        const title =
          e.type === "STAYED_IN"
            ? "顶着爆发硬扛"
            : e.type === "MISSED_PUSH"
              ? "该压没压"
              : "CD 距离外";
        const detail =
          e.type === "STAYED_IN"
            ? `${e.startDistanceYards}→${e.endDistanceYards}yd 贴 ${shortName(e.nearestEnemyName ?? "")}${
                e.dangerLabel ? ` · ${e.dangerLabel}爆发` : ""
              }${
                e.ownerHpStartPct != null && e.ownerHpMinPct != null
                  ? ` · HP ${e.ownerHpStartPct}%→${e.ownerHpMinPct}%`
                  : ""
              }`
            : e.type === "MISSED_PUSH"
              ? `>${e.startDistanceYards}yd 脱节`
              : `${e.spellName ?? ""} · ${e.startDistanceYards}yd 外`;
        out.push({
          t: e.atSeconds,
          toT: e.toSeconds,
          kind: "position",
          side: "friendly",
          title,
          detail,
          unitNames: [owner.name],
          jumpT: e.atSeconds,
        });
      }
    } catch {
      /* 走位分析需高级日志/几何,缺则该类缺席 */
    }
  }

  return out
    .map((m): KeyMoment => ({
      ...m,
      weight: MAJOR_KINDS.has(m.kind) ? "major" : "minor",
    }))
    .sort((a, b) => a.t - b.t);
}
