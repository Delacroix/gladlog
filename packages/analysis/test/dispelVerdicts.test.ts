/**
 * 驱散裁定册的防腐测试 —— 照 `mitigationVerdicts.test.ts` 的纪律。
 *
 * 钉三件事:签字格式、值域、以及**键集恰好等于 2026-08-19 签字页上的
 * 27 个 id + 2026-08-30 用户单独裁定的 1 个(Landslide 355689)= 28** —— 少一行是丢签字,
 * 多一行是没签字就进表,两个方向都得红。
 */
import {
  DISPEL_VERDICTS,
  DISPEL_VERDICT_IDS,
  DISPEL_VERDICTS_SIGNED_ON,
  dispelVerdictOf,
  type DispelWorth,
} from "../src/data/dispelVerdicts";
import { getDispelType } from "../src/utils/dispelAnalysis";

const SIGNED = /^\d{4}-\d{2}-\d{2} user$/;
const WORTHS: DispelWorth[] = ["must", "worth", "situational", "skip"];

/** 签字页(artifact 002e4626,2026-08-19)上的全部行,逐字。 */
const SIGNED_IDS = [
  // 晕
  "853",
  "117526",
  "1234195",
  "179057",
  "30283",
  // 眩晕 / 变形
  "3355",
  "118",
  "28271",
  "28272",
  "6789",
  "51514",
  "217832",
  "82691",
  // 恐惧 / 迷惑
  "8122",
  "118699",
  "5484",
  "360806",
  "105421",
  "31661",
  "605",
  // 定身
  "122",
  "355689", // Landslide — 2026-08-30 user, same tier as Frost Nova (GH #24 tail)
  "102359",
  "339",
  // 诅咒
  "1714",
  "702",
  // 签字退出
  "12654",
  "392983",
];

describe("驱散裁定册:签字纪律", () => {
  it("签字日期与每条 approved/source 合规", () => {
    expect(DISPEL_VERDICTS_SIGNED_ON).toBe("2026-08-19");
    for (const [id, e] of Object.entries(DISPEL_VERDICTS)) {
      expect(e.approved, `${id} (${e.zh}) approved 格式`).toMatch(SIGNED);
      expect(e.source.trim().length, `${id} source 为空`).toBeGreaterThan(0);
      expect(e.zh.trim().length, `${id} 缺中文名`).toBeGreaterThan(0);
    }
  });

  it("值域:melee/ranged 四档;healer 四档或 self-impossible;afterDR 四档或 null", () => {
    for (const [id, e] of Object.entries(DISPEL_VERDICTS)) {
      expect(WORTHS, `${id} melee`).toContain(e.melee);
      expect(WORTHS, `${id} ranged`).toContain(e.ranged);
      expect([...WORTHS, "self-impossible"], `${id} healer`).toContain(
        e.healer,
      );
      if (e.afterDR !== null)
        expect(WORTHS, `${id} afterDR`).toContain(e.afterDR);
    }
  });

  it("键集恰好 = 签字页的 27 个 id + 2026-08-30 裁定的 1 个 = 28(双向)", () => {
    const have = [...DISPEL_VERDICT_IDS].sort();
    expect(have).toEqual([...SIGNED_IDS].sort());
    expect(have).toHaveLength(28);
  });

  it("结构裁定成立:每个 self-impossible 行都是硬控,每个保留 healer 格的行都不禁施法", () => {
    // 硬控 = 晕/眩晕/恐惧组;保留 = 定身/诅咒/退出组。用组的划分钉住,
    // 防止未来新行忘了做「治疗能不能自驱」的判断。
    const selfImpossible = SIGNED_IDS.slice(0, 20);
    const healerJudged = SIGNED_IDS.slice(20);
    for (const id of selfImpossible)
      expect(DISPEL_VERDICTS[id].healer, `${id} 应为 self-impossible`).toBe(
        "self-impossible",
      );
    for (const id of healerJudged)
      expect(
        DISPEL_VERDICTS[id].healer,
        `${id} 的 healer 格应为具体裁定`,
      ).not.toBe("self-impossible");
  });

  it("每个非退出行在官方数据里确实可驱散(getDispelType 非空)", () => {
    for (const [id, e] of Object.entries(DISPEL_VERDICTS)) {
      if (e.exitCandidate) continue;
      expect(
        getDispelType(id),
        `${id} (${e.zh}) 官方 dispelType 为空 —— 裁定了一个驱不了的东西`,
      ).not.toBeNull();
    }
  });

  it("undispellableWithCasterTalent 的官方天赋版 id 确实 dispelType=None", () => {
    // 冰冻陷阱 203337 / 禁锢 221527:官方把天赋版编码为独立 id 且不可驱。
    // 这条钉住「官方数据继续替我们处理」这个前提 —— 哪天数据刷新破坏它,
    // 这里先红,而不是等误报。
    expect(getDispelType("203337")).toBeNull();
    expect(getDispelType("221527")).toBeNull();
    expect(DISPEL_VERDICTS["3355"].undispellableWithCasterTalent).toBe(
      "203340",
    );
    expect(DISPEL_VERDICTS["217832"].undispellableWithCasterTalent).toBe(
      "205596",
    );
  });

  it("dispelVerdictOf:命中返回条目,未签字 id 返回 null", () => {
    expect(dispelVerdictOf("853")?.zh).toBe("制裁之锤");
    expect(dispelVerdictOf("589")).toBeNull(); // 暗言术:痛 —— DoT,按裁定不在表内
  });
});
