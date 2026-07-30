import generated from "./mitigationGenerated.json";

export interface IMitigationEntry {
  /** 减伤百分比,0-100;免疫类=100。 */
  pct: number;
  /** 作用学派掩码,与日志 spellSchoolId 同位义(0x7F 全/0x7E 仅魔法/0x1 仅物理)。 */
  schoolMask: number;
  /**
   * 仅对处于技能区域内的单位生效;消费方必须结合坐标判定(advanced 位置
   * 数据)才能计入该条减伤——不判定不得计入。
   */
  positional?: true;
}

/**
 * 策展覆盖层(恒赢):每条注明来源与覆盖原因。生成层挖不出(unresolved/
 * 零命中)或挖错(与游戏事实不符)的条目在这里定值。
 *
 * 证据口径(2026-07 人审,DB2 build 12.1.0.68629 SpellEffect 全表 628107 行):
 * - "aura39/40" = DB2 学派免疫/伤害免疫行(免疫类按 spec 拍板 pct=100);
 * - "DR 光环 <id>" = 施法 id 本身无 aura-87 行,实际减伤光环挂在另一 id 上,
 *   该 id 已在本库真实对局日志中 observed(observedSpellIdsGenerated.json),
 *   数值取该光环 id 当期 DB2 aura-87 行;
 * - 待拍板 4 条(115203/357170/196718/374227)已于 2026-07-30 由用户逐条
 *   拍板,结论见各条行内「用户拍板」注释与 task-2-report.md。196718 原拍板
 *   no-mitigation 后被用户推翻改判,详见该条注释。
 */
export const MITIGATION_OVERRIDES: Record<string, IMitigationEntry> = {
  // —— 免疫类(spec 拍板:免疫 = pct 100 + 正确学派掩码)——
  "642": { pct: 100, schoolMask: 0x7f }, // Divine Shield:全免疫;DB2 aura39 misc0=127+126;生成层零命中(免疫不走 aura87)
  "45438": { pct: 100, schoolMask: 0x7f }, // Ice Block:全免疫;DB2 aura39 misc0=1+127
  "196555": { pct: 100, schoolMask: 0x7f }, // Netherwalk:全伤害免疫;DB2 aura40 misc0=127
  "1022": { pct: 100, schoolMask: 0x1 }, // Blessing of Protection:仅物理免疫;DB2 aura39 misc0=1(其 aura87 points=0 行是残留死槽,Task 1 unresolved)
  "204018": { pct: 100, schoolMask: 0x7e }, // Blessing of Spellwarding:仅魔法免疫;DB2 aura39 misc0=126
  "31224": { pct: 100, schoolMask: 0x7e }, // Cloak of Shadows:仅魔法免疫;DB2 aura186 points=-200(法术命中-200%);spec 拍板;aura87 0 行为死槽
  "186265": { pct: 100, schoolMask: 0x7f }, // Aspect of the Turtle:偏斜=免疫(DB2 aura184/185/186 均 -200% 命中);spec 拍板以免疫语义覆盖生成层的 30(那是未被偏斜伤害的残留减伤)

  // —— 减伤光环挂在别的 id 上(生成层按施法 id 扫不到)——
  "51052": { pct: 15, schoolMask: 0x7e }, // Anti-Magic Zone:DR 光环 145629(observed)当期 -15/126;同名 332831(-20)未 observed,判非现役
  "62618": { pct: 20, schoolMask: 0x7f }, // Power Word: Barrier:DR 光环 81782(observed)当期 -20/127
  "98008": { pct: 10, schoolMask: 0x7f }, // Spirit Link Totem:DR 光环 325174(observed)当期 -10/127(98007 同值未 observed)
  "61336": { pct: 50, schoolMask: 0x7f }, // Survival Instincts:施法 id 仅 dummy(points=50);同名 50322/236157 当期均 -50/127;长期稳定 50%
  "115203": { pct: 20, schoolMask: 0x7f }, // Fortifying Brew:施法 id dummy 效果 ±20(wowhead 当期同显 -20);实际 buff 120954 的 aura87 基值=0 由脚本填,另存 -15 变体(243435,未 observed)。2026-07-30 用户拍板:采 20%
  "357170": { pct: 50, schoolMask: 0x7f }, // Time Dilation:机制=比例吸收(aura69 全学派 + dummy points=50),被吸收的 50% 会在其后 ~10s 重新结算(时间转移),总伤不变;按死亡/爆发窗口口径等效 50% 减伤。2026-07-30 用户拍板:采用该口径(严格总伤语义的 no-mitigation 备选已呈现并被否)

  // —— 条件减伤(仅在特定站位/条件下生效,消费方需自行判定条件)——
  "196718": { pct: 40, schoolMask: 0x7f, positional: true }, // Darkness:2026-07-30 用户改判:算 40%(大技能不能算 0),但必须计算位置——不站在黑暗里不计。条件可判性分野:黑暗的条件(位置)日志可判,故给值+positional;和风(374227 Zephyr)的条件(伤害是否 AoE)日志不可判,故维持宁缺
};

/**
 * 白名单内确无(百分比型)减伤属性的条目——纯吸收盾/治疗/伤害转移类,
 * 每条注明原因。与 MITIGATION_TABLE 互斥,防腐测试把守无第三态。
 */
export const NO_MITIGATION_IDS: ReadonlySet<string> = new Set([
  "6940", // Blessing of Sacrifice:伤害转移(30% 转给圣骑),spec 列明转移类不进表;其 aura87 points=0 行是死槽
  "19236", // Desperate Prayer:纯治疗 + 最大生命值,DB2 无任何 aura87 行
  "47788", // Guardian Spirit:治疗承受 +60%(aura118)+ 免死,无百分比减伤(同名新 id 1247928 有 -10 行但未 observed,见待拍板节备注)
  "97462", // Rallying Cry:+10% 最大生命值(实际 buff 97463),无减伤
  "116849", // Life Cocoon:纯吸收盾(aura69)+ 治疗增益,无百分比减伤
  "122470", // Touch of Karma:吸收 + 伤害转移给目标(aura69),非百分比减伤
  "374227", // Zephyr:仅 AoE 减伤 20%(aura229 非 aura87),条件减伤本表模式无法表达。2026-07-30 用户拍板:no-mitigation 宁缺(196718 Darkness 同为条件减伤但条件——位置——日志可判,已改判进 MITIGATION_OVERRIDES,见该处注释)
]);

const gen = (
  generated as unknown as {
    entries: Record<string, IMitigationEntry>;
  }
).entries;

/** 合并表:生成底 + 策展覆盖恒赢(spellEffectData 双层同款)。 */
export const MITIGATION_TABLE: Record<string, IMitigationEntry> = {
  ...gen,
  ...MITIGATION_OVERRIDES,
};
