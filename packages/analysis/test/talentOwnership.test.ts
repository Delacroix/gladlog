/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BACKLOG #23-1 天赋感知(GitHub issue #8)。
 *
 * 单源谓词 talentOwnershipOf 的三态契约 + deathOutcome 消费方回归:
 * 「kit 表声称职业理论上有 X」≠「这个玩家有 X」。关键案例:真言术障
 * (Power Word: Barrier, 62618)是 Disc 牧师 spec 树 82564 号择一节点
 * (entry 103687 = PWB vs 116182 = Ultimate Penitence),绝大多数玩家不选。
 *
 * Solo Shuffle 粒度契约:天赋轮间可变,谓词是所传 unit 的纯函数,
 * 逐轮判定互不串——见「轮间不同天赋」用例。
 */
import { CombatUnitSpec, LogEvent } from "@gladlog/parser-compat";

import { ensureTalentData } from "../src/data/talentStrings";
import {
  buildDeathOutcomeSummary,
  formatDeathOutcomeForContext,
} from "../src/utils/deathOutcomeAnalysis";
import {
  talentOwnershipFromTables,
  talentOwnershipOf,
} from "../src/utils/talentOwnership";
import { makeSpellCastEvent, makeUnit } from "./ported/testHelpers";

const MATCH_START = 1_000_000;

const PWB = "62618"; // Power Word: Barrier — Disc spec-tree choice node 82564
const PWB_NODE = 82564;
const PWB_ENTRY = 103687; // choice entry granting PWB
const UP_ENTRY = 116182; // sibling choice entry (Ultimate Penitence)

/** Disc priest whose choice node 82564 picked `entry`. */
function discPriest(id: string, entry: number | null, extra: any = {}) {
  return makeUnit(id, {
    spec: CombatUnitSpec.Priest_Discipline,
    info: {
      teamId: "0",
      specId: 256,
      talents: entry === null ? [] : [{ id1: PWB_NODE, id2: entry, count: 1 }],
      pvpTalents: [],
    } as any,
    ...extra,
  });
}

beforeAll(async () => {
  await ensureTalentData();
});

describe("talentOwnershipOf 三态", () => {
  it("择一节点选中 PWB → yes", () => {
    expect(talentOwnershipOf(discPriest("p1", PWB_ENTRY), PWB)).toBe("yes");
  });

  it("择一节点选了另一支(Ultimate Penitence)→ no", () => {
    expect(talentOwnershipOf(discPriest("p1", UP_ENTRY), PWB)).toBe("no");
  });

  it("老档无 info → unknown(绝不误杀)", () => {
    const u = makeUnit("p1", { spec: CombatUnitSpec.Priest_Discipline });
    expect(talentOwnershipOf(u, PWB)).toBe("unknown");
  });

  it("有 info 但 talents 空 → unknown", () => {
    expect(talentOwnershipOf(discPriest("p1", null), PWB)).toBe("unknown");
  });

  it("既不在树里也不在 PvP 池里 → 基线技能,官方数据排除法判 yes", () => {
    // 999999 不是真实技能,但谓词契约是「调用方已先过 spec 白名单」——
    // 排除法只回答天赋门控,不负责职业归属(见 talentOwnershipFromTables 注释)。
    expect(talentOwnershipOf(discPriest("p1", UP_ENTRY), "999999")).toBe("yes");
    // 真实基线例:圣骑士的圣盾术(642)不在 Ret 树/池中 → yes,连 info 都不需要
    const ret = makeUnit("r1", { spec: CombatUnitSpec.Paladin_Retribution });
    expect(talentOwnershipOf(ret, "642")).toBe("yes");
  });

  it("PvP 池:池内技能未选(pvpTalents 在场)→ no;选了 → yes;老档无 info → unknown", () => {
    // 214205 在 Disc(256)官方 PvP 池中
    const notTaken = discPriest("p1", UP_ENTRY); // pvpTalents: []
    expect(talentOwnershipOf(notTaken, "214205")).toBe("no");
    const taken = makeUnit("p2", {
      spec: CombatUnitSpec.Priest_Discipline,
      info: { talents: [], pvpTalents: ["214205"] } as any,
    });
    expect(talentOwnershipOf(taken, "214205")).toBe("yes");
    const oldArchive = makeUnit("p3", {
      spec: CombatUnitSpec.Priest_Discipline,
    });
    expect(talentOwnershipOf(oldArchive, "214205")).toBe("unknown");
  });

  it("PvP 池 ActionBar 载体:神牧 215982 授予 215769,选了载体两个 id 都判 yes", () => {
    const holy = (pvp: string[]) =>
      makeUnit("h1", {
        spec: CombatUnitSpec.Priest_Holy,
        info: { talents: [], pvpTalents: pvp } as any,
      });
    expect(talentOwnershipOf(holy(["215982"]), "215769")).toBe("yes");
    expect(talentOwnershipOf(holy(["215982"]), "215982")).toBe("yes");
    expect(talentOwnershipOf(holy([]), "215769")).toBe("no");
  });

  it("英雄树择一:选中支判 yes,另一支判 no", () => {
    // Disc 英雄树 choice 节点 94675:117278→440670(Divine Feathers)
    // vs 119331→440669(Save the Day)
    const hero = (entry: number) =>
      makeUnit("p1", {
        spec: CombatUnitSpec.Priest_Discipline,
        info: {
          talents: [{ id1: 94675, id2: entry, count: 1 }],
          pvpTalents: [],
        } as any,
      });
    expect(talentOwnershipOf(hero(117278), "440670")).toBe("yes");
    expect(talentOwnershipOf(hero(117278), "440669")).toBe("no");
    expect(talentOwnershipOf(hero(119331), "440669")).toBe("yes");
    expect(talentOwnershipOf(hero(119331), "440670")).toBe("no");
  });

  it("跨 build 守卫:loadout 含当前树无法解析的节点 → 树判定降级 unknown", () => {
    // 老 build 的 node id(9999999 不存在)混入 → 全 loadout 不可信,
    // PWB 不判 no(全库审计:圣佑术 14 例矛盾全是老 build 轮)
    const u = makeUnit("p1", {
      spec: CombatUnitSpec.Priest_Discipline,
      info: {
        talents: [
          { id1: PWB_NODE, id2: UP_ENTRY, count: 1 },
          { id1: 9999999, id2: 1, count: 1 },
        ],
        pvpTalents: [],
      } as any,
    });
    expect(talentOwnershipOf(u, PWB)).toBe("unknown");
  });

  it("free/entry 节点(COMBATANT_INFO 不上报的自动授予)缺席 → unknown 不判 no", () => {
    // 增强萨(263)的链闪 188443 挂在 entryNode 103583 上,214/214 施法者
    // loadout 都没有该节点 —— 判 no 就是反向误杀
    const enh = makeUnit("s1", {
      spec: CombatUnitSpec.Shaman_Enhancement,
      info: {
        // 真实节点(80958 风怒武器)构成全解析 loadout,但不含链闪节点
        talents: [{ id1: 80958, id2: 101823, count: 1 }],
        pvpTalents: [],
      } as any,
    });
    expect(talentOwnershipOf(enh, "188443")).toBe("unknown");
  });

  it("表判据与生产谓词分工:FromTables 不吃施法证据,talentOwnershipOf 吃", () => {
    const u = discPriest("p1", UP_ENTRY, {
      spellCastEvents: [makeSpellCastEvent(PWB, MATCH_START + 5_000, "p1")],
    });
    expect(talentOwnershipFromTables(u, PWB)).toBe("no");
    expect(talentOwnershipOf(u, PWB)).toBe("yes");
  });

  it("本轮实际施放过 → yes,压倒表数据(没点天赋也判有)", () => {
    const u = discPriest("p1", UP_ENTRY, {
      spellCastEvents: [makeSpellCastEvent(PWB, MATCH_START + 5_000, "p1")],
    });
    expect(talentOwnershipOf(u, PWB)).toBe("yes");
  });

  it("选中的 PvP 天赋授予 → yes;PvP 天赋替换掉的基线技能 → no", () => {
    const withPvp = makeUnit("p1", {
      spec: CombatUnitSpec.Priest_Discipline,
      info: { talents: [], pvpTalents: ["205800"] } as any,
    });
    expect(talentOwnershipOf(withPvp, "205800")).toBe("yes");
    // PVP_TALENT_REPLACES_GENERATED: 205800 replaces 355
    expect(talentOwnershipOf(withPvp, "355")).toBe("no");
  });

  it("非数字 spec → unknown", () => {
    const u = makeUnit("p1", { spec: CombatUnitSpec.None });
    (u as any).info = { talents: [{ id1: 1, id2: 1, count: 1 }] };
    expect(talentOwnershipOf(u, PWB)).toBe("unknown");
  });
});

describe("deathOutcome 天赋门(issue #8 回归)", () => {
  function makeCombat() {
    return {
      startTime: MATCH_START,
      startInfo: { zoneId: "1505" },
    };
  }
  function withDeath(u: any, atMs: number) {
    u.deathRecords = [
      { timestamp: atMs, event: LogEvent.UNIT_DIED, parameters: [] },
    ];
    return u;
  }

  it("Disc 牧队友没点 PWB → missedExternals 不再列 PWB;点了 → 照列", () => {
    const victim = withDeath(
      makeUnit("v1", { spec: CombatUnitSpec.Warrior_Arms, name: "Victim" }),
      MATCH_START + 30_000,
    );
    const without = discPriest("h1", UP_ENTRY, { name: "PriestNoPWB" });
    const withTalent = discPriest("h2", PWB_ENTRY, { name: "PriestPWB" });

    const resNo = buildDeathOutcomeSummary(
      makeCombat() as any,
      [victim, without],
      [],
    );
    const extNo = resNo.events.flatMap((e) => e.missedExternals);
    expect(extNo.some((e) => e.spellId === PWB)).toBe(false);

    const resYes = buildDeathOutcomeSummary(
      makeCombat() as any,
      [victim, withTalent],
      [],
    );
    const extYes = resYes.events.flatMap((e) => e.missedExternals);
    expect(extYes.some((e) => e.spellId === PWB)).toBe(true);
    // 渲染文本随之干净:没点的那场绝不出现 "had Power Word: Barrier available"
    expect(formatDeathOutcomeForContext(resNo)).not.toContain(
      "Power Word: Barrier",
    );
  });

  it("老档(队友无 info)→ unknown 不过滤,行为与门前一致", () => {
    const victim = withDeath(
      makeUnit("v1", { spec: CombatUnitSpec.Warrior_Arms, name: "Victim" }),
      MATCH_START + 30_000,
    );
    const legacyPriest = makeUnit("h1", {
      spec: CombatUnitSpec.Priest_Discipline,
      name: "OldPriest",
    });
    const res = buildDeathOutcomeSummary(
      makeCombat() as any,
      [victim, legacyPriest],
      [],
    );
    const ext = res.events.flatMap((e) => e.missedExternals);
    expect(ext.some((e) => e.spellId === PWB)).toBe(true);
  });

  it("availableImmunities 同门:没点的天赋免疫不再声称可用,点了照列", () => {
    // Ice Block (45438) 是法师职业树天赋(node 62122, entry 80181)。
    // 12.1 树数据里 Divine Shield/Turtle/Dispersion/Netherwalk 都不在树中
    // (基线或数据缺席 → unknown 不过滤),Ice Block 是唯一可判 no 的免疫。
    const makeFrost = (talents: any[]) =>
      withDeath(
        makeUnit("m1", {
          spec: CombatUnitSpec.Mage_Frost,
          name: "Mage",
          info: { talents, pvpTalents: [] } as any,
        }),
        MATCH_START + 30_000,
      );
    // 真实的当前 build 节点(62115 Alter Time)——用假节点 id 会触发跨 build
    // 守卫(loadout 未全解析 → unknown 放行),那是另一条正确路径,不是本例。
    const without = makeFrost([{ id1: 62115, id2: 80174, count: 1 }]); // 不含 Ice Block
    const resNo = buildDeathOutcomeSummary(makeCombat() as any, [without], []);
    expect(
      resNo.events
        .flatMap((e) => e.availableImmunities)
        .some((i) => i.spellId === "45438"),
    ).toBe(false);

    const withIt = makeFrost([{ id1: 62122, id2: 80181, count: 1 }]);
    const resYes = buildDeathOutcomeSummary(makeCombat() as any, [withIt], []);
    expect(
      resYes.events
        .flatMap((e) => e.availableImmunities)
        .some((i) => i.spellId === "45438"),
    ).toBe(true);
  });

  it("Solo Shuffle 轮间不同天赋:两轮各自判定,互不串", () => {
    // 同名玩家,两轮两个独立 unit 对象:r1 点了 PWB,r2 没点。
    const victimR1 = withDeath(
      makeUnit("v1", { spec: CombatUnitSpec.Warrior_Arms, name: "Victim" }),
      MATCH_START + 30_000,
    );
    const victimR2 = withDeath(
      makeUnit("v1", { spec: CombatUnitSpec.Warrior_Arms, name: "Victim" }),
      MATCH_START + 30_000,
    );
    const priestR1 = discPriest("h1", PWB_ENTRY, { name: "SamePriest" });
    const priestR2 = discPriest("h1", UP_ENTRY, { name: "SamePriest" });

    const r1 = buildDeathOutcomeSummary(
      makeCombat() as any,
      [victimR1, priestR1],
      [],
    );
    const r2 = buildDeathOutcomeSummary(
      makeCombat() as any,
      [victimR2, priestR2],
      [],
    );
    expect(
      r1.events
        .flatMap((e) => e.missedExternals)
        .some((e) => e.spellId === PWB),
    ).toBe(true);
    expect(
      r2.events
        .flatMap((e) => e.missedExternals)
        .some((e) => e.spellId === PWB),
    ).toBe(false);
  });
});
