import { SPELL_ICONS_GENERATED } from "./spellIconsGenerated";
import { getSpellNamesSnapshot, spellNamesReady } from "./spellEffectData";
import { SPELL_NAME_STOPWORDS } from "./spellNameStopwords";

let index: ReadonlyMap<string, readonly string[]> | null = null;

/** 英文技能名 → 候选 id 列表(升序)。仅收有图标的 id(图标集=观测∪
 * SpellCooldowns∪候选,已是"值得显示"的宇宙)。spellNames 12MB 表未载完
 * 时返回 null —— 展示路径可降级(ensure 契约),下次渲染自愈。 */
export function englishNameIndex(): ReadonlyMap<
  string,
  readonly string[]
> | null {
  if (index) return index;
  if (!spellNamesReady()) return null;
  const names = getSpellNamesSnapshot();
  const m = new Map<string, string[]>();
  for (const id in SPELL_ICONS_GENERATED) {
    const n = names[id];
    if (!n) continue;
    // 1-2 字符的"名字"全是 DB2 占位/内部条目,不是真实可教技能名(现存最短
    // 真实技能名 3 字符,如 Hex)。实证:id 405304 的名字是单字符 "s" ——
    // 若不过滤,内联富文本(inlineRich.tsx)会把 AI 正文里 "30s"/"5s." 这类
    // 高频时长写法的结尾字母包成随机法术图标。
    if (n.length < 3) continue;
    // 常见英文单词撞车 DB2 罕见/占位法术名(如 "Stun"→id 56 通用锤子图标)
    // ——停用词表见 spellNameStopwords.ts 的收录判据与批次说明。
    if (SPELL_NAME_STOPWORDS.has(n)) continue;
    const arr = m.get(n);
    if (arr) arr.push(id);
    else m.set(n, [id]);
  }
  for (const arr of m.values()) arr.sort((a, b) => Number(a) - Number(b));
  index = m;
  return index;
}
