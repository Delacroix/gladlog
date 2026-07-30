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

describe("锚点(游戏事实,2026-07 人审后钉死)", () => {
  // 三条锚点均经人审确认:22812/33206 直接来自 DB2 12.1.0.68629 aura-87
  // 行(SpellID 即白名单 id);642 为 DB2 aura-39(学派免疫)行,按 spec
  // 免疫语义拍板 pct=100 走 OVERRIDES。
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
