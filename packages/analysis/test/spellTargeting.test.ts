/**
 * GH #28: 「绝望祷言只能给自己加血,产品却在队友垂危时要求我用它」。
 *
 * 这个文件钉的是官方数据地基本身:DB2 `SpellEffect.ImplicitTarget` 生成的
 * 「够不够得着队友」表,以及它对手工外放表的双向一致性。生成脚本
 * (scripts/datagen/genSpellTargeting.ts)在写盘前就断言过同样两个方向 ——
 * 这里再钉一遍,是因为生成物会被提交进仓库,而下一次刷新数据的人不一定跑得动
 * 那个脚本(需要 57MB DB2 CSV)。
 */
import { describe, expect, it } from "vitest";

import { classMetadata } from "../src/data/classSpells";
import spellIdLists from "../src/data/spellIdLists";
import { SpellTag } from "../src/data/spellTypes";
import { hasOfficialTargeting, reachesAlly } from "../src/data/spellTargeting";

describe("reachesAlly(官方 ImplicitTarget)", () => {
  it("用户报的那一条:绝望祷言只作用于施法者", () => {
    expect(reachesAlly("19236")).toBe(false);
  });

  it("个人保命墙一律够不着队友", () => {
    for (const id of [
      "642", // 圣盾术
      "45438", // 寒冰屏障(法师 Ice Block)
      "871", // 盾墙
      "22812", // 树皮
      "118038", // 破釜沉舟(用户点名)
      "185311", // 猩红药水(用户点名)
      "11426", // 寒冰护体(用户点名)
      "363916", // 黑曜石鳞甲 —— dummy 效果陷阱:它有一条 Effect=3/目标21 的空槽
      "108271", // 星界转移
    ]) {
      expect(reachesAlly(id), `${id} 应判为够不着队友`).toBe(false);
    }
  });

  it("手工外放表的每一条都必须被官方数据认可(手工表只能证伪不能证全,这是反向对账)", () => {
    for (const id of spellIdLists.externalDefensiveSpellIds as string[]) {
      expect(reachesAlly(id), `${id} 在外放表里却被判为够不着队友`).toBe(true);
    }
  });

  it("官方数据补上了手工表漏掉的三条团队技(修法若只用手工表会误杀这些正确指控)", () => {
    // 都不在 externalDefensiveSpellIds 里,但确实作用于队友
    expect(reachesAlly("740")).toBe(true); // 宁静(经一跳 EffectTriggerSpell 157982)
    expect(reachesAlly("64843")).toBe(true); // 神圣赞美诗(64844)
    expect(reachesAlly("31821")).toBe(true); // 光环大师(目标 56 = 团队光环)
    expect(reachesAlly("97462")).toBe(true); // 集结呐喊 —— 全是 dummy 效果行的反向陷阱
    for (const id of ["740", "64843", "31821"]) {
      expect(
        (spellIdLists.externalDefensiveSpellIds as string[]).includes(id),
      ).toBe(false);
    }
  });

  it("完备性:classMetadata 里每一个防御 CD 都有官方 targeting 行(缺行=消费者只能退回手工表)", () => {
    const missing = classMetadata
      .flatMap((c) => c.abilities)
      .filter((a) => a.tags.includes(SpellTag.Defensive))
      .filter((a) => !hasOfficialTargeting(a.spellId))
      .map((a) => `${a.spellId}/${a.name}`);
    expect(missing).toEqual([]);
  });
});
