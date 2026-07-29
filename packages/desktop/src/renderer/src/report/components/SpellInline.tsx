import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import { specIconUrl } from "../data/gameConstants";
import { SpellIcon } from "./SpellIcon";

/** AI 正文内联技能:图标(有表项才渲)+ 显示名;title=英文原名 ——
 * 替换纯展示,审计/导出用的存储文本不动,hover 即可对账。 */
export function SpellInline({
  spellId,
  display,
  original,
}: {
  spellId: string;
  display: string;
  original: string;
}) {
  const icon = SPELL_ICONS_GENERATED[spellId];
  return (
    <span className="rpt-inline-spell" title={original}>
      {icon ? <SpellIcon icon={icon} label="" size={14} /> : null}
      {display}
    </span>
  );
}

/** AI 正文内联专精:CDN 图标(specIconUrl,竞技场小地图同先例;视觉测试
 * 由 stubExternal 打桩)+ 显示名。 */
export function SpecInline({
  specId,
  display,
  original,
}: {
  specId: number;
  display: string;
  original: string;
}) {
  const url = specIconUrl(specId);
  return (
    <span className="rpt-inline-spell" title={original}>
      {url ? (
        <img
          src={url}
          alt=""
          width={14}
          height={14}
          className="rpt-inline-spec-img"
        />
      ) : null}
      {display}
    </span>
  );
}

/**
 * chip 上的技能图标。查不到 id、或该 id 不在生成表里 → 什么都不渲染。
 *
 * **传空 label 是刻意的**:SpellIcon 在取图失败/加载中时会退化成 label 的
 * 首字母(泳道那种「一格一技能」的场景下合理)。chip 紧跟着就是技能名文字,
 * 兜底字符会变成「寒⏱ 0:38 寒冰新星」这种重复 —— 试验台实测到的。空 label
 * 同时让 alt="",对这个位置也正确:图标是装饰,语义已由旁边的文字承载。
 */
export function ChipIcon({ spellId }: { spellId?: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  if (!icon) return null;
  return <SpellIcon icon={icon} label="" size={14} />;
}
