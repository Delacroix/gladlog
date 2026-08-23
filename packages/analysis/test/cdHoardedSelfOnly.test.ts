/**
 * GH #28 的核心回归:cd-hoarded 不许拿「够不着队友的技能」指控你没救队友。
 *
 * 用户原话:「我玩牧师,绝望祷言全场没用,然后我队友生命垂危的时候我应该用 ——
 * 这技能只能给自己加血。」下面第一条用例就是这句话的机制化复现。
 *
 * 为什么探针要「诚实」:cdHoardedEvents 把限制通过 `crisisMomentAt` 的第三个参数
 * (onlyUnitName)下发,生产接线转给 friendlyCrisisMomentInWindow。测试里如果写
 * 一个吞掉第三个参数的桩,门就测不出来 —— 所以这里的桩必须真的按 onlyUnitName
 * 过滤,和生产同构。
 */
import { ensureAnalysisData } from "../src/data/ensure";
import { beforeAll, describe, expect, it } from "vitest";

import { cdHoardedEvents } from "../src/analysis/candidates/cooldownTiming";

const OWNER = { id: "h", name: "Healer-R" };
/** 转好后一直没按,直到战斗结束(lateS 60 ≥ CD_HOARD_MIN_LATE_S=45) */
const window60 = { fromSeconds: 100, toSeconds: 160, durationSeconds: 60 };

/** 诚实探针:窗口内 Ally-R 掉到 13%,owner 自己掉到 20%。 */
const honestProbe =
  (allyHp = 13, ownerHp = 20) =>
  (from: number, to: number, onlyUnitName?: string) => {
    void from;
    const samples = [
      { t: 120, unitName: "Ally-R", hpPct: allyHp },
      { t: 130, unitName: OWNER.name, hpPct: ownerHp },
    ].filter((s) => onlyUnitName === undefined || s.unitName === onlyUnitName);
    if (samples.length === 0) return null;
    const worst = samples.reduce((a, b) => (b.hpPct < a.hpPct ? b : a));
    void to;
    return worst;
  };

const cd = (spellId: string, spellName: string) => ({
  spellId,
  spellName,
  casts: [{ timeSeconds: 0 }],
  availableWindows: [window60],
});

// 官方数据动态载入:先 await 聚合入口(与 prompt 路径同一契约)
beforeAll(async () => {
  await ensureAnalysisData();
});

describe("cd-hoarded × 够不着队友的技能(GH #28)", () => {
  it("绝望祷言 + 队友垂危 → 0 条(自愈技能救不了别人的血条)", () => {
    const evts = cdHoardedEvents(
      [cd("19236", "Desperate Prayer")],
      OWNER,
      // 队友 13%,owner 自己全程健康(35% 门槛之上)
      { crisisMomentAt: honestProbe(13, 90) },
    );
    expect(evts).toEqual([]);
  });

  it("绝望祷言 + owner 自己垂危 → 仍然出 1 条,且危机单位是 owner 本人", () => {
    const evts = cdHoardedEvents([cd("19236", "Desperate Prayer")], OWNER, {
      crisisMomentAt: honestProbe(13, 20),
    });
    expect(evts).toHaveLength(1);
    expect(evts[0].facts["crisisUnit"]).toBe(OWNER.name);
    // 队友那 13% 不能被拿来当这条自愈技能的罪证
    expect(evts[0].facts["crisisHpPct"]).toBe("20");
  });

  it("能作用到队友的 CD(宁静)+ 队友垂危 → 照常出,且引用队友", () => {
    const evts = cdHoardedEvents([cd("740", "Tranquility")], OWNER, {
      crisisMomentAt: honestProbe(13, 90),
    });
    expect(evts).toHaveLength(1);
    expect(evts[0].facts["crisisUnit"]).toBe("Ally-R");
  });

  it("控制 CD(定身术)+ 队友垂危 → 照常出:peel 是成立的教练意见", () => {
    const evts = cdHoardedEvents([cd("115078", "Paralysis")], OWNER, {
      crisisMomentAt: honestProbe(13, 90),
    });
    expect(evts).toHaveLength(1);
    expect(evts[0].facts["crisisUnit"]).toBe("Ally-R");
  });

  it("被标成 Defensive 的产出增益(神圣显灵)+ 队友垂危 → 照常出:它提高的是你给队友的治疗", () => {
    const evts = cdHoardedEvents([cd("200183", "Apotheosis")], OWNER, {
      crisisMomentAt: honestProbe(13, 90),
    });
    expect(evts).toHaveLength(1);
  });

  it("红线:限制是靠第三个参数下发的 —— 探针吞掉它就等于门没生效", () => {
    const seen: Array<string | undefined> = [];
    cdHoardedEvents([cd("19236", "Desperate Prayer")], OWNER, {
      crisisMomentAt: (_f, _t, onlyUnitName) => {
        seen.push(onlyUnitName);
        return null;
      },
    });
    expect(seen).toEqual([OWNER.name]);
  });

  // 运行时注入的 Defensive(终极苦修 421453 由 extractMajorCooldowns 按职业推入
  // Priest 目录,不在静态 classMetadata 里)。250 场实测 7 条拿它指控救队友,
  // 全因为第 4 层只查静态 id 集合 → 判成「不是防御 CD,不归这道门管」。
  it("运行时注入的 Defensive CD:带 tag 就该被门拦住(层 4 的静态表漏洞)", () => {
    const up = { ...cd("421453", "Ultimate Penitence"), tag: "Defensive" };
    expect(
      cdHoardedEvents([up], OWNER, { crisisMomentAt: honestProbe(13, 90) }),
    ).toEqual([]);
    // 2026-08-23 更新:这里原本记录的是「不传 tag 就退回 id 集合、静态表里没有它,
    // 所以拦不住」——那是当时的**现状**不是期望。层 4 现在多了一条官方画像兜底
    // (isSurvivalWall:官方说它有减伤/吸收/免疫任一,就按防御类管辖),终极苦修
    // 是纯自身吸收盾,于是**不传 tag 也拦得住**。这条限制被消掉了。
    expect(
      cdHoardedEvents([cd("421453", "Ultimate Penitence")], OWNER, {
        crisisMomentAt: honestProbe(13, 90),
      }),
    ).toEqual([]);
  });

  it("带 Control tag 的 CD 不受层 4 影响:peel 照常成立", () => {
    const para = { ...cd("115078", "Paralysis"), tag: "Control" };
    expect(
      cdHoardedEvents([para], OWNER, { crisisMomentAt: honestProbe(13, 90) }),
    ).toHaveLength(1);
  });
});
