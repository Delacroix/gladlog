import { ICombatUnit, LogEvent } from "@gladlog/parser-compat";

import { spellEffectData } from "../data/spellEffectData";

/**
 * auraIntervals.ts —— 光环区间集(第四阶段④,WoWAnalyzer Auras 模式)。
 *
 * 把某单位身上的 aura 事件流(applied/dose/refresh/removed/broken)配对成
 * 区间,供 uptime 条、时点查询等一切「这个 buff 什么时候在身上」的消费方
 * 使用。谓词单源:配对逻辑只此一处。
 *
 * 2026-07-25 生产修正(用户实测「虚线从 0 秒起持续好几分钟」):
 *  1) 开段按 spellId+srcUnitId 分键 —— 单键时双来源同法术(两个牧师的盾/
 *     符文多实例)的第二个 APPLIED 被吞,其 REMOVED 落空产生 0→removeT
 *     幻影虚线(用户 10 场实测 2802 个落空 REMOVED,萦绕符文 ×876、
 *     寒冰箭 ×190);收段先精确键、再同法术任意键兜底。
 *  2) SPELL_AURA_APPLIED_DOSE 也开段(叠层光环首事件可为 DOSE)。
 *  3) 推断边界用**官方时长封顶**(spellEffectData.durationSeconds,正式
 *     数据):inferredStart 至多回推 D 秒,inferredEnd 至多延 D 秒 ——
 *     寒冰箭(8s)最多虚 8 秒;真言术:韧/竞技场准备这类长时长 buff 的
 *     「开局前已挂」语义不受影响。无官方时长 → 维持旧行为。
 *
 * 归一化留痕:inferredStart / inferredEnd 标记照旧,渲染方画虚线。
 */

export interface IAuraInterval {
  spellId: string;
  /** 英文名优先由消费方经 getEnglishSpellName 解析;这里存日志原文。 */
  spellName: string;
  srcUnitName: string;
  fromS: number;
  toS: number;
  inferredStart: boolean;
  inferredEnd: boolean;
}

const CLOSE_EVENTS = new Set<string>([
  LogEvent.SPELL_AURA_REMOVED,
  LogEvent.SPELL_AURA_BROKEN,
  LogEvent.SPELL_AURA_BROKEN_SPELL,
]);

const OPEN_EVENTS = new Set<string>([
  LogEvent.SPELL_AURA_APPLIED,
  "SPELL_AURA_APPLIED_DOSE",
]);

/** 官方光环时长(秒);无数据 → null(不封顶)。 */
function officialDurationS(spellId: string): number | null {
  const d = spellEffectData[spellId]?.durationSeconds;
  return typeof d === "number" && d > 0 ? d : null;
}

/**
 * 该单位身上(dest = 本单位)全部 aura 的区间集,按 fromS 升序。
 */
export function buildAuraIntervals(
  unit: ICombatUnit,
  combat: { startTime: number; endTime: number },
): IAuraInterval[] {
  const durationS = (combat.endTime - combat.startTime) / 1000;
  const rel = (ts: number) =>
    Math.min(durationS, Math.max(0, (ts - combat.startTime) / 1000));

  interface Open {
    fromS: number;
    inferredStart: boolean;
    spellName: string;
    srcUnitName: string;
  }
  const open = new Map<string, Open>();
  const keyOf = (spellId: string, srcUnitId: string) =>
    `${spellId}:${srcUnitId}`;
  const out: IAuraInterval[] = [];

  const events = [...unit.auraEvents]
    .filter((a) => a.destUnitId === unit.id && a.spellId)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const a of events) {
    const id = a.spellId!;
    const key = keyOf(id, a.srcUnitId ?? "");
    const ev = a.logLine.event as string;
    if (OPEN_EVENTS.has(ev)) {
      if (!open.has(key)) {
        open.set(key, {
          fromS: rel(a.timestamp),
          inferredStart: false,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
        });
      }
    } else if (ev === LogEvent.SPELL_AURA_REFRESH) {
      if (!open.has(key)) {
        // 已挂着但没见 APPLIED:回推至多官方时长
        const t = rel(a.timestamp);
        const d = officialDurationS(id);
        open.set(key, {
          fromS: d === null ? 0 : Math.max(0, t - d),
          inferredStart: true,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
        });
      }
    } else if (CLOSE_EVENTS.has(ev)) {
      // 收段:先精确键,再同法术任意来源兜底(REMOVED 的 src 常与
      // APPLIED 不一致/缺失,不能因此判成「开局前已挂」)
      let hitKey: string | null = open.has(key) ? key : null;
      if (hitKey === null) {
        for (const k of open.keys())
          if (k.startsWith(`${id}:`)) {
            hitKey = k;
            break;
          }
      }
      const o = hitKey === null ? undefined : open.get(hitKey);
      if (o && hitKey !== null) {
        open.delete(hitKey);
        out.push({
          spellId: id,
          spellName: o.spellName,
          srcUnitName: o.srcUnitName,
          fromS: o.fromS,
          toS: rel(a.timestamp),
          inferredStart: o.inferredStart,
          inferredEnd: false,
        });
      } else {
        // 开局前已挂,本场只看到它掉落;回推至多官方时长
        const t = rel(a.timestamp);
        const d = officialDurationS(id);
        out.push({
          spellId: id,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
          fromS: d === null ? 0 : Math.max(0, t - d),
          toS: t,
          inferredStart: true,
          inferredEnd: false,
        });
      }
    }
  }

  for (const [key, o] of open) {
    const id = key.slice(0, key.indexOf(":"));
    // 未见 REMOVED:延至多官方时长(短光环不再一路虚到比赛结束)
    const d = officialDurationS(id);
    out.push({
      spellId: id,
      spellName: o.spellName,
      srcUnitName: o.srcUnitName,
      fromS: o.fromS,
      toS: d === null ? durationS : Math.min(durationS, o.fromS + d),
      inferredStart: o.inferredStart,
      inferredEnd: true,
    });
  }

  return out.sort(
    (a, b) => a.fromS - b.fromS || a.spellId.localeCompare(b.spellId),
  );
}
