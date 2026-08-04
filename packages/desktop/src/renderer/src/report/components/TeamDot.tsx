import { TEAM_SIDE_LABEL, type TeamSide } from "../derive/teamSide";

/**
 * The team marker: one small dot before a unit's name, green for our side, red
 * for theirs.
 *
 * It is a *second* channel on purpose. Class colour already owns the curves,
 * the meter bars and the legend swatches — that is WoW convention and people
 * read specs off it — so team identity cannot be expressed by recolouring any
 * of that. A dot composes everywhere a name appears, including a table row
 * whose 来源 and 目标 belong to opposite teams, which a row-level accent could
 * never express.
 *
 * `unknown` renders nothing at all rather than a neutral dot: an imported log
 * without playerTeamId has no sides, and a grey dot there would read as a third
 * team.
 */
export function TeamDot({ side }: { side: TeamSide }) {
  if (side === "unknown") return null;
  return (
    <span
      className={`rpt-team-dot rpt-team-dot-${side}`}
      data-testid="team-dot"
      data-side={side}
      // The colour is the whole signal, so it needs a text equivalent for
      // screen readers and for anyone who cannot separate the two hues.
      role="img"
      aria-label={TEAM_SIDE_LABEL[side]}
      title={TEAM_SIDE_LABEL[side]}
    />
  );
}
