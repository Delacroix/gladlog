/** Version key of the analysis cache: the main process writing the cache, the
 *  main process reading it, and E2E seeding it all share this one constant.
 *
 *  Single-source predicate — a hardcoded copy fails silently on a version bump:
 *  getCached discards the cache, the panel sits idle, and E2E only reports the
 *  undirected failure "there are no findings".
 *
 *  v3: candidate menu expanded — deaths tagged friendly/enemy (side fact) and
 *  cd-waste events (never-used defensive cooldowns) added; prompt gained an
 *  event legend and whole-round time display.
 *  v4 (D2): the point of view became the log recorder (owner) — a DPS recorder
 *  switched from the healer's point of view to their own, so old caches (the
 *  healer-POV result for the same matchId) must be invalidated; the DPS owner
 *  menu gained four event classes (burst-into-immunity / off-target-in-window /
 *  juked-kick / dr-clipped-cc) plus the <burst_ledger> block. The healer
 *  recorder's prompt is byte-identical, but its cache key rotates with the
 *  version anyway.
 *  v9: HP / short names; v10: teachable-signal gate + owner anchoring + leaving
 *  clean windows blank;
 *  v11: positioning signals (a fourth class); v12: offensive deep dives
 *  (non-death findings);
 *  v13: three team-coordination event classes (death-unused-defensive /
 *  external-unused / wasted-trinket) wired into the prompt's event legend and
 *  mistake list; the menu composition changed, so old caches are void;
 *  v14: the low-pressure guard note (lowPressureUnusedDefensiveNote) — in rounds
 *  where the owner was never attacked, the loadout's owner [UNUSED] mitigation
 *  tags are explicitly declared not to be a teaching point, which also voids the
 *  old caches' false positives of "blamed for unused mitigation despite taking
 *  ≈0 damage".
 *  v15: feasibility gate on dispel blame (user's call, 2026-08-02) — missed
 *  cleanses where the dispeller was CC'd or locked out, or had no line of sight
 *  or was out of range, no longer enter the candidate menu; the timeline
 *  [UNCLEANSED DEBUFF] / [MISSED PURGE OPPORTUNITY] lines gained an exemption
 *  suffix, and windows with fully fresh DR plus evidence of a follow-up CC carry
 *  a cautionary note; false positives of the "blamed for not dispelling
 *  Dragon's Breath / Binding Shot" class in old caches are void.
 *  v16: moment deep dive snapshot opt-in (2026-08-05) -- the deep dive pack
 *  gained a `snapshot` mode (castFlow / GCD-gap context added to the window
 *  pack); the default (non-snapshot) path stays byte-identical, but the pack
 *  *shape* the prompt builder accepts changed, so this counts as a
 *  prompt-generation change under this cache's own rule and the version rolls
 *  regardless of whether a given cached entry happens to be a
 *  snapshot-affected one. Note this is orthogonal to the window cache's own
 *  `:snap` windowKey suffix (see analysis.ts's analyzeWindow) -- that suffix
 *  keeps snapshot-on/off runs of the *same* window from colliding with each
 *  other; this version bump is what invalidates *every* previously-cached
 *  window/run/deepen/coach-chat-resume entry (all consumers of
 *  PROMPT_VERSION), snapshot or not, because they were all produced by the
 *  pre-v16 prompt builder. */
export const PROMPT_VERSION = 16;
