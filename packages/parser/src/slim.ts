import { decodeHpTail } from "./l1/decoders";
import type { GladMatchBase, GladUnit } from "./l3/model";

/**
 * doc 瘦身谓词(单源,2026-07-25 内存事故):
 * 事件 params 的 13+ 位是 advanced-logging 长尾(GUID/血量/坐标/装等),
 * 解析时已物化进 advancedSamples / hp / crit 等字段,落盘纯属重复 ——
 * 实测单场 shuffle doc 442MB 里 params 占 53%。全链唯一的 13+ 消费者是
 * 暴击统计(decodeHpTail),由 GladHpEvent.crit 物化字段接管。
 *
 * 出厂路径(compose)与旧肥档读取路径(matchStore)共用本谓词:
 * 旧档事件缺 crit → 先补物化再裁;幂等,已瘦档重跑零改动。
 */
export const SLIM_PARAMS_KEEP = 13;
/** 裁后仍保留内容的下标:旗标 [2]/[6]、法术学派 [10](convert 消费);
 * [11]/[12] 光环类型/层数、驱散/打断的 extra 法术(analysis 消费)——
 * 伤害/治疗事件的 [11]/[12] 是 advanced GUID,无下游消费者,一并清空。
 * 其余位(GUID/全名/法术名)与事件字段完全冗余,置空串。 */
const KEEP_ALL = new Set([2, 6, 10]);
const KEEP_NON_HP = new Set([11, 12]);

const EVENT_ARRAYS = [
  "damageOut",
  "damageIn",
  "healOut",
  "healIn",
  "absorbsOut",
  "absorbsIn",
  "casts",
  "castStarts",
  "petCasts",
  "auraEvents",
  "actionsOut",
  "actionsIn",
  "deaths",
  "unconsciousEvents",
] as const;

const HP_ARRAYS = new Set(["damageOut", "damageIn", "healOut", "healIn"]);

export function slimMatchParams(m: Pick<GladMatchBase, "units">): boolean {
  let changed = false;
  for (const u of Object.values(m.units) as GladUnit[]) {
    for (const key of EVENT_ARRAYS) {
      const arr = (u[key] ?? []) as {
        eventName?: string;
        params?: string[];
        crit?: boolean;
      }[];
      const isHp = HP_ARRAYS.has(key);
      for (const e of arr) {
        if (!Array.isArray(e.params)) continue;
        // 幂等标记:已瘦事件 params[0] 为空串且长度 ≤13
        if (e.params.length <= SLIM_PARAMS_KEEP && e.params[0] === "")
          continue;
        if (isHp && e.crit === undefined) {
          // 旧档补物化:裁掉 tail 前把暴击留下来
          const tail = decodeHpTail(e.eventName ?? "", e.params);
          if (tail) e.crit = tail.critical;
        }
        const slim: string[] = new Array(
          Math.min(SLIM_PARAMS_KEEP, e.params.length),
        ).fill("");
        for (let i = 0; i < slim.length; i++) {
          if (KEEP_ALL.has(i) || (!isHp && KEEP_NON_HP.has(i)))
            slim[i] = e.params[i] ?? "";
        }
        e.params = slim;
        changed = true;
      }
    }
  }
  return changed;
}
