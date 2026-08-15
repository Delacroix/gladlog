# gladlog

## Shared-Predicate Rule

Analysis code (`packages/analysis`) and verification gates (`packages/eval`'s positioningScan/qualityCheck/layerA audit) must share **the same predicate** for **the same fact** (HP, distance, LoS, timestamp): same constant, same sampling function, same tolerance, and **anchored to the rendered value** — the prompt renders `fmtTime` (floor to whole seconds), and the gate re-parses the rendered text, so fractional seconds / raw timestamps inside analysis must be floored to the rendering grid before any gate-recalculated check.

Historical cost of violating this rule: in the 2026-07 full audit, 5 independent bugs were all of this class (HP sample radius inconsistency, bounded vs unbounded lookback, interpolated vs raw vs non-simultaneous sampling for LoS, fractional-second vs rendered-second scan grid). The fix is always to make analysis consume the gate's predicate, never to relax the gate. Sharing-point examples: `cooldowns.ts`'s `HP_SAMPLE_RADIUS_MS`; `positionSampling.ts`'s `LOS_SWEEP_SLACK_S`/`LOS_SWEEP_GAP_MS` — `positioningScan.ts`'s `TIME_SLACK_SECONDS`/`POSITION_MAX_GAP_MS` are now direct aliases of these (structural coupling, harder than "must be equal"). Note the two examples have **different structures**: in the first, the gate side has no corresponding constant at all and verifies by re-parsing the already-rendered prompt text — "shared predicate" doesn't always mean "shared constant".

When adding any new "analysis asserts X, gate verifies X" pair: export the predicate from one place, import on both sides; if that's not possible, write a unit test asserting equality — don't rely on comments.

**Where existing predicates live: see [`docs/predicate-index.md`](docs/predicate-index.md)** (70 entries, with a consistency test in `packages/eval/test/predicateIndex.test.ts`: renaming/moving a symbol turns CI red). The index doesn't only track analysis↔gate pairs: since 2026-08-04 it also tracks cases within the desktop renderer where **two consumers** check the same fact (the "Report UI" section), with the same criterion of "one fact, one predicate". Check the table before writing new code — the rule has never been lacking; what was lacking was the index: on 2026-08-01 someone read this section and still hand-copied two predicates that same day. When the index went live, it immediately caught 5 registered violations, **all closed on the same day** (4 converted to shared exports, 1 confirmed to not be a duplicate); the "not yet unified" section in the doc is now empty — register newly discovered duplicates there.

## Verification Rule

When claiming a bug is "fixed", include **before/after numbers under the same criterion** (e.g. "type-A same-second HP contradiction 26/50 matches → 0/50").
If you can't provide numbers, say so explicitly — **reading the code + writing a convincing commit message does not count as verification**.

The 2026-07-20 cost: `3cd5342` fixed same-second HP contradiction by "unifying HP sample radius"; the root-cause explanation was perfectly plausible and it landed on main; later testing showed **26/50 → 26/50, not a single number moved** (the radius only controls accept/reject, it doesn't change the sampled value; the real root cause was the query timestamp not being on the rendering grid). On the same day, `dbe61bd` **extrapolated from a single sample to the entire class**, misclassifying type-D as "marker ambiguity"; an independent reviewer disproved it with a counterexample (`c820ad4`).

Complementary practice: prefer making criteria into **deterministic text checks baked into the gates** (`packages/eval/src/quality/promptQualityCheck.ts`'s `hardFailures`, currently five classes: friendly death coverage + percentile monotonicity / same-second HP consistency / window duration self-consistency / cooldown ledger consistency) — don't leave one-off scripts; they vanish with the session and no one blocks the next regression.

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
