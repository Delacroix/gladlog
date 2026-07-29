import { SPELL_ICONS_GENERATED } from "./spellIconsGenerated";
import { getSpellNamesSnapshot, spellNamesReady } from "./spellEffectData";

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
    const arr = m.get(n);
    if (arr) arr.push(id);
    else m.set(n, [id]);
  }
  for (const arr of m.values()) arr.sort((a, b) => Number(a) - Number(b));
  index = m;
  return index;
}
