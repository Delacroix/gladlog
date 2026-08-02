import type { StoredMatchMeta } from "../../src/main/matchStore";
import { installFixtureBridge } from "../../src/renderer/src/fixtureBridge";

import { FIXED_NOW } from "./fixedNow";

// 单源在 ./fixedNow(零 import 的叶子模块,Playwright 的 Node 进程也能吃)。
// 这里再导出一次,浏览器侧的既有引用不必改。
export { FIXED_NOW };

const HOUR = 3_600_000;
const DAY = 86_400_000;

const BRACKETS = ["3v3", "3v3", "2v2", "Solo Shuffle"] as const;

/** 12 场确定性对局:跨 3 天、含胜负与评分涨跌,足以覆盖列表分组与仪表盘曲线。 */
export const DEMO_METAS: StoredMatchMeta[] = Array.from(
  { length: 12 },
  (_, i) => {
    const startTime = FIXED_NOW - Math.floor(i / 4) * DAY - (i % 4) * HOUR;
    return {
      id: `demo-${i}`,
      kind: "match" as const,
      bracket: BRACKETS[i % BRACKETS.length]!,
      zoneId: "1505",
      startTime,
      endTime: startTime + 180_000,
      result: i % 3 === 0 ? "Loss" : "Win",
      storedAt: startTime + 200_000,
      playerName: "Demo",
      playerRating: 1800 + i * 7,
    } as StoredMatchMeta;
  },
);

/** 装 fixture bridge,并把比赛列表换成确定性数据。 */
export function installAppShellFixture(): void {
  installFixtureBridge();
  const api = window.__gladlogFixture;
  if (!api) throw new Error("installFixtureBridge 未挂载 __gladlogFixture");
  const matches = api.matches as unknown as {
    list: () => Promise<StoredMatchMeta[]>;
    page: (o: { before?: number; limit: number }) => Promise<StoredMatchMeta[]>;
  };
  matches.list = async () => DEMO_METAS;
  matches.page = async (o) =>
    DEMO_METAS.filter((m) => o.before == null || m.startTime < o.before)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, o.limit);
}

/**
 * demo-* 是本文件造的 meta,底层 bridge 不认识它们,`matches.get` 一律返回
 * null —— 开发者页的对局检查器因此点谁都是空树。这里把 demo id 接到 fixture
 * 文档上。
 *
 * **只给 dev 场景用,不并进 installAppShellFixture**:matchlist 场景会自动
 * 选中第一场,一旦 get 有了返回值,它的右栏就从「选择一场对局」变成整份战报
 * —— 开发者页的改动不该顺手改掉别人的基线(2026-08-02 实测到这条基线漂移)。
 */
export function patchDemoMatchDocs(): void {
  const api = window.__gladlogFixture;
  if (!api) throw new Error("installFixtureBridge 未挂载 __gladlogFixture");
  const matches = api.matches as unknown as {
    get: (id: string) => Promise<unknown | null>;
  };
  const baseGet = matches.get.bind(matches);
  matches.get = async (id) =>
    id.startsWith("demo-") ? baseGet("fixture-match") : baseGet(id);
}

/** 首渲计时用的大号局:把真实样本的事件流按固定倍数复制并平移时间,
 *  形状与真实数据一致、规模放大 N 倍。确定性(无随机),但**不做截图基线**
 *  —— 它的价值是压出渲染耗时,不是锁定长相。 */
export function heavyMatch(
  base: Record<string, unknown>,
  factor = 12,
): Record<string, unknown> {
  const span = (base["endTime"] as number) - (base["startTime"] as number);
  const srcUnits = base["units"] as Record<string, Record<string, unknown>>;
  const units: Record<string, unknown> = {};
  for (const [id, u] of Object.entries(srcUnits)) {
    const grown: Record<string, unknown> = { ...u };
    for (const field of [
      "damageOut",
      "damageIn",
      "healOut",
      "absorbsOut",
      "casts",
      "auraEvents",
      "advancedSamples",
    ]) {
      const arr = u[field] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const out: unknown[] = [];
      for (let k = 0; k < factor; k++) {
        for (const e of arr) {
          const shifted: Record<string, unknown> = { ...e };
          if (typeof e["t"] === "number") shifted["t"] = e["t"] + k * span;
          if (typeof e["timestamp"] === "number")
            shifted["timestamp"] = (e["timestamp"] as number) + k * span;
          out.push(shifted);
        }
      }
      grown[field] = out;
    }
    units[id] = grown;
  }
  return {
    ...base,
    endTime: (base["startTime"] as number) + span * factor,
    units,
  };
}
