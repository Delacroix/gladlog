import raw from "./spellNamesZhGenerated.json";

/** zhCN 技能名(datagen 产物,仅图标集∩真翻译)。缺项 = 未翻译或无图标,
 * 消费方兜底链:本场日志名 > 本表 > 英文原样。 */
export const SPELL_NAMES_ZH_GENERATED = raw as unknown as Record<
  string,
  string
>;
