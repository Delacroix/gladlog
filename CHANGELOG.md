# Changelog

**English** · [中文](CHANGELOG.zh-CN.md)

One section per release, listing every change and the commit behind it (on the
`git log v<prev>..v<new>` basis; release and docs-only commits go under "Other").
The release procedure is documented in `.claude/skills/release`.

## v0.1.18 (2026-08-01)

This release = batch analysis goes concurrent (3-way) + a low-pressure guard note so the coach stops scolding unused defensives in rounds where you took no damage + three adjudicated wording/layout tweaks across the report, recording, and stats views.

### AI analysis

- `0c568a0` Batch analysis switched from serial to a **3-way concurrent pool**: matches and shuffle rounds share one queue, so rounds of the same shuffle analyze in parallel too; progress still counts per match, and cancel now pinpoint-cancels every in-flight unit
- `37f5df2` In rounds that never put you under real pressure (lowest HP ≥ 60%), the prompt now states explicitly that holding your unused defensives was the right call — the coach no longer riffs "you never used your wall" off the loadout's [UNUSED] tags in rounds where you took almost no damage (local-library measurement: 72/92 low-pressure rounds carried ungated tags → 0/92 unguarded). The prompt version bumped, so old cached analyses — including these false calls — re-analyze

### Report / recording / stats polish

- `c3dbb69` The report header result area is now Chinese ("败北" etc., larger weight; meta reordered to bracket · round · map · duration · rating); the recording tab's marker strip moved into the same track column as the progress bar, so you can drag against the gold bands and glyphs; the stats per-map card switched to a row style (name + win-rate bar + n% · x games) and clicking a row returns to the match list with that map filtered

### Other

- `c287115` 14 visual baselines refreshed for the three adjudicated changes (CI-generated, human-reviewed)

## v0.1.17 (2026-08-01)

This release = two rounds of UI redesign landing across all three views (report dual-column workbench / stats KPI tower + coach cards / recording three-tab workspace, including 4K empty-state and real-match acceptance fixes) + eight structured-analysis signals surfaced + multi-model analysis comparison and auto-analysis + three data-compliance items.

### Report (dual-column workbench / round-two polish / eight signals surfaced)

- `9672da3` The report is now a **dual-column workbench** (≥1440px): HP curve, meters + engagement panel, and burst ledger on the left; death recap + mistakes list on the right; the header gained a result area and KPI chips (finishing kill / mistakes / burst windows / interrupts / dispels); the standalone interrupt / dispel / aura cards merged into engagement-panel tabs; narrow windows fall back to a single column; `ff8c649` four review fixes alongside
- `4bc1954` Burst / pressure windows on the HP curve switched to a faint fill with boundary strokes — overlapping windows no longer smear into a dark blob; when no friendly death exists, the enemy last-death fallback is now titled "termination recap" (their death is your result)
- `ff66f10` Two real-match overflow fixes on the death recap card: the event timeline collapsed to 5 rows with internal scrolling (the 10s before death in a long round can hold dozens of small hits, previously stretching the right column to two screens), and the source column drops the realm suffix (cross-realm full names used to push the page into horizontal scrolling); `8a7ea5d` the scroll region gained keyboard focus (caught by the accessibility gate)
- Structured signals surfaced: `2532caa` single-source structured foundation and dead-code cleanup; `f23569e` a dampening lane under the curve and DR-tier annotations on CC moments (`1a13c29` review fixes); `3c2825c` target-selection verdicts (who to hit) and healing-gap surfacing in the burst ledger; `6a215c8` a **match-arc line** in the header (clickable turning points) and positioning events on the moment axis; `5fd2e4c` review fixes (English prose removed / positioning mistakes single-sourced); `16f9900` panic-defensive and cheaper-alternative annotations on the recap plus a new **enemy CC-chain panel**; `97dd5c6` cheaper alternatives exclude self-cast-ineffective externals

### Stats page (KPI tower + coach cards + empty-state fill)

- `9672da3` The stats page is now a left **KPI tower** (games / win rate with W-L / current rating with a sparkline that opens the full curve / median duration) and a right coach-card column; the full-width rating-curve card is gone; the mistake notebook and long-term patterns merged into "what to practice this week"
- `4bc1954` Three fixes for the largely blank right column at 4K: a new **recent matches** card (last 8 rich rows, click straight into the report, rating deltas sharing the match-list algorithm); the "vs enemy comps" empty state offers a **rebuild index** button in place (no more pointing at the developer view; the main process gained single-flight protection against concurrent rebuilds); first/last value labels on the rating sparkline; the page width cap unified with the report at 1920

### Recording tab (three-tab workspace + playback linking)

- `1235c6f` The player switched to a custom control bar with the progress range clamped per shuffle round (native controls exposed the whole recording); `e045e3d` the event feed sizes its capacity by measured height instead of wall-clock fade-outs; `0fdfd69` AI results reliably reach the feed and marker strip; `2e0c5f5` three review fixes (including the CPU-spin guard when the recording is shorter than the round)
- `9672da3` Recording tab redesign: player plus a **battle timeline card** on the left (HP curves / gold bands / death ✕ from the same derives as the report; click or drag to seek), and a single right-hand card with three tabs (playback feed / all moments / AI findings)
- `4bc1954` Before playback the default tab is now "all moments" (the feed is inherently empty then); starting playback auto-switches to the feed; a manual choice always wins; enemy curves on the battle timeline are dimmed to foreground your team's health; the video area fills the remaining viewport with the timeline card anchored at the bottom

### Replay

- `b96dfda` Zoom semantics: the map scales while markers keep a constant screen size; `a51e1c2` the bundled arena background images removed (those PNGs contained no map, only the obstacles we already draw)

### AI analysis (multi-model comparison / auto-analysis / uncovered highlights)

- Multi-model comparison: `6cdcc80` slot-based analysis cache envelope v2 (slot predicate single-sourced); `44cde5f` per backend×model slot persistence; `5f273c5` a split arrow on the analyze button, "analyze with another model" (a temporary switch that doesn't touch the global default); `d8abf5e` slot tabs on the analysis panel; `e35870d` deep-dive follow-ups use the target slot's backend/model; `05a1e01` `6f01226` `6fa1dd9` three review rounds (end-to-end cache wiring / stale-slot placeholder / renderer production build fix)
- Auto-analysis: `616cf7e` a settings toggle "auto-analyze new matches"; `4002f51` live flag on real-time ingestion; `0b897fa` new matches queue for analysis automatically
- `5a3cc88` `4721f36` Uncovered-highlights card: a whole-match sliding window automatically finds high-density segments the AI never discussed, one click into window deep-dive; `f1041e9` three review fixes
- `acfa1a9` CC distance and "point-blank" definitions single-sourced between analysis and the verification gates — no more two sets of criteria

### Data and compliance

- `3b6aff1` Runtime dependency on the wowarenalogs CDN severed (icons via local cache) plus the data-compliance doc; `c840a19` game enums now generated from Blizzard's official DB2, resolving the license conflict; `0cb05ae` corpus collection gained an identifiable UA and download-side throttling

### Corpus tooling (not shipped in the product)

- Long-term PvP log archive pipeline: `92b26a5` the orchestration shell (scan feed / store compressed bytes / upload to Drive / dedup ledger); `134da14` pure-predicate archive planning; `1861bce` day-sharded ledger; `7b6813b` rclone parameters and success criteria; `0921704` run lock; `05da63b` `f8b3625` two review-fix waves; `b50af8c` layered download integrity checks

### Other

- Docs: architecture / predicate index / package READMEs / bilingual user docs `022d686` `54393d8` `c46fa3c` `9a0f321` `8baa85e` `0a6a1c7` `ace6334` `e44f959`; designs and plans `2f62ac2` `df9553d` `2342ef9` `84f8c08` `38fd5b6` `09ea325` `6d7bc7f` `26ff4e9` `5796b07` `54dfb64` `a165a63` `3c85408` `a87e5cf` `b156296` `393932a` `375725b`
- Visual baselines updated (CI-generated, human-reviewed): `a1f0f8a` `886ac7a` `b505e48` `04c1756` `ff37adf` `6ff6fce`
- Engineering: `84541b9` package-lock version sync; `b6663cd` `1e77b18` workspace dependency declarations and externalize fixes; `4e5171d` `2bf7a94` eval-side declaration consolidation and predicate-index anti-rot tests

## v0.1.16 (2026-07-31)

This release = the 17a+17b mitigation counterfactual suite (mitigation accounting and counterfactual reasoning added to the death recap card) + the full-week adversarial audit fixes (OBS recording / window analysis / key security and more) + the DeepSeek backend graduating.

### AI analysis (DeepSeek backend graduates / spell names and causal wording / local CLI stability)

- `eeb291e` New AI backend: **DeepSeek API** (official api.deepseek.com, models V3 and R1), now graduated (the content of the former v0.1.16-ds.1 test build); `04006af` a streaming reply that ends early is no longer silently truncated into a "normal" result; `c2f14e3` a decoder flush at the end of the stream, so trailing multi-byte Chinese characters aren't swallowed; `b824e72` the rule that spell names must keep their original English strengthened, suppressing DeepSeek's habit of translating them into Chinese; `c792076` timeout and stall watchdogs plus error-message redaction on the client, so a stuck request no longer waits forever
- `d9bfbfa` New detection for Chinese-ized spell names (spellNameZhLint): when the AI coach's text translates a spell name into Chinese it is caught automatically and restored to the original English; `1b48d39` `91f7d0e` `331895b` `8aa766b` four review rounds closing false-positive gaps (negation guards, hedge exemptions, gloss guards)
- `d249c3a` Causal-certainty wording detection (causalLint) gained Chinese patterns — production defaults to Chinese, so this had been a zero-coverage blind spot; `aed104d` `22eb6f2` two review rounds fixing missed negation guards (the single characters 未/不, false exemptions across clause boundaries, and other bypasses)
- `1ccfcab` `9d50192` Stop-word list for inline spell icons completed (common words like Heal / Push / Pull previously collided with spell names and had their icons stripped)
- `6213503` `22e3ac5` The cooldown-availability algorithm behind "defensive available at death and never pressed" extracted into a single predicate, with boundary fixes (a cast that only happens in the future is no longer judged "available at the time")
- `d4910f5` `1936e70` `e6d1b50` Three stability fixes for the local CLI backends (Claude / agy / Codex): multi-byte UTF-8 output no longer garbles across chunks, a failed version probe now says "the version may be incompatible", and in-flight analysis processes and requests are genuinely reaped when the app exits

### Report (death recap card: mitigation accounting / counterfactuals / icons)

- `2e00956` New spell mitigation reference table (two-layer generation + 35 whitelist entries curated by hand, with ambiguous spells annotated honestly rather than guessed); `c8ce5b0` the generation layer grounded in official SpellEffect data, so uncertain spells are marked pending rather than guessed; `8572bde` `322ffc2` `f7b0f38` three rounds correcting individual spells' mitigation judgments (Darkness, for instance, reclassified as conditional mitigation rather than none)
- `ac7a81d` The death recap card gained **mitigation accounting + counterfactual reasoning**: how much damage each mitigation you used actually absorbed, how much damage you took during immunity, and what would have happened had you pressed a defensive. The same arithmetic is written into the [DEATH] line of the AI analysis, so the card and the text agree by construction; `f97f06e` counterfactuals graded into three tiers (clearly survivable / marginal / still dies) with the judgment predicate single-sourced; `d335aee` `9f30824` a sixth tier for "avoidable death" + candidate judgments for questionable externals; `00950fc` counterfactual linking switched to matching on spell name + exact instant, so identically named spells no longer get attributed to the wrong occurrence; `4e5aad3` faction filter fixed + window constants single-sourced; `93627b0` `be34e8a` the death-settlement external table expanded 7→14 entries + two zoneId read fixes (including a line-of-sight regression test); `9b7410b` the six-tier annotation properly wired into the timeline branch (it was dead code in production and had no effect); `ddea0e5` the immunity accounting row reworded to prevent misreading
- `6d36798` Spell names on the death recap card switched to inline icons (previously only the AI analysis text had icons)

### Match recording (OBS reconciliation / exit safety net / retention policy)

- `8495025` After an OBS disconnect, the actual recording state is reconciled, eliminating the cascade of orphaned-recording failures; `0b8b98c` reconciliation now requires positive evidence, so it no longer stops a recording the user started manually in OBS; `05c5f82` the app waits for the recording to actually stop before exiting, otherwise OBS records forever; `199adec` "does it need a password" modeled honestly as three states, so a missing field is no longer read as "password required"; `811abc9` four recording-index fixes: match linking misjudgments, orphaned recordings crowding out retention slots, a disk usage leak, and some recordings never entering the index's visibility

### Window analysis (#16: cross-talk fixes / caching / retry)

- `2278430` `016c9ce` Two fixes for switching rounds in Solo Shuffle: the previous round's leftover window AI analysis is no longer rendered, and round-change state cleanup is now precise instead of remounting the whole component; `324f616` `db49a99` the window analysis cache honestly records the final state "the analysis genuinely found nothing", so reopening the same time window no longer pays for another model call (with three corrections: version stamp, backend-model criterion, and time-key precision); `22ed56d` clicking **Retry** manually now forces a fresh request instead of being blocked by that honest empty final state

### Settings and security (safeStorage / keys)

- `1748ee5` API keys on disk are now encrypted with Electron's safeStorage (they were previously plaintext in the config file); `afa63d3` saving settings only encrypts/decrypts the key fields this change actually touched, so saving an unrelated setting can't wipe an already-saved key; `bbf4a04` the agy local backend on Windows goes through the safe `.cmd` path, eliminating a local command injection risk from splicing prompt content into command-line arguments; `cf27f44` agy's on-disk directory narrowed to a dedicated subdirectory + cleanup of files left behind by a crash

### Data and tooling (corpus-tools; not shipped in the product, but it affects data quality)

- `187e4f3` fetch-pvp-logs corpus downloads gained bracket (BRACKET) validation + rate limiting on paged requests, to be a more polite client of the external API; `c9c463e` truncated downloads are now caught instead of contaminating the corpus via the manifest and dedup set; `7e8b8b3` out-of-repo backups gained a gitignore, and missing GCS metadata fields are modeled honestly; `f2d68c9` a warning is logged when the local corpus override file is corrupt — the silent fallback previously gave the user no clue why

### Other

- Mitigation table and 17a+17b design / plan / accounting docs: `514a3c5` `189367e` `7756c13` `288bfc7` `1b894f2` `baaf252` `6c1f8d1`; `01034bd` the #17b feasibility quantification report; `d111b87` the causalLint Chinese blind spot recorded; `c55c583` 10 P2 items from the full-week adversarial audit logged
- Visual baselines updated: `7c07e88` `c8b58a3` `901ee50`
- `04a82f6` release: v0.1.16-ds.1 (the DeepSeek test build, whose content graduates in this section)

## v0.1.16-ds.1 (2026-07-30, test build)

DeepSeek backend test pre-release, based on v0.1.15. It graduates once the real-model smoke test (enter a key, analyze one match) passes.

- `eeb291e` New AI backend: **DeepSeek API** (official api.deepseek.com, OpenAI-compatible streaming), models V3 (chat) and R1 (reasoner). Select it on the settings page, enter a DeepSeek key, and it works; with no key it falls back to the deterministic path. R1's chain of thought never reaches the output. Note: unlike the local CLI, this sends data to DeepSeek's servers.

## v0.1.15 (2026-07-30)

Phase 1 of information linking on the recording tab (i.e. the obs.6 test build graduating), plus corpus tooling and docs.

### Recording tab (graduated; details in the obs.6 section)

- `5969efa` Alignment marker bar (gold band = burst window, ✕ = death, ⚠ = mistake, click to seek) plus a playback event feed on the right (kill-feed style slide-in / fade-out / push-up; scrubbing does not replay skipped history; can be toggled off)

### Corpus tooling (not shipped in the product)

- `102eb1c` Archive fetch-pvp-logs output to Google Drive (incremental rclone sync + DRY_RUN + readable guidance when rclone is missing or unconfigured)

### Other

- `859c954` backlog #20, AI analysis chat box recorded; the merge and release engineering commits from `24f69f6` onward; the developer guide gained a "development dependencies" section (rclone as an optional dependency)

## v0.1.15-obs.6 (2026-07-29, test build)

Phase 1 of information linking on the recording tab (brainstorm options A+C, finalized), based on v0.1.14.

- `5969efa` New on the recording tab: an **alignment marker bar** below the video (gold band = burst window, ✕ = death, ⚠ = mistake, click to seek) plus a **playback event feed** on the right (kill-feed style: slides in from the bottom as playback crosses each moment, fades out after 5 seconds while the ones below push up; deaths / mistakes / bursts / crowd control / dispels / defensives, plus 🤖 deep-dive moments on matches that have been through AI analysis; scrubbing does not fire every skipped event at once; toggleable and remembered)

## v0.1.14 (2026-07-29)

Two lines converge: phase 1 of OBS match recording (five test builds obs.1–obs.5 converged, verified across five rounds on a real Windows machine) and three backlog features landed on main in parallel. The recording work is itemized in the obs.1–obs.5 sections below and is not repeated here; the main-side changes follow.

### Match recording (OBS, officially merged)

- Summary: automatic start/stop of recording, time-window linking, a dedicated recording tab, a synced picture-in-picture on the replay page, OBS auto-detection, sharing one recording across all six Solo Shuffle rounds with a clock reset on round change — see the obs.1–obs.5 sections for details

### Inline spell icons in AI text (#15)

- `edd2413` `4d59b5f` `cb91248` `58ccfef` Spell and spec names in AI analysis, comparison commentary, and finding cards render as icon + text
- `a6cfffa` `e06b632` `7e9cbcd` zhCN spell-name dictionary and an inverted index of English names (data layer)
- `4455689` `f79e90c` `0d36c01` Three fixes: possessive text missing a match, ultra-short placeholder names, first-paint rich-text self-healing
- `15795c1` `def748f` Visual baselines updated; `39fb7bd` datagen build number pinned

### AI analysis of a selected window in the report (#16)

- `c46c82d` `ee54ba4` New **Analyze this window** button on the time-window toolbar: drag-select any span and deep-dive it in one shot, with the final card attached under the toolbar
- `50c80c6` `8fb8375` `606117e` The deep-dive path parameterized with windowOverride, plus a window-mode prompt (neutral framing + an empty-output contract)
- `63d3c68` `c19cc42` `d1f743e` Review fixes for cross-window lost updates, stale responses, and the busy final state; `46d5977` `a051abe` test bed and baselines

### Pressure swimlanes on the timeline (#4)

- `1ea4397` `c10c38f` `0ea46f1` New thin pressure/exposure swimlanes on the Timeline: clicking a DMG SPIKE sets the window and feeds straight into window analysis; healer exposure markers enter the axis
- `f48d4e6` Three fixes from an all-branch review of the healer exposure orchestration; `0ad6134` visual baseline; `2767b3a` the TimelineStrip sync item investigated and written off

### Zero-config local CLI backends (separate)

- `eab287d` `5af87e5` Automatic path detection for the claude / agy / codex commands (Windows and macOS), with the detection result shown on the settings page
- `8686bd7` When agy exceeds the Windows command-line limit, the prompt is relayed via a file on disk automatically

### Analysis and infrastructure (separate)

- `c62f905` `562c988` The three divergent implementations of "available at death and never pressed" converged onto the single `cdAvailableAt` source (BACKLOG #18)
- `e32f095` F170 `[ENEMY HARD CAST]` wired up to castStartEvents (0/208 → 28/208 matches)
- `c837f73` `ce267ac` SP-B2.1: `reference_vectors.json` supports hot-override from userData, plus two review fixes
- `6eb3715` fetch-pvp-logs corpus tooling (corpus-tools, not shipped in the product); `bb545a3` compliance correction and backlog #19

### Other

- Spec / plan / accounting docs per feature and backlog status updates (`c6a173e` `9d8f432` `bbc8887` `e70779f` `6007500` `a6e38c2` `253fb55` `732f43b` `e626be5` and others); merge commit `24f69f6`

## v0.1.14-obs.5 (2026-07-29, test build)

Fourth round of real-machine feedback; otherwise identical to obs.4.

- `d1d6227` New **Auto-detect OBS** on the settings page — it reads the local OBS WebSocket configuration directly, fills in the address and password, and tests the connection, so you no longer have to copy the password out of OBS by hand. If the server isn't enabled, it tells you which box to tick in OBS
- `0a5b98a` When switching rounds in Solo Shuffle, the replay clock (and the video) stayed at the previous round's moment — changing rounds now resets to the start of the new round

## v0.1.14-obs.4 (2026-07-29, test build)

Third round of real-machine feedback; otherwise identical to obs.3.

- `a2c9bfe` New standalone **Recording** tab — a full-width native player (draggable, volume, fullscreen) that seeks to the start of this match (or this round, in Solo Shuffle) on open. Shown only for matches that have a recording. The synced picture-in-picture on the replay page stays, for second-by-second comparison against the combat timeline

## v0.1.14-obs.3 (2026-07-29, test build)

Fixes from the second round of real-machine feedback; otherwise identical to obs.2.

- `1cbcaf4` In Solo Shuffle only the first round could see the recording — the whole recording is now shared across all 6 rounds, and opening any round seeks to that round's moment

## v0.1.14-obs.2 (2026-07-29, test build)

Quick fixes from the first round of real-machine testing; otherwise identical to obs.1.

- `5be0fdf` **Test connection** on the settings page now uses the current contents of the input fields (it previously used only the saved values: typing a password and clicking test without saving first connected with an empty password and reported an auth error; the address field had the same problem)

## v0.1.14-obs.1 (2026-07-28, test build)

**Functional test pre-release** of phase 1 of OBS recording (driving OBS externally via obs-websocket), from the `feature/obs-recording` branch and not merged to main; it merges and ships as an official release once verified on a real Windows machine. It also carries the first batch of arenacoach analysis enhancements that landed on main after v0.1.13.

### Match recording (OBS, phase 1 test)

- `d40d873` `df70b55` Live awareness of match start and end: the recorder is notified automatically when a match begins (a stop signal is also re-sent on abnormal paths such as switching log files or directories)
- `435c7a1` `06a19c8` Connects to your own OBS install (28+, with the WebSocket server enabled) to start and stop recording automatically; the address and password are configurable on the settings page (the password is masked when read back). If OBS isn't running you just get a notice — match ingestion is unaffected
- `cb553b2` Recordings are linked to matches automatically by time, with a configurable "keep the last N matches" policy that cleans up old video
- `9fd72dc` `a0350e1` Play the local recording directly inside the report (scrubbing supported); recording stops automatically when the app exits
- `1675f68` New recording picture-in-picture on the replay page: synced to the replay clock, so the video follows when you jump to a death, a mistake, or an event
- `3c15987` `084106d` New **Match recording (OBS)** group on the settings page: enable/disable, address, password, test connection, retention policy
- `35829c2` Six fixes from cross-AI review: replay scrubbing past the end of the video pegged the CPU, a single corrupt line in the recording index lost the whole library, stopping the recording manually in OBS made it refuse to record subsequent matches, closing settings mid-match missed the stop, switching directories missed the stop, and the retention count was written to disk on every keystroke

### AI analysis (arenacoach batch 1, from main)

- `ea25e77` `99b67d8` New mistake detection: a defensive was available when you died and you never pressed it (with a separate judgment for abilities usable while under crowd control)
- `ce92a37` New mistake detection: your external mitigation was available when a teammate died and you didn't give it
- `40a1011` `127b711` New mistake detection: wasting the PvP trinket in a neutral situation (pressing the trinket when there is no crowd control to break)
- `4c45b29` Ability-availability judgment unified into a single predicate; defensive CD analysis refactored onto the same source
- `89dc8e8` The three detections above wired into the AI coach prompt and the mistake list
- `a95991e` `dca4b52` Five gaps fixed in dispel/death analysis (investigated from a viewer report on Bilibili) plus two review findings adopted (ownerId fallback, trinket event deduplication)

### Other

- `b7a15d1` `843e7bb` Type and static-check patches; `9337cef` corpus scan; `a3dbcac` settings page visual baseline update; `9e170bc` `5d74c52` `906a1cf` `72d2832` `644fd5f` `48c36b8` docs (evaluation / plans / backlog)

## v0.1.13 (2026-07-27)

Origin: user feedback that "clicking AI analysis one match at a time is too slow" — batch analysis added.

### AI analysis

- `b807b1f` Batch AI analysis: a new entry point at the top of the match list. Pick "the last N unanalyzed matches" and it runs the full analysis (including the deep-dive round), identical to the manual one, match by match — already-analyzed matches are skipped, progress is live, and you can cancel at any time. Navigating away to another report doesn't interrupt it.
- `b807b1f` Solo Shuffle is analyzed round by round, matching what you'd get clicking through the rounds manually; a round that was already analyzed on its own no longer causes the rest of the match to be skipped.
- `b807b1f` Cancelling the batch stops only the batch, and no longer affects a manual analysis that is running.

### Other

- `6ac67d7` New FAQ (aimed at new users), linked from the README.
- `02075bc` Match-list visual baseline updated (batch analysis entry point).

## v0.1.12 (2026-07-26)

Origin: a performance push (opening a match, the replay, and first paint all made faster) plus cross-match self-learning (new feature)

- Codex local backend plus three pieces of UI feedback.

### Performance (faster to open, lighter on memory)

- `ea8ef76` Opening a match: 1244ms → 37ms. The main process passes bytes straight through instead of materializing the whole object graph; main-process heap growth 207MB → 0.
- `b425718` Whole-library slimming migration: total match file size 75.2GB → 49.0GB (−35%), with old archives self-healing on read; the slimming predicate has one source.
- `bc6c8d7` Three main-process stalls eliminated: fetching raw log lines, importing history, and rebuilding the index are now streaming or pushed into a worker, so the UI no longer freezes.
- `eee7006` Steady-state replay rendering cost cut roughly a hundredfold: GCD swimlanes windowed, event table virtually scrolled (scrolling to the bottom no longer piles up a hundred thousand DOM nodes).
- `2d7ecc7` Replay sample lookup switched to binary search, and two memory accumulations that grew with playback duration plugged.
- `d8c1b97` Minification enabled for production builds (the 3.6MB bundle had never been compressed).
- `ee7ff92` `7b69443` `67ddc95` `331b1f1` Lazy loading and size reduction for the big data tables (spell names / talents / icons / effects): the main process and first paint no longer pay startup cost for tables they don't use.
- `bba4ed9` Report HP curves downsampled; hovering no longer rebuilds the curve paths every frame.

### AI analysis / cross-match self-learning (new)

- `cef6a85` `ef7da45` Findings from every AI analysis are recorded automatically in a local learning ledger, with historical analyses backfilled in one pass; the ledger is not invalidated by prompt version bumps, so memory accumulates purely forward.
- `a78ce4a` Deterministic pattern mining: a problem is only judged a "stable pattern" when it appears 5+ times in the last 20 matches with a stable distribution; conditional slices by enemy class and by map are supported.
- `78ae67e` `25c740e` The AI is only responsible for turning a statistical pattern into plain language, and the text goes through a placeholder-discipline audit (no bare numbers, no causal assertions); violations discard the whole entry.
- `5642ef4` `f2176f0` Consolidation service: it consolidates automatically once 10 matches have accumulated. The statistical part is always persisted, so a failed AI summarization only leaves the description text missing, and the next round fills it in.
- `0abbcfe` `23fea3c` A "recurring problem · N times in the last M matches" badge appears on report findings — matched deterministically by the rule engine, with no AI call.
- `88403a8` `6a2b6a5` `a4e571b` New **Long-term patterns** card on the statistics page: the rule list, active/improved status, frequency trend every 5 matches, evidence-chain jump into the report, and manual re-consolidation; it subscribes to backfill progress and surfaces consolidation errors.
- `9829abe` `97fd96a` Acceptance tool `learning:scan`: three-level numeric review across ledger, patterns, and rules, able to prove it isn't missing anything.
- `1efd7f4` Exceptions in the ledger write hook are isolated, so they can never affect the main analysis flow.

### Settings / AI backend

- `7d2792d` `a71a6c9` New local AI backend: Codex CLI (OpenAI gpt-5.5). No API key needed; it shells out to the local `codex` command. The clean reply is taken from the output file, and the empty-reply and concurrent-invocation edge cases are handled.

### Event table / statistics / report (three pieces of UI feedback)

- `82c39df` The statistics page widened to 1280px and centered (it was 900px pinned left, leaving half a widescreen empty).
- `82c39df` The spell column in the event table gained spell icons (including tick-aggregated rows), with no impact on row height or virtual scrolling.
- `82c39df` The death recap now lives only in its permanent slot in the report's right column: clicking a death marker in the replay or the events view switches to the report to show it, and the floating overlay is gone — no more duplication in two places.

### Other

- `3bfd9bc` `abc0e11` Design doc and implementation plan for the self-learning feature (including the cross-match key correction).
- `79a2e0c` `bb1a33b` `126df6d` Test/CI repairs: unused imports flagged by lint, pre-warming the deepDive module on slow CI machines, removing temporary artifacts committed by mistake.
- `a3d72b3` `9d3da81` Visual baselines re-recorded for the event table windowing, statistics centering, event icons, and the Codex copy on the settings page (generated from a single CI source, reviewed image by image).

## v0.1.11 (2026-07-26)

Origin: empirical user feedback — a Holy Priest was told off every match for "not using Desperate Prayer", but matches where they were never attacked should never have raised it.

### AI analysis / mistake list

- `af248a1` "Defensive CD unused all match" gained a pressure gate: it only fires when the lowest HP of the entire match was <60% (empirically, across 12 Holy Priest rounds: the 8 falsely flagged rounds all bottomed out at 70–94%, while the rounds where a defensive was genuinely pressed bottomed out at 9–52%; under the same criterion, false positives went 8/12 → 0/12). The mistake list and the AI prompt share one source, so clean matches where you were never attacked no longer show this entry and the AI no longer lectures about it. Matches with real pressure are unaffected.

### Other

- `055414d` `d97a657` Supporting fixes: in-source tests adapted to the new signature; battle/synth visual baselines re-recorded to follow the gate (human-reviewed to confirm it works both ways: the low-pressure row disappears, the high-pressure row stays).

## v0.1.10 (2026-07-26, re-published same day)

Origin: the death recap visualization upgrade (v2, finalized) + a developer-page scale fix + interaction repairs + a test coverage push (six tasks). The first publish carried the v1 two-column curve; based on feedback it was reworked to per-row health bars and re-published the same day, so assets share a name but differ in content.

### Replay / report

- `3d52ce2` `60a541a` `c4f5d98` Death recap upgraded: every row is now "ability + number + health bar", where the bar draws the health interval before → after that ability took effect — red = health lost, green = health gained, hovering shows "82% → 61%". Damage numbers are red, healing green. The before/after health is exact to the event (the same-timestamp sample from the advanced log); the column is left blank on old logs that have no advanced data. (The interim v1 two-column curve was superseded by v2.)
- `85ce27c` AI analysis key-moment axis: "+N minor moments" can now be collapsed again after expanding (previously there was no way back).

### Developer page

- `4d3d96a` The detail preview is capped at 256KB: it previously rendered the entire match JSON with no limit, and a real 25MB match in the library froze on click (>30s unresponsive → 501ms). Over the cap it shows the full size and the file location.

### Other

- `477f473` `64011c6` `460c3ee` `f5d3055` `3df3e1e` `b359bf9` Test coverage push: tests added for four analysis context files and the eval auditor (criticalMoments 7.61%→83%, timelineSections 53%→98%, resourceSnapshot 58%→92%, judgeSpotAudit 0→100%), plus coverage measurement infrastructure (`npm run coverage`).
- `fec622d` `7b003b9` `2dee06f` Visual baselines re-recorded across two rounds of the death recap rework (both human-reviewed); E2E navigation switched to exact matching, fixing a race where it collided with a substring of the recap card's button.
- `8fb4869` `eb7c43c` `c19bf25` `ab2f1d7` `f56e6b6` Docs: the coverage-improvement plan backfilled at close-out, the death recap v1/v2 designs and implementation plans, and CHANGELOG infrastructure plus the retroactive entries for v0.0.1–v0.1.8.

## v0.1.9 (2026-07-25)

Origin: full implementation of the external review "调整方案.md" (adopted after an agy debate, with five corrections) plus the category enumeration as a separate task.

### Event table

- `4d4f9ab` Death-cleanup folding (≥5 consecutive "− lost" rows on the same target fold into one aggregate row, with a "death cleanup" chip if a death occurred within ±1.5s), periodic tick aggregation (≥3 consecutive from the same source and spell → ×N summed); sticky header and self-contained table scrolling; the "show 300 more" button replaced by near-bottom scroll loading with automatic page filling; kind filters replaced by pills (color dot + count); p95 micro-bars on damage/healing amounts, color-coded; death rows highlighted with a "▶ death recap" shortcut.

### AI analysis

- `f22776e` The key-moment axis became two-tier: deaths and bursts keep full pills, while defensives, dispels, and crowd control drop to small text rows; same-kind same-side bursts within ≤5s fold into "{kind} ×N"; past 40 entries a "+N minor moments" valve appears; icons unified to text glyphs (no emoji); severity mapped to Chinese (high/medium/low); evidence chips gained short event-name labels.
- `877c77d` `category` narrowed from a free-form model string to an eight-slug English enum (prompt constraint + normalization in the audit layer + aggregation on the normalized key), with a Chinese vocabulary on the render side (survival / cooldown usage / positioning / target selection / crowd control / interrupts / dispels / offense). Real-model smoke test: enum compliance 9% → 100% (6 matches, sonnet, Chinese replies). Cross-match aggregation of the mistake notebook is stable from here on.
- `168af31` (part of P3-1) Cohort card: a single dimension no longer renders "strongest/weakest"; percentile wording unified to "Nth percentile · above/below the median of this bracket"; specs in Chinese (a 42-spec vocabulary), and "sample: N matches".

### Report

- `c5e3f33` The interrupt / dispel / burst ledger / mistake list cards keep their frame on empty data plus a one-line empty-state message (0 mistakes shows "clean match"); aura uptime grouped by unit (group header in class color + indentation + expand past the top 6) plus 0:00/mid/end ticks and a category legend; severity filter chips on the mistake list (minor hidden by default past 12 rows); opening the death recap in the report auto-expands the most recent friendly death (dismissing with ✕ stops it reappearing for that match); an HP curve legend row (click = hide curve), ⚠ markers closer than 8px clustered into ⚠N, and death labels anchored left to avoid adjacent ⚠ markers; the W/L pills in the Shuffle report header double as round switching (R{i}·W/L, keyboard accessible), replacing the separate Round tabs row.
- `168af31` (part of P2-2/P3-2) Graded abbreviation of meter values (1.54M / 568k, with the exact full value kept in the title, same spec in the treemap details); duration chip and kill-result chip at the end of window list rows.

### Replay

- `00a2efd` Name labels on the map shown on demand (rendered only on hover / HP<50% / during a burst) with a black-outlined backing plate and automatic lift to avoid neighbors within 70px; a "standard/compact" setting for the GCD swimlanes (compact = 88px column width, chips reduced to icons only, remembered in localStorage) plus gold kill-window jump chips below the swimlanes (clicking seeks both columns on the shared clock); the two-line shortcut/legend text at the bottom moved into a ? button at the right end of the control bar.

### Global

- `fddbf13` Spell names unified across the app: five `getEnglishSpellName` call sites in the render layer replaced by the single `displaySpellName` source (the log's own name passes through, and only an empty one falls back to the dictionary). English dictionary names in CN matches: 1299 occurrences → 9 (all remaining ones are verbatim from the log).

### Other

- `51e875f` `4f32916` CI fixes (empty-state assertions inverted to follow the new behavior, chip fallback, a file that wasn't committed).
- `5e5a2ca` + `51e875f` include: seven of nine visual baselines re-recorded (reviewed image by image).
- `d888619` Session write-up docs (the prod-triage skill and others).
- `049d6c4` Release bump.

---

Everything below is **retroactive** (generated from git history on 2026-07-25: each version = `git log v<prev>..v<new> --oneline --no-merges`; versions with more than 40 commits list only feat/fix/perf, omitting chore/docs/test/refactor and so on — see git log for the full set).

## v0.1.8 (2026-07-25)

- `f5e63fd` release: v0.1.8 — GCD swimlane folding (one row per instant + small off-GCD icons, user's design)
- `b302351` chore(qa): visual baselines — regenerated for the folded swimlanes (human-reviewed: same-instant folding into one row, small off-GCD icons, gold trim on majors)
- `0751bf4` feat(desktop,analysis): GCD swimlane folding — multiple abilities at the same instant collapse into one row, off-GCD actives fold into small icons (user's design)

## v0.1.7 (2026-07-25)

- `70585a9` release: v0.1.7 — GCD swimlane re-axed: exact alignment to the instant (mean drift 15.8s→0), overlaps stepped horizontally
- `a89c46f` chore(qa): visual baselines — regenerated after the swimlane re-axing (human-reviewed: exact alignment, readable stepping)
- `7d75573` feat(desktop): GCD swimlanes re-axed — vertically pinned to the real instant, overlaps stepped horizontally, drift 92%>0.5s (mean 15.8s) → 0

## v0.1.6 (2026-07-25)

- `6783147` release: v0.1.6 — aura dashed-inference correction (phantom full-match dashes eliminated) + a latent CC duration data bug fixed
- `39bad78` chore(qa): visual baselines — uptime cards regenerated after the aura dash fix (battle/window, human-reviewed: the phantom full-match dashes are gone)
- `1af0d55` fix(analysis,desktop): aura dashed-inference correction — dual sources keyed separately / DOSE opens a segment / capped at the official duration, plus a latent overrides empty-shell bar-squash bug

## v0.1.5 (2026-07-25)

- `747ff60` release: v0.1.5 — Bloom false-positive fix / icons missing 89%→0.05% / DR table taken from official data / dispel fallback dual-evidence cleared
- `183fc23` chore(qa): visual baselines — Bloom-class genuine presses regression + full icon-name resolution, report-replay regenerated (human-reviewed)
- `92a91cd` fix(analysis,eval): icon universe finalized — union of three sources at 1.5MB, no coverage loss (0.05% missing), within the first-paint budget
- `028e625` feat(analysis,desktop): three items closed out — Bloom false-positive fix / icons made exhaustive, 89%→0.05% missing / DR table taken from official data (which caught 2 misjudgments + 1 silent failure)

## v0.1.4 (2026-07-25)

- `210a884` release: v0.1.4 — swimlane endgame gate (Devour/Phantom cleared, 5.3% folded, 0 false positives) + the official 17-pair PvP replacement table
- `2267f7e` fix(desktop): swimlane gate endgame — keep by default + layered veto, false positives eliminated, 5.3% folded, Devour/Phantom cleared
- `cef7d32` feat(analysis,desktop): homemade data replaced by official data — PvP talent replacement table (17 official pairs) + a player keypress table (swimlane junk eliminated, folding 44.5%→1.9%)

## v0.1.3 (2026-07-25)

- `d883607` release: v0.1.3 — doc slimming (−39%) + self-healing migration on read, fixing the 2GB+ memory climb (and clearing out temporary scripts committed by mistake)
- `0f7196b` fix(parser,desktop): doc slimming — a 442MB single match / 2GB+ memory incident, params sparsified for −39% + self-healing migration on read

## v0.1.2 (2026-07-25)

- `beb926a` release: v0.1.2 — GCD swimlane noise filtering (folding 44.5%→10.5%) / cast queue tolerance / Scorching Gaze replacement / illegal placeholder hole plugged
- `927c4eb` chore(qa): visual baselines — report-replay regenerated after swimlane noise filtering (the other 8 byte-identical, human-reviewed)
- `43d22c6` fix(desktop,analysis): GCD swimlane junk casts folding real abilities / cast queueing falsely counted as kicked / PvP talent replacement not modeled
- `070c923` fix(analysis,desktop): three agy flash review findings adopted — illegal placeholder hole plugged / silent retries / facts key namespace contract

## v0.1.1 (2026-07-25)

- `1cbbe1c` release: v0.1.1 — fixes for "only 2 entries / malformed output": index placeholders + a larger max_tokens + bad-json retry; includes the production verification driver
- `9ca89e8` fix(analysis,desktop): two symptoms from 0.1.0 production feedback — "only 2 entries" and "malformed output"

## v0.1.0 (2026-07-24)

- `4b744c1` feat(analysis,eval): solvability confidence gate — corpus-verified rate for missed-cleanse/purge claims 92%/79% → 100%/100%
- `f5a7f54` feat(analysis,desktop,eval): evidence menu widened — healer perspective 3.4→8.6 entries per match, three-phase coverage 0/17→11/17
- `2fff58a` fix(qa,desktop): path-4 assertion basis corrected — the off-screen window starts at 500 tall, so only >600 actually proves full-page capture
- `e05c1e5` chore(qa): visual baselines — a new "export image" button on the report toolbar, 3 report-* regenerated
- `a9569dc` feat(parser,desktop,eval,docs): the remaining four verifiability roadmap items closed out — B2 raw line-number deep links / trust chain e2e / B3 coverage wiring / C3 image export
- `af5cd37` chore(qa): visual baselines — UI changes from df2789c (time-window bar / mistake card / uptime / events view), 4 report-* regenerated
- `473101d` feat(eval,docs): B1/SP-A.1 causal judge calibration closed — causal-hardening detection 50%→80%, five verifiability roadmap items closed out
- `df2789c` feat(parser,eval,desktop): verifiability roadmap A2/A3/C3/B2 landed
- `95b8581` docs(backlog): #8 deterministic mistake detection v1 closed (release/0.1)
- `6af9185` chore(qa): visual baselines — phase 4 items ④②③ (mistake list / ⚠ markers / aura uptime / events view)
- `c59ba8c` feat(desktop,analysis): aura uptime + events view + deterministic mistake engine — phase 4 items ④②③ landed
- `ccd9e72` chore(qa): visual baselines — time-window toolbar (battle/synth) + a new report-window selected state
- `04cdabe` fix(desktop): TimeRangeBar echo tolerance raised to 1s — the band's true value 36.734 vs. the rounded label 36
- `b9a3142` fix(desktop): the TimeRangeBar phase dropdown echoes by tolerance matching — band bounds carry fractional seconds
- `5c29c2b` test(desktop): report-window visual scenario — the time-window selected state enters the baseline
- `e1be96d` feat(desktop): time-window linking — phase 4 item ① WCL timeframe/phase interaction landed
- `14e414a` chore(release/0.1): open the major version branch — version bumped to 0.1.0 + phase 4 design finalized

## v0.0.18 (2026-07-23)

- `2cd5595` release: v0.0.18 — interrupt/dispel dashboards, comp and date filters on the list, enemy trinket inference + 7 discrete CDs for missed dispels
- `dc06585` chore(qa): report-synth baseline updated — the fully-populated panel enters the baseline (the other six byte-identical)
- `78b9ac5` test(desktop): synth fixture injects an interrupt hit + a missed purge — visual baseline covers the fully-populated panel
- `bb85992` docs(backlog): #2/#3/#9 closed + zh/EN switching verified as already done
- `0ba6cca` chore(qa): visual baselines regenerated — interrupt/dispel panels + the comp and date dimensions on the filter bar
- `793e127` fix(desktop): the date group in the filter bar packed as an unbreakable unit — the separator no longer orphans when a narrow sidebar wraps
- `fc2c73b` feat(desktop): list filters gain comp (multiple specs on one team) and a date range — backlog #9 wrapped up
- `f145aaf` feat(desktop): interrupt/dispel dashboards — backlog #2/#3 landed together
- `3746c55` feat(eval): §7ter enabled + templateDuplicateRatio given its own tier — two eval decisions landed
- `6949e20` feat(analysis): an enemy trinket never observed being used is inferred available + 7 discrete active CDs added for missed dispels — two product decisions landed
- `08dcf63` docs(backlog): Layer B three-fix re-review closed — before/after numbers complete + the noise re-anchoring side effect logged pending a decision
- `65c791d` feat(eval): the sufficiency coverage gate adjudication landed + a blindPool matchId placeholder convention — 14.2/14.4 closed

## v0.0.17 (2026-07-22)

- `580b4e4` release: v0.0.17 — DMG SPIKE start/end timestamps, monk interrupt spec routing, eval rubric basis fixed
- `d243f4b` fix(analysis,eval): three real bugs dug out by the 300-match Layer B evaluation — DMG SPIKE start/end ambiguity / monk interrupt misjudgment / a gap in the noise basis
- `6a5a905` docs(backlog): 14.2/14.5 closed — stale status and one overturned old conclusion fixed
- `cd21b15` docs(handoff): §1 wrapped up — 6/7, Layer B can start
- `22af6fd` docs(report): all 80 items re-scored after the cap was fixed — 4/7 → 5/7 → 6/7, more headroom
- `d39b34b` fix(eval): the 12-entry cap on the audit set was eating trailing fabrications — raised to 20 and, past the limit, takes both ends
- `c0bd0d2` feat(desktop): CLI for bulk backfill of historical logs — with a disk guardrail
- `b269b90` docs(handoff): §1 completed with the full 7-dimension results — 5/7 met but fix the 12-entry cap first
- `eaa2af1` docs(report): §0 scope corrected — scores-det2 is already all 80 items, not 30
- `9f583be` docs(report): full 7-dimension verdict — 4/7 → 5/7 met, but fragile and with one rule artifact
- `0df6532` docs(handoff): §1's hard todo closed — points at the 2026-07-21 verification report
- `277e80d` docs(report): third round of rubric validation — anchor noise eliminated, fact-checking misses unchanged
- `4ded221` feat(eval): the judge variance criterion hardened into a script — the primary criterion is now "the set of errors found"
- `30bd91b` docs(handoff): full takeover instructions — judge variance is the only hard todo, and the two product decisions must not be made on the user's behalf
- `a80f3f6` docs(report): stale status removed from the survey doc — the §1 table and §3 both still said "not checked"
- `aa1d5e4` docs(report): full numbers for the missed-dispel fix — 822 → 2251 rows, all gates green with no losses
- `0294de7` docs(report): root cause of missed and folded dispels — 73% of the "77% empty" is correct silence
- `2f1954c` fix(analysis): 7 of the 9 entries in the missed-dispel whitelist were dead — the three paladin blessings added + a consistency assertion
- `737e39c` docs(report): item-by-item conclusions from the four-item survey — P1 fixed, P2/POSITIONING need no action, P3 left for a human
- `bf17ccf` feat(analysis): enemy ability groups share a source with friendly ones — closing the evidence gap in 65% of matches
- `329589d` docs(report): evidence gap survey — enemy cooldowns entirely untracked in 65% of matches
- `9e257f1` docs(handoff): judge variance and the Layer B blocker — there is a real todo
- `3d92ba3` docs(eval-baseline): accuracy anchors switched to a lookup table + numeric claims must be written side by side with the value
- `5e9415e` fix(eval): factAudit length convention relaxed to [3,12] + 14.5's unproven result recorded honestly
- `cca541c` docs(eval-baseline): the factAudit audit set is now rule-determined, and accuracy is scored only against that set
- `f8a74cd` docs(backlog): n=10 calibration finalized — 14.2 weighted up, 14.5 added (accuracy judge variance)
- `6f267ec` docs(backlog): 14.2 corrected — the 20% had suite defects mixed in; the real blind spot is 2/5
- `8713a6d` docs(eval-baseline): three operational criteria for accuracy — treating the leak, not just restating the principle
- `751f6bc` fix(eval): calibration specificity check exempts dimensions coupled by construction + the report names the drifting dimension
- `92f96d2` fix(analysis): the [RES] snapshot under a death anchors to the moment of death, no longer taking T-3s
- `4997308` fix(eval): the cooldown ledger gate now decides with attribution — eliminating 67% false positives
- `2967959` fix(analysis): the [HEALER CC] caster label switched to the shared `actorLabel` predicate

## v0.0.16 (2026-07-20)

- `29d1d57` release: v0.0.16 — prompt self-contradictions eliminated + a model dropdown + assorted replay/map fixes
- `00234cc` docs(backlog): 14.1 marked fixed, and its incorrect root-cause guess corrected
- `11a677e` chore(qa): report-replay baseline regenerated — the map background switched to a fixed stub
- `68635d3` test(visual): the stub background switched to asymmetric corner marks, with the center left empty
- `f6dce47` docs: two handoff docs archived as one retrospective on completion, moved into docs/reports/
- `a4d2e87` docs(handoff): stale and redundant content removed
- `65f795c` docs(claude): added the "a fix must come with before/after numbers" verification rule
- `50deb8f` docs(backlog): the four 2026-07-20 eval/QA leftovers recorded
- `13d656e` docs(handoff): two leftover todos marked done
- `258dcdc` docs(eval-ab): compute the MDE before starting — to avoid another A/B that can't measure anything
- `0eeabb2` feat(eval): class-D cooldown ledger contradictions added to the standing gates
- `637ebd8` docs(handoff): blind A/B wrapped up — all seven dimensions inconclusive, ADOPT on deterministic grounds
- `665346a` docs(handoff): blind A/B continuation handoff — stuck on the subagent quota, 6/100
- `710ed5f` docs(handoff): class-D conclusion corrected — the first judgment was wrong
- `c820ad4` fix(analysis): the real class-D root cause — one ability with two cooldown values (correcting the earlier wrong conclusion)
- `8f48174` fix(analysis): missed-dispel rows switched to fmtTime for the timestamp — the last bare-seconds timestamp
- `0a193b0` docs(handoff): all 8 classes handled — with the rationale for deleting the two-tier radius and the class-D conclusion
- `dbe61bd` revert(analysis): the two-tier HP sampling radius removed — it was built on a disproven root cause, and it was harmful
- `7c7e9f6` docs(handoff): thousand-match re-verification results + the confirmed and unproven parts of class D written separately
- `1f33b04` docs(handoff): updated to 7 of 8 classes fixed — including the main lesson, "ask whether it's the same instant first"
- `23de9f5` fix(analysis): class I — the damage figures in OFFENSIVE WINDOW didn't match the displayed interval
- `be36279` feat(analysis): class F — DR annotations added for CC the player cast themselves
- `cd60380` fix(analysis): class H duration self-contradiction + E/G notation legend made consistent with the window basis
- `f42fca1` fix(analysis): class C same-second HP contradiction — the third HP sampling path eliminated
- `0e13264` fix(analysis): the real class-A root cause is the render grid, not the sampling radius + class-B percentile inversion
- `a8afe37` docs(handoff): class-C root cause and the list of call sites still to change
- `3cd5342` fix(analysis): HP sampling radius converged to a single-source predicate — fixing same-second HP self-contradictions
- `9b8e40d` chore(qa): report-replay / settings visual baselines regenerated
- `18d5fad` chore(qa): one-command presubmit gate + a model output shape audit tool
- `43c6e2e` feat(report): map-only layout height adjustable + spell icons on finding chips
- `132b3da` feat(ai): model dropdown + `--model` passed through to local backends; fixed fenced output being misjudged as bad-json
- `2159889` fix(replay): the opening position blind window is labeled "position unknown" instead of being drawn as a known position

## v0.0.15 (2026-07-20)

64 commits in total; only feat/fix/perf listed below (32):

- `e44814d` fix(qa): the webServer criterion extracted into a tested pure function; report-ai anchors tightened
- `9e952bd` fix(test): the split-pane cases clear localStorage explicitly — fixing state leakage on CI
- `ac5a2d1` perf: big JSON goes through JSON.parse — cold start 25s→2s, first paint 24s→0.8s
- `7c14f5a` fix(qa): the two "the gate looks like it's guarding but can't actually stop anything" cases from the final review closed
- `3ba8014` fix(replay): the hint bar gained Ctrl+wheel / draggable splitter + two degenerate CSS rules cleaned up
- `66acec0` fix(visual): threshold 0.2→0.05 — the default tolerance was letting through color changes at the same brightness
- `75b27f1` fix(visual): tolerance switched to an absolute pixel count — the 1% ratio was letting a genuine color regression through
- `de40f09` fix(replay): the splitter gained pointercancel / exact pixel conversion / keyboard accessibility
- `76778b5` fix(e2e): unit tests added for resolveJumpTarget + openAiView promoted to a shared helper
- `5ac8c92` feat(main): GLADLOG_E2E userData redirection — E2E runs on temporary state
- `4ac00ae` feat(replay): a draggable splitter between the map and the GCD swimlanes
- `884f28e` fix(parser): the unimplemented `rounds` parameter removed from synthArenaLog
- `f483483` fix(fixture): `analysis.getState` added — the AI view really does render findings under the fixture
- `165a178` feat(replay): three layout modes (GCD-only added), lifting the 560px hard cap on the map
- `e3aa811` fix(replay-zoom): orphan CSS cleaned up + test coverage added
- `6698482` fix(visual): per-test timeout raised to 120s + the port genuinely single-sourced
- `004118b` feat(replay): zoom buttons float over the bottom right of the map
- `4b56c7c` fix(replay): once in the zoomed state, a bare wheel also takes over map zooming
- `0c67fa0` feat(replay): split-ratio state and clampSplitRatio
- `f07d7d9` feat(dev-ui): dashboard / settings / list scenarios — the app shell enters visual regression too
- `c7c07ba` feat(dev-ui): `?scene=` scenario routing — a deterministic entry point for visual regression
- `c72563c` feat(report): MatchReport supports initialView — views are reachable directly by URL
- `43f4b65` fix(deepdive): STAYED_IN must cost something real before it opens the deep-dive gate — criterion and formatter share a source
- `90a1e36` fix(desktop): getFlags gained a cancelled guard — old match markers no longer bleed across when switching matches
- `624952c` fix(analysis): target-death truncation takes the earliest one, without relying on deathRecords being ordered
- `8a37def` fix(desktop): generation entries reclaimed — but only once that match is completely quiet
- `1da25f9` perf(report): GcdSwimlane layout memoization actually takes effect — the dependency array switched to stable identities
- `5845f95` fix(deepdive): the placeholder regex comes single-sourced from claimChecker — no more each-writes-their-own
- `d4bf4b4` fix(desktop): panel remount switched to a single atomic getState — eliminating the "the result fell through the crack" race
- `ce33ef9` fix(desktop): deepen idempotency guard — navigating away and back no longer burns another deep-dive round of tokens
- `536295c` fix(deepdive): focusT anchors to the last anchor, rather than being derived backwards from a clamped anchorTo
- `b7a7746` fix(desktop): running-tracking leak prevention (found in a concurrency re-review) — the stored generation is cleared by owner identity, and abort clears it too

## v0.0.14 (2026-07-19)

- `1985247` release: v0.0.14 — AI analysis no longer lost when navigating away + a prominent button when unanalyzed
- `047b5c0` fix(desktop): AI analysis no longer lost when navigating away + a prominent button when unanalyzed

## v0.0.13 (2026-07-19)

- `0b918a8` release: v0.0.13 — the deep-dive round (automatic follow-up questioning) covers death / positioning / offensive mistakes + the mistake notebook
- `a81fc4c` docs(eval): stale comment corrected, five classes → four (juked-kick removed)
- `6fbb4f9` test(eval): large-scale cross-AI A/B on offensive deep dives + the weak juked-kick type removed
- `bdaf493` test(eval): deterministic scan of offensive deep dives + a scan-driven immunity gate correction
- `1c85e9b` feat(deepdive): the renderer guarantees an offensive deep-dive slot (survival≤2 + offensive≤1)
- `ad3aaac` test(deepdive): assert a survival-only pack doesn't print the offensive legend (locking the gate condition)
- `a477911` feat(deepdive): classifyFindingKind dispatch + an offensive legend in the prompt + PROMPT_VERSION 12
- `0b6d8df` fix(deepdive): offensivePackItems compares roles by full name + an inWin guard added to burst-start entries
- `76eed3c` feat(deepdive): buildOffensiveDeepDivePack + the pure mapping core offensivePackItems
- `c2ebd37` feat(deepdive): the offensive signal gate hasOffensiveCoachableSignal + PackItem kind extension
- `b073b94` docs(plans): implementation plan for offensive deep dives (deep-diving non-death findings)
- `b1035bf` docs(specs): design for offensive deep dives (deep-diving non-death findings) + backlog #13
- `c55929d` test(eval): eval harmonics for the value of positioning signals — blind generation + reconstruction audit
- `11b5b51` feat(deepdive): a fourth signal class, positioning mistakes — closing the "died to positioning" gap that resource signals can't see
- `10c5112` test(eval): per-spec signal decomposition — diagnosing the root cause of gate-pass rate differences (structural vs. coverage gap)
- `e66fe81` test(eval): large-sample robustness scan of deep dives + a prompt A/B tool
- `f379503` feat(analysis): deep dive fixes 1+2 — a coachable-signal gate (defensive early/late / ≥3s hard CC that should have been traded and wasn't / a dispel colliding with an enemy CD, with the gate moved to the caller) + owner anchoring and role labels + clean windows left blank; PROMPT_VERSION 10
- `cf1ccfd` fix(analysis): deep-dive prompt discipline corrections (eval-driven) — the phantom `units` field removed + HP split into per-checkpoint placeholders + realm digits stripped from short names in facts; PROMPT_VERSION 9
- `59a75be` test(eval): deep-dive quantification script — evidence yield (model-independent) + a discipline smoke test (generation and audit, two stages)
- `858c46f` feat(analysis+desktop): the deep-dive round (automatic follow-up questioning) — deterministic evidence packs expanded for high-severity findings ([anchor−30,+10] crowd control / defensives / enemy CDs / HP trajectory / dispels) + the second-round narrative audited by claimChecker + causalLint + evidence chips that jump into the replay; PROMPT_VERSION 7
- `cdb28cb` feat(analysis): death-setup cause-chain candidates — events preceding a death, traced backwards (healer-locked / trinket-early / defensive-early, with predicates mirroring death-trace) + a chain legend in the prompt and a cap on death anchors + max_tokens 4096 + PROMPT_VERSION 6
- `f1fcc04` feat(desktop): the mistake notebook — cross-match findings grouped by type (a main-process notebook service + an embedded expandable card on the statistics page: meta / marks / open that match)
- `60392b1` docs(skills): the agy-review skill (output truncation traps + adoption criteria) + desktop-dev gate switched to whole-repo lint + the cd trap
- `7608d72` docs(skills): the release skill — tag-driven build/overwrite procedure + asset verification + the list of traps

## v0.0.12 (2026-07-18)

- `4f57f87` feat(desktop): replay map-only / GCD layout switching (remembered in localStorage) + AI call debugging on the developer page (the last 10 prompts and responses, in memory only, never written to disk)
- `1690a2e` feat(desktop): cohort score bars visually enhanced + AI analysis and comparison merged into one button (linked via runSignal)
- `2cdf2d6` feat(desktop): 0-finding explained by cause — fallbackReason (no candidates / AI not configured / bad JSON) + a Chinese message replacing the English placeholder when everything was discarded by the audit
- `7616a5c` release: v0.0.12 — first load made faster (WeakMap memo / worker parse + LRU / bundle split 19MB→2.1MB) + tabs moved left
- `f35ee7a` chore: the two actionable items from the external review landed — a timeline spec tag unit test + a comment on the iconCache caching strategy
- `7fa954d` feat(desktop): tab positions adjusted — the view tabs in the App top bar and the report page header moved left (user feedback), pushing win/loss + meta to the right
- `783657b` fix(desktop): matchStore probe test console.log→warn (whole-repo lint on CI)
- `d4c6342` perf(desktop): bundle optimization using top-level await dynamic imports for spellNames and talentIdMap
- `52e965f` perf(desktop): parse match file in worker thread and implement LRU cache
- `85474e6` perf(desktop): memoize toLegacySafe with WeakMap to speed up first load
- `c918779` docs(plans): first-load speedup brief — a measured end-to-end baseline + three approaches (memo / worker parse / bundle split)

## v0.0.11 (2026-07-18)

- `7cda727` release: v0.0.11 — whole-app UI redesign (accent night-blue language / report timeline spine / framed panels on both sides of the replay / score bands) + spec icons on the minimap + cohort turned into scores
- `f8b6301` fix(desktop): redesign review corrections — rating sources compared like for like (CR and MMR not mixed) / current-rating baseline guard / follow-up marks require evidence / replay cursor projection (reported on unmount) / death recap card 1c styling / role chips as accent pills / CSS deduplication (7 agy flash review findings)
- `930ca53` feat(desktop): UI redesign P7, report 1c — single-line header with tabs on the same row / 240-tall curve card with death circles / clickable window list rows / meters | death recap as two permanent columns / class glyph squares in the meters
- `d618d9f` feat(desktop): UI redesign P6, replay 1f — frames flush against both sides of the arena / control bar rearranged with shortcut hints / 5s separator bands in the swimlanes + a cursor badge + accent chips on majors
- `0ffef99` feat(desktop): UI redesign P5, AI analysis 1g — action area pinned to the top with a status line (MatchHero removed) / the moment axis on a single left rail / findings turned into labels / cohort distribution bar with a cursor (verdict text keeps its faithfulness anchoring)
- `813b8ea` feat(desktop): UI redesign P4, statistics 1h — an overview number band (current rating / derived change) / axis ticks, endpoint annotations, and a legend on the curve / composition win-rate bars / problems as rows
- `c6c4792` feat(desktop): UI redesign P3, match list 1e — win/loss line on the left edge / rating change / date group headers with a daily summary / HH:MM / the filter bar unified
- `08a65a2` feat(desktop): UI redesign P2, settings 1i — three-column grid / unified inputs / "configured" pills / in-place save feedback / backend description lines
- `003a1e9` feat(desktop): UI redesign P1 — accent tokens / Inter / two tiers of tab shape / interaction gold → accent (data gold kept: kill bands / never-pressed / CC text / kill chips / recent GCD)
- `d2070f2` docs(specs): UI redesign handoff archived (all of 1c / 1e–1i + accent tokens)
- `0fd5605` feat(desktop): cohort panel turned into scores — a single source for direction-corrected scoring (METRIC_LOWER_IS_BETTER) + score bars + a deterministic summary line (overall / strongest / weakest)
- `1d9f1af` feat(desktop): spec icons overlaid on units in the replay (CDN, following the list's precedent, falling back to the class glyph on failure)

## v0.0.10 (2026-07-18)

- `85ecb67` fix(desktop): replay UI review corrections — smoothPath endpoints / x clamping, frame death judgment switched to the deathT predicate (agy flash review)
- `d10a575` feat(desktop): GCD swimlanes grouped by team — friendly columns on the left, enemy on the right, with a vertical divider at the boundary
- `449cd19` feat(desktop): report health curves smoothed — Catmull-Rom bezier + control point clamping to prevent overshoot + non-scaling-stroke
- `47c6c05` feat(desktop): framed sidebars on the replay arena — friendly and enemy health bars permanently readable, with hover-linked highlighting and raising, replacing the old legend
- `1370f41` release: v0.0.10 — key-moment axis + background list loading / live statistics updates + report detail breakdown
- `1481898` docs: backlog #11 marked done + the breakdown implementation plan committed
- `1750f55` fix(desktop): breakdown review corrections — the click area made a real flex box + expanded data useMemo'd + pet names not split / same name on a different realm falls back to the full name (agy flash review)
- `293536f` feat(desktop): report detail breakdown — meter rows expand inline, broken down by ability and source (backlog #11)
- `a4f33ba` feat(desktop): deriveDetailBreakdown — aggregated by ability and source, with the total reconciled against meterValue
- `0a1bc18` feat(parser): decodeHpTail / hpTailSlice exported — HP tail-parameter decoding single-sourced, with parseLine switched to the same slice
- `24b1799` docs(specs): report detail breakdown design (inline expansion + core columns + crit rate, decisions recorded)
- `cf802d7` docs(backlog): #12 marked done
- `f284d18` feat(desktop): background list loading + statistics updating live as matches are ingested (backlog #12)
- `751030b` fix(desktop): axis review corrections — CC nodes carry the caster + useMemo merging/splitting + pure-render gaps + stable keys (agy flash review)
- `cbbe235` feat(desktop): key-moment axis layout on the AI analysis page — the axis replaces the horizontal strip, cohort drops to full width, whole-match observations in their own section
- `da62316` feat(desktop): KeyMomentAxis component — staggered spine / ellipsis markers / click to seek
- `ea8bf25` feat(desktop): deriveKeyMoments — five classes of event derived for the key-moment axis (predicates entirely reused from analysis)
- `62523ae` docs(backlog): #12 background loading after lazy load + live statistics updates (user feedback)
- `c12f586` docs(backlog): #11 report detail breakdown (broken down by ability and source, at the original detail level)
- `714157b` docs(specs): key-moment axis design for the AI analysis page (four user-approved decisions recorded)

## v0.0.9 (2026-07-18)

- `b9fb721` release: v0.0.9 — evidence time chips + the unconverted-burst evidence type + findings raised to 3–5
- `ff2302b` feat(analysis): unconverted-burst candidate type + findings raised to 3–5 (evidence diversity)
- `cec89c5` feat(desktop): time chips on finding evidence — each piece of evidence shows when it happened and is individually clickable to seek the replay

## v0.0.8 (2026-07-18)

- `0274b64` release: v0.0.8 — comparison translated to Chinese / commentary thickened / swimlane truncation
- `70606a4` feat(desktop): the comparison panel fully translated to Chinese + commentary thickened; replay swimlanes truncated at the end line

## v0.0.7 (2026-07-18)

- `6181db4` release: v0.0.7 — manual command path for backends
- `9aa71af` feat(desktop): a "command path" input added to the settings page — the Claude CLI and agy backends can be pointed at manually
- `25cdb67` docs: Windows + Claude CLI setup guide (for sending to colleagues)

## v0.0.6 (2026-07-17)

- `85c99a9` release: v0.0.6 — replay arena boundaries / starting-room outlines + ⌘/Ctrl wheel zoom
- `e0d06b3` feat(desktop): replay arena boundaries and starting-room outlines (measured from the corpus) + zoom interaction switched to ⌘/Ctrl+wheel

## v0.0.5 (2026-07-17)

- `64881e3` release: v0.0.5 — coverage tail eliminated + seven blinding CCs + SPEC BASELINES revived + an enemy trinket row
- `b1ac13c` docs(plans): design for loading very long matches faster — a trace of the three costs of synchronous parsing in the main process + approach A
- `c9d6f0f` fix(analysis): benchmarks recomputed over a thousand matches + the live-dead-key SPEC BASELINES fixed (the 15th case of a split predicate)
- `77c1b57` fix(analysis): [OFFENSIVE WINDOW] CDs carry the cast instant + a 7th blinding CC (agy cross-review)
- `5f16de9` fix(eval): unused variable in rotScan — CI lint includes scripts, and the local `--quiet` output was truncated so it was missed
- `cd0dc4b` feat(desktop): UI stress-test sample pool — wild-boundary fixture generation / on-demand loading / headless smoke test
- `41baa6c` fix(analysis): CC whitelist aura ID rot — 6 blinding CCs completed from thousand-match corpus evidence
- `601c959` fix(analysis): coverage tail eliminated — CC with no owner CD enters the timeline + pet dispels on both sides + an enemy trinket row
- `d6f7cf2` fix(analysis): CC row attribution for pet casters + a thousand-match wild fuzz tool
- `49046ba` fix(corpus-tools): comp tier tests switched to static imports — dynamically importing analysis on a cold CI exceeded the 5s timeout
- `ada128a` feat(compare): P2 opposing-comp dimension — an expert cell for the same composition + duration / first kill + a comp tier fallback chain
- `104dbd5` docs(plans): pro-comparison P1 checked off (387 cells, 262 DPS)
- `6ea230f` fix(corpus-tools): converting union metrics to a Record has to go through unknown (workspace tsc includes src tests)
- `f4e9845` feat(compare): expert-comparison DPS metric group (P1) — 7 dimensions enter the reference corpus, 262 DPS cells
- `779a53b` docs(plans): design for in-depth comparison against expert matches — contextualized metrics / comp dimension / exemplar import
- `edd394f` fix(desktop): zoom test className typing (CI workspace tsc includes test files)
- `6217aa5` fix(desktop): zoom handler prefer-const (lint)
- `dd431a5` feat(desktop): replay zoom + character distinction on the statistics page + a Windows local CLI backend
- `110bfff` refactor(logs): log collection tooling consolidated — a shared wowarenalogs client + a unified `logs:*` entry point
- `753b674` ci: an electron-vite build step added to the test workflow — a renderer value imported into main can only be caught by a production build

## v0.0.4 (2026-07-16)

126 commits in total; only feat/fix/perf listed below (89):

- `3a9ccc8` fix(desktop): API_KEY_REDACTED moved into shared/protocol — a renderer value imported into a main module blew up the production build
- `6b697e7` fix(analysis): DPS baseline Top-3 fix — interrupt field semantics unified + two bugs in the kick judgment + window truncation + subject wording
- `9836b74` feat(eval): public match fetcher — a real DPS-perspective corpus pipeline (D2 wrap-up)
- `1ac01b8` feat(desktop): this-match goals card (D3 coaching loop) — the "still doing it" category opens the AI view
- `d0c7089` fix(analysis): the mitigation row in the burst ledger states its subject — the smoke test showed the responder reading it as a friendly external
- `e3ee234` fix(eval): DPS corpus support — `--owner dps` + three fixes to subject parsing in the gates
- `0545421` feat(analysis+desktop): D2 — the AI review's owner perspective generalized, so a DPS recorder gets `<burst_ledger>` and four new event classes
- `c83ba7a` feat(desktop): red burst pulse in the replay + same-second focus-fire highlighting (DPS D1 wrapped up)
- `b9910a6` feat(desktop): DPS burst ledger card (D1) — burst alignment / target discipline within the window / interrupt audit
- `558359e` fix(analysis,eval): DR legend disambiguated + a responder focus sentence (baseline Top-2/3 issue)
- `602ed11` fix(analysis): three coverage-gate fixes — enemy pet CC / enemy in-team breaks / our CC on an enemy being invisible
- `b555dd9` fix(analysis): benchmarks regenerated — the real DPS baseline after the metric sign fix
- `05bb089` fix(desktop): unused findingKey import removed (CI lint blocked two commits)
- `59a586b` feat(desktop): three replay pieces — keyboard controls + obstacle outlines + AI streaming preview (phase3 #4)
- `fd134a3` feat(desktop): most-frequent-problems aggregate card — the coach goes from commentary to follow-up (phase3 #3b)
- `d0369e8` feat(desktop): finding follow-up marks — fixed / still doing it (phase3 #3a)
- `7641d7b` feat(desktop): historical log import — file dialog → parse into the library + progress (phase3 #2c)
- `bb44c13` feat(desktop): first-run wizard empty state (phase3 #2b)
- `eaf37db` feat(desktop): settings page — a proper home for user-facing options (phase3 #2a)
- `5726e52` feat(desktop): statistics dashboard — cross-match stats land for the first time (phase3 #1)
- `6925b41` feat(desktop): KILL WINDOW / VULNERABLE bands drawn on the report HP timeline (clickable to seek the replay)
- `d553b57` feat(desktop): swimlane death dividers clickable → death recap — all three death marker entry points complete
- `bea7cd0` feat(desktop): match list filter bar — win/loss / bracket / spec (matching the old repo's MatchSearch)
- `454bdc1` feat(parser,desktop): true cast bars — SPELL_CAST_START landed + cast progress in the replay (#11b, full version)
- `45d0f0d` feat(desktop): window bands clickable — clicking a burst/vulnerable band jumps to that moment
- `4f322c4` feat(desktop): replay death ✕ clickable → death recap (#6 v2)
- `f83228e` feat(desktop): swimlane chips click to seek — clicking any cast seeks the shared clock to that moment
- `2c666ce` feat(desktop): stats table rows expand — interrupt / CC instance details + replay jumps (#10 v2)
- `8fca726` feat(desktop): AI analysis language switching, Chinese/EN (backlog #1)
- `c03731f` feat(desktop): three small replay pieces — HP numbers + dampening indicator + cast flash (backlog #11)
- `f32a4d2` feat(desktop): stats table — hard per-player numbers for interrupts / CC / dispels (backlog #10)
- `b2fc00f` feat(analysis,desktop): swimlane spell icons — a mined spellId→icon-name table + chip rendering (backlog #9)
- `3501c76` feat(desktop): death recap drawer card — click a death marker for the 10s before it + defensives available and never pressed (backlog #6)
- `b825184` feat(desktop): #8 wrap-up — "replay this moment" on the TimelineStrip + KILL WINDOW / VULNERABLE bands
- `8772f4f` feat(desktop): rich match list rows — win/loss / map / duration / rating + spec icons for both teams (backlog #7)
- `60d9707` feat(desktop): evidence-chain navigation — a finding's "replay this moment" goes straight to the event's instant (the core of backlog #8)
- `852a136` feat(analysis): KILL WINDOW redesigned — vulnerable state separated from kill attempt (burst sub-windows)
- `e3c1708` fix(analysis): spec-level coverage survey — 12.x burst CDs completed + Shadowfury DR + 7 missing interrupts
- `4cce06d` fix(analysis): OPPORTUNITY rows rendered in time order (pick by leverage, order by time) — 136/1245 were out of order
- `5aa94e1` fix(analysis): damage sign convention bug — 'your damage' was counting only absorbed damage across the board
- `f7a6251` fix(analysis): two more invariant-scan fixes — kill-window CC membership judgment aligned to render seconds + a self-contradictory channeled-cast comment
- `1aacaa5` fix(parser,analysis): two invariant-scan fixes — shuffle round tails swallowing the between-round gap + CD variant IDs mislabeled UNUSED
- `8181ef7` fix(analysis): Stasis stored-spell whitelist gained 4 12.x IDs — 24/51 releases were listing too few spells
- `6215390` fix(analysis): the [MATCH TYPE] header's predictive framing → a hedged [MATCH PATTERN]; an A/B evidence comment added to the production prompt
- `ced551a` feat(eval): an ACCURACY DISCIPLINE self-check section added to the responder template (A/B: accuracy +0.71, CI win)
- `57d27f8` fix(analysis): two labelBias convergence signals — DMG SPIKE healed-through annotation + neutral exposure verdict wording
- `ec9a7c6` fix(analysis): RES lag + STAYED_IN window semantics + the Sigil of Misery DR label (three fixes from the Gemini review)
- `f58ebc4` feat(analysis): high-frequency filler cast windows folded + channeled ticks suppressed (noise-reduction A/B treatment)
- `aceafb5` fix(analysis): the G5 scan anchored to render seconds (floor) — the root cause of the 1114/1021 residual
- `3cb15ea` fix(analysis): the last two CJK leaks in [CD] target labels — the pid fallback path
- `315b224` fix(analysis): G5 take 2 — LoS judgment switched to a ±2s scan exactly matching the gate
- `83d4600` fix(analysis): last two locale-leak sites — [UNIT DESTROYED] + [CD] target labels
- `84bae32` fix(analysis): track Devourer Demon Hunter kit + Sigil of Misery CC
- `c0711f7` fix(analysis): evaluate LoS at raw sampled positions, not interpolated (G5 residual)
- `a3a75fb` fix(analysis): make INACTIVITY 'free' wording explicit (un-CC'd, could have cast)
- `0e360fe` fix(analysis): shared bounded HP sampler — death traces provably match STATE (B4 residual)
- `57a20fd` fix(analysis): resolve pet/NPC names in [KICK] lines (last locale leak)
- `8f5b255` fix(analysis): explicit "DAMPENING: n/a" line for short matches
- `7295177` fix(analysis): track missing enemy burst CDs (21% of corpus had zero [ENEMY CD])
- `69be1f3` fix(analysis): detect Grounding Totem absorbs by npcId, not English name
- `09cb414` fix(eval): SPECIFICITY_TOL default 0 -> 1 for the integer judge rubric
- `1e3bc3d` fix(analysis): bound position interpolation in healer-exposure LoS checks (G5)
- `4d65dbb` fix(eval): extend dispel-oracle rider exclusions found at 1245-match scale (B3)
- `c1f3fff` fix(analysis): unify burst-target attribution + tighten burst HP sampling (B4)
- `5f70143` fix(analysis): suppress localized totem/pet target names in timeline (locale leak)
- `c52ea5b` fix(analysis): render English spell names in offense/CC prompt sections (locale leak)
- `8c355a2` fix(eval): judge rubric dimension-independence anti-halo rule (discriminant validity)
- `2188ec0` fix(eval): judge-calibration discriminant validity — specificity / minimum sample / drop threshold
- `bda41bf` fix(desktop): in-app fixture preview fixed (VITE_FIXTURE_MODE=1 npm run dev)
- `283fe30` fix(desktop): GCD chips show only the ability name, with the target moved to hover
- `1bbbae7` feat(desktop): the replay arena carries the real map (aligned to the minimap by zoneId)
- `3fb8c5f` fix(desktop): GCD abilities are not dimmed while paused (future actions dim only during playback)
- `bc13036` fix(desktop): GCD ability chips made taller (more vertical room, easier to read)
- `381f534` fix(desktop): replay layout changed to 1:2 (arena : GCD swimlanes), with the middle gap tightened
- `56ed402` fix(desktop): GCD swimlanes widened and enlarged (pulled left, larger and clearer text)
- `5413d7c` feat(desktop): GCD swimlane density reduced + clicking a name in the report filters the health curves
- `0df1479` feat(desktop): local UI test bed (npm run dev:ui) — renders the report in a plain browser
- `e639493` feat(desktop): redesign AI view — two-column findings cards + sticky cohort
- `844caa9` feat(desktop): View C GCD-mode swimlanes (sharing a clock with the arena)
- `3d29414` feat(desktop): redesign View C replay — WoW arena style
- `821b741` feat(desktop): redesign View A — segmented-control view tabs + inline mode switching in the meters + the unit sidebar removed
- `b5906c0` fix(vision): address agy cross-family review (C1)
- `abc6724` feat(vision): headless verify:vision script (C1)
- `7cd0c77` feat(vision): cohort selector + faithfulness checker (C1)
- `a69e662` feat(vision): timeline selector + faithfulness checker (C1)
- `cef0c97` feat(vision): meters selector + faithfulness checker (C1)
- `67d7d87` feat(desktop): replay tab — 2D positioning simulation (trails / deaths / legend)
- `afd0dc8` feat(desktop): unit details merge the cast and important-aura streams & a player filter dropdown
- `3807cce` feat(desktop): AI analysis split into its own full-width tab (out of the narrow right column)

## v0.0.3 (2026-07-12)

- `04b0f4c` build(lint): allow require() in .cjs files (electron-builder hooks)
- `fc55952` chore(desktop): bump version to 0.0.3
- `8710d4b` docs: /release-gladlog command — versioned desktop release workflow
- `5757fe4` feat(desktop): debug local-AI backend (claude/agy CLI)
- `136cb0c` docs(specs): debug local-AI backend (claude/agy CLI) design
- `b46fa73` build(desktop): afterSign hook — clean ad-hoc macOS signature (no more 'damaged')

## v0.0.2 (2026-07-12)

- `bc45ba5` chore(desktop): bump version to 0.0.2
- `03641f6` perf(desktop): append-only NDJSON match index — one-read startup + O(1) store
- `ee3b37f` feat(desktop): infinite-scroll match sidebar (initial 100, older on scroll)
- `5874f51` feat(desktop): matches:page IPC + preload bridge
- `170def9` feat(desktop): MatchStore.page() paginated slice
- `3cc963c` docs(plans): match-list pagination + NDJSON index implementation plan
- `dc7e6fe` docs(specs): match-list pagination + fast-startup NDJSON index design
- `315814a` ci: let macOS build ad-hoc sign (drop CSC_IDENTITY_AUTO_DISCOVERY=false)

## v0.0.1 (2026-07-12)

226 commits in total; only feat/fix/perf listed below (157):

- `1d220ff` fix(log-pipeline): append-only reconstruction + review nits
- `50d1f94` feat(log-pipeline): collect CLI + cleanup tests
- `1eaa7d3` feat(log-pipeline): port cleanupAppliedSegments (node:fs + gzip-length cross-check)
- `ff940db` feat(log-pipeline): overlap-aware gunzip-validated collection
- `757ee57` feat(log-pipeline): length-encoded segment keys + flusher wiring
- `5475586` feat(log-pipeline): stage ported streamer + storage/protocol infra (raw port, pre-hardening)
- `c226d4b` feat(analysis): expand findings menu — side-tagged deaths + cd-waste events
- `cdebdf1` fix(analysis): honesty-pipeline bugs from agy cross-family bug-hunt
- `70da433` fix(analysis): three verifiedComparison bugs surfaced by the smoke test
- `4905b59` feat(analysis): harden findings prompt against raw digits (SP-A.1 digit refinement)
- `bf907fd` fix(analysis): R3 — render offensive-waste block in the timeline branch
- `ab05545` fix(SP-A): narrow causalLint patterns to cut false-drops (agy re-verify)
- `2ff8aec` fix(SP-A): close two honesty holes from Opus whole-branch review
- `a4afff4` feat(desktop): ExportButtons + StructuredAnalysisPanel replacing the <pre> analysis (SP-A T7)
- `308aa4d` feat(desktop): FindingsList + MatchHero + TimelineStrip (SP-A T6)
- `6bdca5e` feat(desktop): main-process analysis service + IPC/preload (SP-A T5)
- `43d6965` feat(analysis): findings prompt + analysis exports (SP-A T4)
- `a85a084` feat(analysis): auditFindings three-layer gate (SP-A T3)
- `1046bf9` feat(analysis): causal-language lint (SP-A T2)
- `e867e50` feat(analysis): candidate-event types + extraction (SP-A T1)
- `e6c07f1` fix(SP-B2): reset compare panel state + guard async race on matchId change
- `1407a00` fix(SP-B2): address Opus whole-branch review findings
- `9613971` feat(desktop): ProComparisonVerified panel (SP-B2 T7)
- `39ac7a8` feat(desktop): corpus loader + compare IPC/preload wiring + bundling (SP-B2 T6)
- `0899967` feat(desktop): main-process compare service with fail-open + claimChecker (SP-B2 T5)
- `63249ba` feat(analysis): exemplar-led prompt + compare exports (SP-B2 T4)
- `f3e7dcc` feat(analysis): template interpolation + claimChecker gate (SP-B2 T3)
- `4b12832` feat(analysis): verifiedComparison + facts dictionary (SP-B2 T2)
- `b7c7764` feat(analysis): compare corpus read-types + cell lookup fallback (SP-B2 T1)
- `f9f1673` fix(SP-B1.5): address agy whole-branch review findings
- `a05f9d3` fix(corpus-tools): aggregateCells self-guarantees the buildGroups invariant
- `6b30dd3` feat(corpus-tools): maintainer keystone-discovery tool (SP-B1.5 T7)
- `1e02d29` feat(corpus-tools): thread keystone gates through buildCorpus (SP-B1.5 T6)
- `3892072` feat(corpus-tools): validate build-group schema integrity (SP-B1.5 T5)
- `c3ff208` feat(corpus-tools): build-split cells + N_floor guard + buildGroups (SP-B1.5 T4)
- `9d39e0b` feat(corpus-tools): winsorize offensiveIndex to pool p99 (SP-B1.5 T3)
- `1ebeefb` feat(corpus-tools): assign buildGroup per record via keystone gate (SP-B1.5 T2)
- `2f342f8` feat(corpus-tools): keystone gate module + curated table (SP-B1.5 T1)
- `b0090a1` feat(corpus-tools): retry-with-backoff on feed calls for production-scale runs
- `2bcb0cc` fix(SP-B1): address final-review Important findings (latent safety-net gaps)
- `c6b0cc6` feat(corpus-tools): T8 real corpus build + 2 metric fixes found by acceptance gates
- `0c6b7e8` feat(corpus-tools): per-match record + buildCorpus orchestration (SP-B1 T7)
- `35f37a8` fix(corpus-tools): feed query needs inline fragments on ArenaMatchDataStub/ShuffleRoundStub (go/no-go smoke diagnosis; direct field selection on CombatDataStub interface → HTTP 400)
- `2727cce` feat(corpus-tools): feed client + go/no-go smoke (SP-B1 T6)
- `481bb57` feat(corpus-tools): corpus validator hard gate (1.5 sentinel/ASCII/N_floor) (SP-B1 T5)
- `9392e73` feat(corpus-tools): scaffold package + cell aggregator with archetype celling + N_floor (SP-B1 T4)
- `3817d11` feat(analysis): enemy-comp archetype classifier for cohort celling (SP-B1 T3)
- `4a4a02f` feat(analysis): port extractRotations/crisisEvents from old fork (SP-B1 T2)
- `ecdb8cf` feat(analysis): port computeHealerMetrics from old fork (SP-B1 T1)
- `2ee7ee2` fix(analysis): restore death-outcome block + never-used flag in timeline prompt (E2E regressions R1+R2)
- `154d38c` feat(analysis,eval): dispel visibility — named dispel spells on [CLEANSE], team [PURGE] + [ENEMY PURGE] lines, folded [MINOR DISPELS]; manifest excludes movement root-breaks from dispel denominator (backlog #5)
- `f004d74` feat(eval,analysis): geometry grounding scanner + pipeline guards — 176-match corpus at 0 violations (backlog #3 hard gate)
- `22f7565` feat(eval): CONTESTED safety-contract assertion script (F193 replication) — 176-match corpus clean; F193 rubric clause added to eval-baseline accuracy dim. Backlog #4 closed
- `ed29c81` feat(desktop,eval): adopt timeline prompt variant as production default
- `ac35614` fix(parser): strip trailing \r from CRLF logs — feign deaths were recorded as real deaths; timeline: STATE min-gap 3s + delta [RES] on CD casts (A/B cycle-3 density compression)
- `0e6d5c4` feat(analysis): timeline unit references carry compact spec tags (A/B cycle-1 accuracy-regression fix)
- `3e4adf4` fix(analysis): owner-perspective Result line + neutral section headers (baseline eval findings)
- `d68f8d1` fix(review): sub-project 5 findings — unsigned mask decode, build-string validation, icon fetch budget, test-hack removal
- `c3c6e64` feat(report): talent icons with local disk cache (zamimg, offline-degrading) + update-wow-data workflow + datagen manifest
- `7dd1f93` feat(report): named talents in unit panel (getTalentNames via raidbots node maps)
- `f77afd5` feat(datagen): spell-class map + catalog validation (known-removed allowlist: Mind Bomb kept for historical logs)
- `a08df98` feat(datagen): own generators ported (trinkets, talent modifiers) + regenerated artifacts (build 12.1.0, 129 tracked spells)
- `9b1134c` feat(analysis): two-layer spell effect data (generated base, curated overrides win)
- `e2bd7b9` feat(datagen): spell effects miner (PvP-duration-aware, GCD-artifact filter) + generated base layer (3560 spells)
- `a611d42` feat(datagen): spell names regenerated from wago (enUS, minified, 413k entries, 13MB→12MB)
- `d6e8ba0` feat(datagen): raidbots talent fetch + real talentIdMap (40 specs, activates named-talent decoding)
- `1354e16` feat(datagen): wago csv + emit foundations
- `5b62fb0` fix(eval): final-review findings — blinding protocol, strict score schema, auditor robustness, CLI parity
- `6927ece` fix(eval): review findings — LCG strict [0,1) bound, dimensionScore numeric-string coercion parity
- `b01edc2` fix(eval): checkProvenance CLI accepts BASE_DIR without --run; e2e smoke pass
- `b71163f` feat(eval): score provenance validation (strict, no legacy leniency) + spot-audit/auditor-calibration ports
- `cba3178` feat(eval): judge calibration suite port
- `a09b091` fix(eval): corpus result is owner-relative Win/Loss/Unknown (ledger + calibration contract)
- `4d7446c` feat(eval): blind AB pool + paired stats port
- `0dfa847` feat(eval): deterministic prompt quality checks port
- `05536e9` feat(eval): corpus builder (gladlog parse chain, healer-owner prompts)
- `ec0439a` feat(eval): coverage manifest port
- `34315ae` feat(eval): eval-home resolver and private-repo init CLI
- `42c6ed1` feat(eval): package scaffold
- `6d2ce88` fix(review): final-review findings — AI stream race, key redaction, stream abort, pass2 id parity
- `1d586c4` fix(review): T2-6 review findings — params hardening, DR entries, API exports
- `d9a7024` fix(analysis): benchmark CLI parse-chain (correct GladLogParser API, glad-id keying, two-pass) + streaming aggregation; real-corpus benchmark_data (200 logs, 346 combats, 27 specs)
- `d6010e3` feat(analysis): local-corpus benchmark rebuild — stratified sampling, metrics core, CLI (haiku subagent)
- `d0e271d` feat(desktop): AI analysis panel wired to report page (unit/AI side tabs)
- `32df349` feat(desktop): main-process Anthropic streaming ai service (haiku subagent impl per degradation chain)
- `c54d051` feat(analysis): batch C + buildMatchContext port — full prompt pipeline green (459 tests)
- `e06f4d6` feat(analysis): core batch B port (dr/ccTrinket/dispel) + owned DR table; compat extra-spell fields
- `a7cbf6b` feat(analysis): core batch A port (cooldowns/enemyCDs/offensiveWindows) + catalog calibration via own tests
- `880fa92` feat(analysis): base utils port + owned classSpells/spellIdLists catalogs
- `ef34cf1` feat(analysis): data layer port — curated spell categories/effects, local SpellTag, talentIdMap placeholder
- `f47badd` feat(analysis): data layer port with curated spell-effect overrides
- `8f42be0` feat(analysis): package scaffold
- `7bf8c4d` fix(desktop): remount reports on doc switch (key); merge pet absorbs into owner; show build summary in unit panel
- `1fbd4b5` fix(desktop): bridge indirection — fixture override slot, contextBridge prop is read-only
- `7354548` feat(desktop): match/shuffle report assembly, fixture bridge, app shell restructure
- `70a3471` feat(desktop): SVG timeline (d3-scale) + unit detail panel
- `ffb3e46` feat(desktop): report header + meters components with jsdom test setup
- `f46c97e` feat(desktop): class colors/names + spec names incl. runtime-observed 1480 Devourer DH
- `3b14598` fix(desktop): death marks include players without combatant info
- `5c9271d` feat(desktop): cast and aura sequence derivation
- `f331308` feat(desktop): timeline derivation — hp series + death marks
- `9c47022` feat(desktop): unit summary derivation with pet merge
- `9c58353` feat(desktop): report derive types + roster derivation
- `8fc5268` feat(desktop): sanitized report fixture (self-collected 2v2) + generator script
- `9a0026e` fix(desktop): fatal parse errors crash worker for quarantine attribution; persist quarantine across reconfigure
- `68a68df` fix(desktop): process rename events in watcher — macOS reports new files as rename; tail reader tolerates races
- `a2a0f84` feat(desktop): log replay script for e2e acceptance
- `1eaa0ee` fix(desktop): build preload as CJS — sandboxed preload cannot load ESM, window.gladlog was never injected
- `4ccc4c7` feat(desktop): debug-grade live UI — status, match list, detail, diagnostics
- `dd858fd` fix(desktop): self-heal match dirs with corrupt meta (rm before rename); pin app name for stable userData
- `59b00da` feat(desktop): main-process assembly, typed IPC bridge, preload api
- `509f5a6` feat(desktop): match store — atomic meta/match/raw persistence with idempotent dedupe
- `cf6ea25` feat(desktop): worker host with crash attribution and per-file quarantine
- `5bc4330` fix(desktop): advance tail state only after batch fully fed to parser (no silent drops on push throw)
- `c724089` fix(desktop): guard tail reader against TOCTOU file deletion between stat and open
- `1452b34` feat(desktop): worker runtime — configure/scan/watch loop with checkpoint persistence
- `6daa66f` feat(desktop): file pipeline with safe-boundary checkpoints and rotation reset
- `15027d3` feat(desktop): byte-accurate tail reader with rotation/truncation detection
- `eb35f6d` feat(desktop): event-driven log watcher (ported own windows-agent watcher)
- `27dd8d7` feat(desktop): atomic checkpoint registry (ported own state.ts pattern)
- `3f8de42` feat(desktop): WoW dir detection + logs dir resolution (ported own detect.ts semantics)
- `72b2773` feat(desktop): worker protocol types + atomic SettingsStore
- `13d1e79` feat(desktop): electron-vite scaffold with main/preload/renderer/worker entries
- `2899449` feat(parser): read-only hasOpenSegment() for shell safe-boundary checkpoints
- `861b3c1` perf(parser): cache Intl.DateTimeFormat per timezone — 23k→105k lines/sec
- `449bfad` fix(compat): exclude CI-less player units (outsider filter, adjudication #27)
- `c7f0ebb` fix(compat): drop absorb interleave from damageIn; spellSchoolId hex string (adjudications #24/#25)
- `008c95f` fix(compat): spellId/extraSpellId as strings (adjudication #23)
- `3f014fe` fix: legacy CombatantInfo shapes — talents objects, string pvpTalents, structured equipment, aurasJSON (adjudication #22)
- `b978f5e` feat: raw params passthrough on events; legacy logLine.parameters with numeric coercion (adjudication #21)
- `9d6fe40` fix(compat): advancedActions entries carry advancedActorId + logLine (adjudication #20)
- `fd29dc8` fix(compat): teamId family as strings (legacy fidelity; downstream typeof check)
- `d836ce9` feat(parser): SPELL_SUMMON owner linkage for totems/guardians (adjudication #18)
- `a53b519` feat(compat): zero effectiveAmount for pet/guardian-targeted rows (adjudication #17)
- `b578f2e` feat(compat): merge pet/guardian dmg+heal into owner arrays (adjudication #16)
- `f6f9863` fix(parser): tolerate empty elements in COMBATANT_INFO nested arrays (Blizzard quirk)
- `a90b067` fix: absorb attacker-attribution + swing-form decode + legacy effective subtracts absorbed (adjudication #13)
- `b9f6f89` fix: preserve real event names in legacy shape; SWING_DAMAGE_LANDED dedup
- `e2b7012` fix: export type for type-only re-exports (tsx ESM runtime)
- `5adf9f3` fix(parser): type-only imports for ESM strictness (tsx runtime)
- `9514711` feat(compat): legacy damage sign convention + absorb interleaving (adjudication #6)
- `f5c7940` fix(parser): segment-anchored COMBATANT_INFO decoding (2024-vintage format from diff harness)
- `1828a0c` feat(compat): WoWCombatLogParser shim covering the 7 legacy call sites
- `0381920` feat(compat): legacy types + toLegacyMatch/toLegacyShuffle converters
- `0bfc6b2` feat(compat): package skeleton + legacy enums pinned to runtime manifest
- `5372410` feat(parser): GladLogParser emits GladMatch/GladShuffle; golden fixture assertions
- `276aad7` feat(parser): l3 outcome rules + match/shuffle composer
- `2624b14` feat(parser): l3 event-collection reducers (per-unit timelines, pet attribution)
- `422390c` feat(parser): l3 flags decoder + roster builder (owner via MINE bit)
- `c0cfd03` feat(parser): l3 data model + specToClass table
- `d6b7bc0` feat(parser): GladLogParser public shell (L1+L2 wiring, stats, diagnostics)
- `eda1550` feat(parser): l2 segmenter state machine (match/shuffle/diagnostics)
- `d7e9dcc` feat(parser): snr sweep script; timestamp variants from real-log sweep (UTC-offset suffix, variable fraction width)
- `cbda5ec` feat(parser): parseLine dispatcher + public L1 surface
- `b24fce2` feat(parser): combatant_info decoder
- `b3368f5` feat(parser): l1 event-family decoders
- `86bb502` feat(parser): l1 timestamp + top-level CSV tokenizer
