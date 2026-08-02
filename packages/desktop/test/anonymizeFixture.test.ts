import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  anonymizeMatchDoc,
  playerAliasMap,
} from "../src/shared/anonymizeFixture";

const match = () => ({
  kind: "match",
  rawLines: ["raw1", "raw2"],
  units: {
    u1: { kind: "Player", name: "Realname-Area52", damageOut: [{ t: 1 }] },
    u2: { kind: "Player", name: "Otherguy-Illidan" },
    pet: { kind: "Pet", name: "Felhunter" },
  },
  deaths: [{ victim: "Realname-Area52", killer: "Otherguy-Illidan" }],
});

describe("anonymizeMatchDoc", () => {
  it("Player 名全局替换成稳定别名(同一名字在任何字段都是同一别名)", () => {
    const { text, players } = anonymizeMatchDoc(match());
    const out = JSON.parse(text);
    expect(players).toBe(2);
    expect(out.units.u1.name).toBe("PlayerA-Test");
    expect(out.units.u2.name).toBe("PlayerB-Test");
    // Names appearing in other fields must be replaced too —— changing only
    // units.name is the same as not anonymizing
    expect(out.deaths[0].victim).toBe("PlayerA-Test");
    expect(out.deaths[0].killer).toBe("PlayerB-Test");
  });

  it("真名一个字都不留在产物里", () => {
    const { text } = anonymizeMatchDoc(match());
    expect(text).not.toContain("Realname");
    expect(text).not.toContain("Otherguy");
    expect(text).not.toContain("Area52");
  });

  it("剥掉 rawLines(原始日志行整行含真名与账号信息)", () => {
    const out = JSON.parse(anonymizeMatchDoc(match()).text);
    expect(out.rawLines).toBeUndefined();
  });

  it("非 Player 单位保持原样(宠物/NPC 名不是 PII)", () => {
    const out = JSON.parse(anonymizeMatchDoc(match()).text);
    expect(out.units.pet.name).toBe("Felhunter");
  });

  it("shuffle:跨轮同一玩家用同一别名,每轮 rawLines 都剥掉", () => {
    const doc = {
      kind: "shuffle",
      rawLines: ["top"],
      rounds: [
        {
          rawLines: ["r0"],
          units: { a: { kind: "Player", name: "Realname-Area52" } },
        },
        {
          rawLines: ["r1"],
          units: { a: { kind: "Player", name: "Realname-Area52" } },
        },
      ],
    };
    const out = JSON.parse(anonymizeMatchDoc(doc).text);
    expect(out.rounds[0].units.a.name).toBe("PlayerA-Test");
    expect(out.rounds[1].units.a.name).toBe("PlayerA-Test");
    expect(out.rawLines).toBeUndefined();
    expect(out.rounds[0].rawLines).toBeUndefined();
    expect(out.rounds[1].rawLines).toBeUndefined();
  });

  it("超过 26 个玩家也不撞别名", () => {
    const units: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      units[`u${i}`] = { kind: "Player", name: `Name${i}-Realm` };
    }
    const aliases = Object.values(playerAliasMap({ units }));
    expect(new Set(aliases).size).toBe(30);
  });

  it("无 units 的畸形文档不抛", () => {
    expect(() => anonymizeMatchDoc({ kind: "match" })).not.toThrow();
  });

  it("keepNames:仍剥 rawLines,但保留真名(压测样本要 CN/特殊字符原名)", () => {
    const { text, players } = anonymizeMatchDoc(match(), { keepNames: true });
    const out = JSON.parse(text);
    expect(players).toBe(0);
    expect(out.units.u1.name).toBe("Realname-Area52");
    expect(out.rawLines).toBeUndefined();
  });
});

/**
 * Single-source check (the UI-side version of CLAUDE.md's "gate predicate is
 * the spec" rule): anonymization has two consumers —— the developer page's
 * "export anonymized fixture" action and scripts/make-report-fixture.mjs.
 * Two separate copies = the day one side misses an update, real player names
 * get committed into the repo.
 */
describe("脱敏逻辑单源", () => {
  it("make-report-fixture 脚本 import 共享脱敏函数,不自带一份", () => {
    const src = readFileSync(
      join(__dirname, "../scripts/make-report-fixture.mjs"),
      "utf-8",
    );
    expect(src).toMatch(/anonymizeFixture/);
    // The old hand-written replacement (text.split(...).join(alias)) must be
    // fully deleted by now
    expect(src).not.toMatch(/Player\$\{String\.fromCharCode/);
  });
});
