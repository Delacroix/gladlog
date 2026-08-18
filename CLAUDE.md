# gladlog

## Shared-Predicate Rule

Analysis code (`packages/analysis`) and verification gates (`packages/eval`'s positioningScan/qualityCheck/layerA audit) must share **the same predicate** for **the same fact** (HP, distance, LoS, timestamp): same constant, same sampling function, same tolerance, and **anchored to the rendered value** — the prompt renders `fmtTime` (floor to whole seconds), and the gate re-parses the rendered text, so fractional seconds / raw timestamps inside analysis must be floored to the rendering grid before any gate-recalculated check.

Historical cost of violating this rule: in the 2026-07 full audit, 5 independent bugs were all of this class (HP sample radius inconsistency, bounded vs unbounded lookback, interpolated vs raw vs non-simultaneous sampling for LoS, fractional-second vs rendered-second scan grid). The fix is always to make analysis consume the gate's predicate, never to relax the gate. Sharing-point examples: `cooldowns.ts`'s `HP_SAMPLE_RADIUS_MS`; `positionSampling.ts`'s `LOS_SWEEP_SLACK_S`/`LOS_SWEEP_GAP_MS` — `positioningScan.ts`'s `TIME_SLACK_SECONDS`/`POSITION_MAX_GAP_MS` are now direct aliases of these (structural coupling, harder than "must be equal"). Note the two examples have **different structures**: in the first, the gate side has no corresponding constant at all and verifies by re-parsing the already-rendered prompt text — "shared predicate" doesn't always mean "shared constant".

When adding any new "analysis asserts X, gate verifies X" pair: export the predicate from one place, import on both sides; if that's not possible, write a unit test asserting equality — don't rely on comments.

**Where existing predicates live: see [`docs/predicate-index.md`](docs/predicate-index.md)** (120 entries, with a consistency test in `packages/eval/test/predicateIndex.test.ts`: renaming/moving a symbol turns CI red). The index doesn't only track analysis↔gate pairs: since 2026-08-04 it also tracks cases within the desktop renderer where **two consumers** check the same fact (the "Report UI" section), with the same criterion of "one fact, one predicate". Check the table before writing new code — the rule has never been lacking; what was lacking was the index: on 2026-08-01 someone read this section and still hand-copied two predicates that same day. When the index went live, it immediately caught 5 registered violations, **all closed on the same day** (4 converted to shared exports, 1 confirmed to not be a duplicate); the "not yet unified" section in the doc is now empty — register newly discovered duplicates there.

## Verification Rule

When claiming a bug is "fixed", include **before/after numbers under the same criterion** (e.g. "type-A same-second HP contradiction 26/50 matches → 0/50").
If you can't provide numbers, say so explicitly — **reading the code + writing a convincing commit message does not count as verification**.

The 2026-07-20 cost: `3cd5342` fixed same-second HP contradiction by "unifying HP sample radius"; the root-cause explanation was perfectly plausible and it landed on main; later testing showed **26/50 → 26/50, not a single number moved** (the radius only controls accept/reject, it doesn't change the sampled value; the real root cause was the query timestamp not being on the rendering grid). On the same day, `dbe61bd` **extrapolated from a single sample to the entire class**, misclassifying type-D as "marker ambiguity"; an independent reviewer disproved it with a counterexample (`c820ad4`).

Complementary practice: prefer making criteria into **deterministic text checks baked into the gates** (`packages/eval/src/quality/promptQualityCheck.ts`'s `hardFailures`, currently six classes: friendly death coverage / percentile monotonicity / same-second HP consistency / window duration self-consistency / cooldown ledger consistency / snapshot facts consistency `checkSnapshotFactsConsistency`) — don't leave one-off scripts; they vanish with the session and no one blocks the next regression.

## Curated-List Completeness Rule

Whenever official data is reached **through a hand-maintained list** — a candidate/allowlist/tracking set that decides _which ids the official lookup even runs on_ — that list is part of the predicate, and its **completeness** must be verified separately from its correctness. Verifying only "is every entry in the list right" proves there are no false positives; it can never prove there are no false negatives.

This has now bitten four times, always the same shape (the list silently swallows official data, and the failure looks exactly like "the game doesn't have that"):

- **2026-07-25**: `DISPEL_TYPE_FALLBACK` was emptied after an audit confirmed all 8 hand entries were bogus, concluding "the official dispelType is the complete predicate". It checked only the entries present.
- **2026-08-17**: `collectCandidateIds` (8 sources, all hand-maintained) gates which ids enter `spellEffectGenerated.json`, which is what `getDispelType` reads — so a debuff nobody had listed could never be _known_ dispellable. Measured: **145 spells / 76.5% of all corpus dispels** had no entry at all (Shadow Word: Pain, Moonfire, Corruption, Vampiric Touch…).
- **2026-08-18**: `genTalentModifiers`'s step-6 "sanity filter" gates on `trackedSpellIds` (same kind of hand list), discarding correctly-mined talent cooldown/charge modifiers for any unlisted spell.

- **2026-08-18** (GH #23), the worst shape so far — **not incomplete, entirely stale**: `DISPEL_PENALTY_SPELLS` (the "don't cleanse it, it backlashes" exemption) knew Unstable Affliction only as `316099`/`342938`, which occur **zero** times in 1178 rounds, while the live `1259790` (1153 applications, 519 dispels) was unlisted. 100% of the list dead, 100% of real exposure unlisted. **Two tells worth memorising**: (a) the comment dated itself — "confirmed present in BigDebuffs data for TWW", and TWW is the _previous_ expansion, so a spell renumber had silently emptied the list; (b) `dispelPenalty.test.ts` **predicted this exact failure** ("the moment a DB2 refresh fills in UA's dispelType, false reports appear immediately") and still missed it, because it pinned the dead id — a test that pins the wrong key is worse than no test, it manufactures confidence. Only UA's unrelated `Low` priority was suppressing the false accusations.

**The check to run**: take the observable ground truth (corpus events — `SPELL_DISPEL`'s own `extraSpellId`, observed casts, …) and ask which ids the official path fails to explain. `packages/analysis/src/data/observedSpellIdsGenerated.json` exists precisely for this and should be a source in any such list.

**Run it in both directions.** The check above finds ids the list is missing; the cheap reverse pass finds ids the list has _gone stale on_ — intersect the list's own keys with `observedSpellIdsGenerated.json` and look at what has **zero** corpus occurrences. Every entry a patch renumbered shows up immediately, and it costs one set intersection. Spell ids are not stable across expansions: an id that was right when written stays in the file looking authoritative forever.

Corollary: **when you change what a predicate keys on, re-verify every property its comments claim.** `TALENT_BEHAVIORS`' "self-gating — the aura only exists when the talent is taken" was true while availability keyed on the _buff's_ own casts, and false the moment it keyed on the _trigger_ ability (Fade / Psychic Scream exist for every priest). Measured cost before the talent gate was restored: 303 of the proc tools' citations belonged to players who had not taken the talent.

## Bilingual Docs Rule

The following 12 documents have **English as the canonical version with a `.zh-CN` suffix for Chinese**; both versions must be equivalent — update one side, update the other, or don't update at all:

`README.md` · `CHANGELOG.md` · `docs/user-guide.md` · `docs/FAQ.md` ·
`docs/setup-windows-claude-cli.md` · `docs/developer-guide.md` ·
`docs/BUILD-WINDOWS.md` · `docs/verifiability-roadmap.md` ·
`docs/DATA-COMPLIANCE.md` · `docs/pvp-log-archive.md` ·
`docs/architecture.md` · `docs/predicate-index.md`

**Package-level READMEs follow the same rule**: wherever `packages/<pkg>/README.zh-CN.md` exists, `README.md` is the canonical version and both must be equivalent (currently: `analysis`, `desktop`). `corpus-tools/README.md` is still a Chinese-only single version — a historical leftover; when an English version is added, it joins this rule.

Each document has a language bar on the line immediately below the H1 heading (current language bolded without a link, the other language as a link); cross-links stay **within the same language** — English docs point to English files, Chinese docs point to `.zh-CN.md` files, never cross-language. New user-facing docs follow this pattern as well.

## Common Commands

- Type check: `npm run typecheck` (never `tsc -b` — it emits .js files into src).
- Before pushing desktop changes: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet` — **the real gap is lint scope**: CI runs `eslint .` covering the entire repo, while scanning only `packages/desktop/src` misses `test/`, `qa/`, `dev/`, `scripts/` (this has caused three consecutive failures). Typecheck locally and in CI sees the same set of files (both use `tsconfig.json`, `include` already covers src/test/dev/qa) — that's not a gap. Engineering conventions are in `.claude/skills/desktop-dev`.
- Eval workflow: `/eval-baseline` (find issues) → `/eval-ab` (verify fixes) → `/calibrate-judge` (calibrate scoring) → `/pipeline-audit` (full-corpus audit). Artifacts go in `$GLADLOG_EVAL_HOME` (default `~/code/gladlog-eval-private`).
