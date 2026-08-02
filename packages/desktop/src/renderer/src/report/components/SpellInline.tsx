import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import { specIconName } from "../data/gameConstants";
import { SpellIcon } from "./SpellIcon";

/** Inline spell inside AI prose: icon (rendered only when there is a table
 * entry) + display name; title = the original English name. The substitution
 * is presentation-only -- the stored text used for auditing/export is
 * untouched, so a hover is enough to reconcile the two. */
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

/**
 * Inline spec inside AI prose: icon (served through the main process's
 * iconCache, no longer hotlinking an external CDN -- see
 * docs/DATA-COMPLIANCE.md) + display name.
 *
 * The reason for passing an empty label is the same as for SpellIconChip
 * above: the spec name text follows immediately, so the fallback initial
 * would be a duplicate.
 */
export function SpecInline({
  specId,
  display,
  original,
}: {
  specId: number;
  display: string;
  original: string;
}) {
  const icon = specIconName(specId);
  return (
    <span className="rpt-inline-spell" title={original}>
      {icon ? <SpellIcon icon={icon} label="" size={14} /> : null}
      {display}
    </span>
  );
}

/**
 * The spell icon on a chip. No id, or an id absent from the generated table
 * -> render nothing.
 *
 * **Passing an empty label is deliberate**: when the image fails to load or
 * is still loading, SpellIcon degrades to the first character of the label
 * (reasonable in the lane view, where each cell is one spell). On a chip the
 * spell name text follows immediately, so the fallback character produces a
 * duplicate like "F⏱ 0:38 Frost Nova" -- observed on the test bed. An empty
 * label also makes alt="", which is correct in this position: the icon is
 * decorative and the semantics are already carried by the adjacent text.
 */
export function ChipIcon({ spellId }: { spellId?: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  if (!icon) return null;
  return <SpellIcon icon={icon} label="" size={14} />;
}
