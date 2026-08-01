import { describe, expect, it } from "vitest";

import { deriveKeyMoments } from "../src/renderer/src/report/derive/keyMoments";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const base = loadRealMatchFixture();

// fixture 为 native 格式(deaths/casts),注入走 report.deathrecap.test 同款先例。
type NativeUnit = {
  id: string;
  name: string;
  kind: string;
  reaction: string;
  deaths: Array<Record<string, unknown>>;
  casts: Array<Record<string, unknown>>;
};

function friendlyPlayer(m: typeof base): NativeUnit {
  const u = Object.values(m.units).find(
    (u) =>
      (u as { kind?: string }).kind === "Player" &&
      (u as { reaction?: string }).reaction === "Friendly",
  );
  if (!u) throw new Error("fixture 无友方玩家");
  return u as unknown as NativeUnit;
}

describe("deriveKeyMoments", () => {
  it("裁剪 fixture 不抛,输出按 t 升序", () => {
    const ms = deriveKeyMoments(base as unknown as ReportSource);
    expect(Array.isArray(ms)).toBe(true);
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i]!.t).toBeGreaterThanOrEqual(ms[i - 1]!.t);
    }
  });

  it("注入死亡 → 产出 death 节点(side=friendly,t≈42)", () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const victim = friendlyPlayer(clone);
    victim.deaths.push({
      timestamp: clone.startTime + 42_000,
      eventName: "UNIT_DIED",
      spellId: 0,
      spellName: "",
      srcId: "",
      srcName: "",
      destId: victim.id,
      destName: victim.name,
      unconscious: false,
    });
    const ms = deriveKeyMoments(clone as unknown as ReportSource);
    const death = ms.find((m) => m.kind === "death" && m.side === "friendly");
    expect(death).toBeTruthy();
    expect(Math.round(death!.t)).toBe(42);
    expect(death!.unitNames[0]).toBe(victim.name);
  });

  it("注入治疗空窗(owner=治疗)→ 产出 heal-gap 节点(#10 T3)", () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const units = clone.units as Record<string, any>;
    // playerId 默认指向治疗(Player3-Test,Disc Priest);清空其施法/治疗输出,
    // 只留一次早期施法(6s,避开 B19 起手 5s 宽限),制造一个跨越大半场的空窗。
    const healer = units[clone.playerId];
    healer.casts = [
      {
        eventName: "SPELL_CAST_SUCCESS",
        spellId: 2061,
        spellName: "Flash Heal",
        timestamp: clone.startTime + 6_000,
        srcId: healer.id,
        srcName: healer.name,
        destId: healer.id,
        destName: healer.name,
      },
    ];
    healer.healOut = [];
    const teammate = Object.values(units).find(
      (u: any) => u.info && u.reaction === "Friendly" && u.id !== healer.id,
    ) as any;
    teammate.damageIn = [
      ...(teammate.damageIn ?? []),
      {
        eventName: "SPELL_DAMAGE",
        timestamp: clone.startTime + 20_000,
        spellId: 1,
        spellName: "Test",
        srcId: "enemy",
        srcName: "Enemy",
        destId: teammate.id,
        destName: teammate.name,
        amount: 1_000_000,
        effectiveAmount: 1_000_000,
      },
    ];
    const ms = deriveKeyMoments(clone as unknown as ReportSource);
    const gap = ms.find((m) => m.kind === "heal-gap");
    expect(gap).toBeTruthy();
    expect(gap!.side).toBe("friendly");
    expect(gap!.unitNames).toEqual([healer.name]);
    expect(gap!.title).toContain("治疗空窗");
  });

  it("非治疗 owner → 不出 heal-gap 节点(即便治疗本身有空窗)", () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const units = clone.units as Record<string, any>;
    const healer = units[clone.playerId];
    healer.casts = [
      {
        eventName: "SPELL_CAST_SUCCESS",
        spellId: 2061,
        spellName: "Flash Heal",
        timestamp: clone.startTime + 6_000,
        srcId: healer.id,
        srcName: healer.name,
        destId: healer.id,
        destName: healer.name,
      },
    ];
    healer.healOut = [];
    const teammate = Object.values(units).find(
      (u: any) => u.info && u.reaction === "Friendly" && u.id !== healer.id,
    ) as any;
    teammate.damageIn = [
      ...(teammate.damageIn ?? []),
      {
        eventName: "SPELL_DAMAGE",
        timestamp: clone.startTime + 20_000,
        spellId: 1,
        spellName: "Test",
        srcId: "enemy",
        srcName: "Enemy",
        destId: teammate.id,
        destName: teammate.name,
        amount: 1_000_000,
        effectiveAmount: 1_000_000,
      },
    ];
    // teammate 本身就是非治疗友方(见上方注入),直接拿它当 ownerId。
    const ms = deriveKeyMoments(clone as unknown as ReportSource, teammate.id);
    expect(ms.some((m) => m.kind === "heal-gap")).toBe(false);
  });

  it("注入饰品施法 → 产出 defensive 节点(交饰品)", () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const u = friendlyPlayer(clone);
    u.casts.push({
      spellId: 336126,
      spellName: "Gladiator's Medallion",
      timestamp: clone.startTime + 30_000,
      eventName: "SPELL_CAST_SUCCESS",
      srcId: u.id,
      srcName: u.name,
      destId: u.id,
      destName: u.name,
    });
    const ms = deriveKeyMoments(clone as unknown as ReportSource);
    const trinket = ms.find(
      (m) => m.kind === "defensive" && m.title === "交饰品",
    );
    expect(trinket).toBeTruthy();
    expect(Math.round(trinket!.t)).toBe(30);
    expect(trinket!.unitNames[0]).toBe(u.name);
  });
});

// #10 T5:恐慌性使用注记——门规谓词即规范,直接消费 analysis 的
// detectPanicDefensives(与死亡回顾 def_used 行同一份判定),不在渲染层重造。
describe("deriveKeyMoments — 恐慌性使用注记(#10 T5)", () => {
  function combatantInfo(specId: number) {
    return {
      teamId: 0,
      specId,
      personalRating: 1500,
      talents: [],
      pvpTalents: [],
      equipment: [],
      interestingAuras: [],
    };
  }

  /** 合成源:一个 Feral Druid 两次施放 Barkskin(22812,Defensive 60s CD)——
   * t=30s 孤立无伤害(恐慌:无敌方威胁+目标未受压),t=100s 前 2s 内被打 80k
   * (>60k DPS 压力阈值,判定为有效预留/非恐慌)。一敌一友即可,其余各段
   * 各自 try/catch,不影响 defensive 段判定。 */
  function buildPanicSource(): ReportSource {
    return {
      kind: "match",
      id: "test-panic-defensive",
      bracket: "2v2",
      zoneId: "0",
      startTime: 0,
      endTime: 200_000,
      playerId: "druid1",
      playerTeamId: 0,
      winningTeamId: null,
      result: "Lose",
      linesTotal: 0,
      linesDropped: 0,
      hasAdvancedLogging: true,
      timezone: "UTC",
      units: {
        druid1: {
          id: "druid1",
          name: "Druid1",
          kind: "Player",
          reaction: "Friendly",
          classId: 11, // Druid
          specId: 103, // Feral
          info: combatantInfo(103),
          casts: [
            {
              eventName: "SPELL_CAST_SUCCESS",
              spellId: 22812,
              spellName: "Barkskin",
              timestamp: 30_000,
              srcId: "druid1",
              srcName: "Druid1",
              destId: "druid1",
              destName: "Druid1",
            },
            {
              eventName: "SPELL_CAST_SUCCESS",
              spellId: 22812,
              spellName: "Barkskin",
              timestamp: 100_000,
              srcId: "druid1",
              srcName: "Druid1",
              destId: "druid1",
              destName: "Druid1",
            },
          ],
          damageIn: [
            {
              eventName: "SPELL_DAMAGE",
              timestamp: 98_000,
              spellId: 1,
              spellName: "Test",
              srcId: "enemy1",
              srcName: "Enemy1",
              destId: "druid1",
              destName: "Druid1",
              amount: 80_000,
              effectiveAmount: 80_000,
            },
          ],
        },
        enemy1: {
          id: "enemy1",
          name: "Enemy1",
          kind: "Player",
          reaction: "Hostile",
          classId: 1,
          specId: 71,
          info: combatantInfo(71),
        },
      },
    } as unknown as ReportSource;
  }

  it("同秒(同一次施放)→ detail 追加「恐慌性使用」;异秒(有真实压力的另一次施放)→ 不追加", () => {
    const ms = deriveKeyMoments(buildPanicSource());
    const barkskinMoments = ms.filter(
      (m) => m.kind === "defensive" && m.title === "Barkskin",
    );
    expect(barkskinMoments).toHaveLength(2);

    const panicMoment = barkskinMoments.find((m) => Math.round(m.t) === 30);
    const pressuredMoment = barkskinMoments.find(
      (m) => Math.round(m.t) === 100,
    );
    expect(panicMoment).toBeTruthy();
    expect(pressuredMoment).toBeTruthy();
    expect(panicMoment!.detail).toContain("恐慌性使用");
    expect(panicMoment!.spellId).toBe("22812");
    expect(pressuredMoment!.detail ?? "").not.toContain("恐慌性使用");
  });
});
