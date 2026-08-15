# Clean Rewrite Roadmap + Subproject 0 (Own Code Compliance Audit) Design

Date: 2026-07-10
Status: Pending User Review

## Background and Goals

The upstream wowarenalogs changed its license from MIT to CC BY-NC-ND 4.0 on 2025-12-08 (commit `cf2e72ea`), prohibiting the distribution of modified versions. The user has decided to **rewrite from scratch** their own WoW arena log analysis product: not using any upstream code (including the MIT-era code), and retaining only their own original code assets.

**Product Goals**: Desktop application installer + Open source code repository. Local-first: parse local combat logs, browse combat reports, AI replay analysis (direct connection to LLM API). No login, no cloud uploads, no community match browsing; no recording functionality in the first version.

## Confirmed Design Decisions

| Decision | Selection | Rationale |
| --- | --- | --- |
| Upstream Code Usage Boundary | Not a single line (including MIT-era) | User's intent: complete separation from the original author; collateral benefit: the new project does not need to retain any third-party copyright notices. |
| Tech Stack | Electron + React + TypeScript, Vite replacing Next.js | Same stack as the user's existing assets (React components, Node toolchain), minimizing migration costs. |
| Cloud Features | Completely removed | No server maintenance costs; the user already has experience with local Next server architecture. |
| Recorder | Not included in the first version | Avoids the largest chunk of the rewrite workload. |
| New Repository History | Entirely new repository, starting with a single orphan commit | Upstream code will never appear in the history; simplest approach. |
| Game Data | Write custom scripts to regenerate from primary sources (Blizzard API / raidbots) | The data is factual data from Blizzard, free to re-export; does not include upstream compiled JSON results. |
| New Parser Data Model | Freely design own model + **Thin adapter layer** to downstream | Corrected via agy debate: full compatibility with old interfaces would lock the new parser into upstream designs; instead, the adapter only maps the minimum subset of fields actually consumed downstream. Downstream code is proprietary, so interface names can be bulk renamed. |

**Compliance Principles** (Running through all subprojects):

- Functional concepts, log format knowledge, and architectural ideas are not copyrightable and can be referenced; code expression must be entirely new.
- UI visuals must be original: functional concepts (round segmentation, death timeline, etc.) can be referenced, but pixel-perfect imitation of the original layout is not allowed.
- "Own code" trichotomy: files that pass the audit → copy directly; containing upstream snippets → scrub the snippets; own modifications scattered in upstream files → extract logic and relocate.
- Project name and logo must not use "WoW Arena Logs" or anything similar.
- Existing forks (including ND-era code) are recommended to be made private and no longer publicly distributed.

## Subproject Breakdown and Sequence

Build Sequence: **0 → 1 → 2 → 3 → (4 ∥ 5)**. Each subproject will go through spec → plan → implementation individually.

| # | Subproject | Content | Key Dependencies |
| --- | --- | --- | --- |
| 0 | Own Code Compliance Audit | Confirm file-by-file which "own" files can be taken as is, and which need scrubbing (second half of this document). | None |
| 1 | Parser Library | Implement WoW combat log parser from scratch, freely design data model + thin adapter layer to connect downstream; use existing real log fixtures for golden testing. | 0 (conclusions on ownership of fixtures and test code) |
| 2 | Desktop Shell | Electron + Vite + React skeleton: log directory monitoring, IPC bridge, electron-builder packaging. | 1 |
| 3 | Combat Report UI | Originally designed combat report (damage/healing, timeline, unit panels). | 1, 2 |
| 4 | AI Analysis + Eval System Porting | Connect CombatAIAnalysis, prompt system, eval toolchain, windows-agent, and pipeline-app to the new data model. | 0, 1 |
| 5 | Game Data Pipeline | Own scripts to generate spell/talent data from primary sources. | 0 (can run in parallel with 3, 4) |

Scale Indication: 0 takes ~1-2 days; 1 is the largest single piece (month-level); 4 = import replacement/adaptation + **data realignment phase** (threshold review, benchmark rerun, eval regression, see debate record).

---

## Subproject 0: Own Code Compliance Audit — Detailed Design

### Purpose

Before porting any "own" files, machine-check whether they embed upstream code, producing a file-by-file disposition list. This is the foundation for all subsequent subprojects and evidence against doubts after open-sourcing.

### Input

- List of newly added own files: `git diff --diff-filter=A --name-only 7842b644(merge-base) main` (the newly added portion of the ~1347 changed files, ~1000+ files).
- Upstream full blob library: all file versions across the entire history of upstream/main (both MIT and ND eras are considered "upstream" since not a single line will be used).

### Method (Three-Tier Detection, Coarse to Fine)

1. **Exact Whole-File Match**: Check if the git blob hash of the own file appears in any upstream commit → If yes, mark as `DERIVED` (entirely from upstream).
2. **Copy Origin Detection**: Use `git log --follow -C -M` to check if the file originated by "copying/renaming an upstream file" → If yes, mark as `DERIVED`.
3. **Snippet-Level Similarity**: Index the normalized lines (removing whitespace and comments) of all upstream TS/TSX/JS files; calculate the longest continuous common block and shared line ratio against any upstream file for each own file. Thresholds: ≥ 8 continuous identical lines, or > 30% shared lines → Mark as `NEEDS_SCRUB` and list specific snippet locations for manual review.

The tool will be a one-off script placed in `scratch/` (will not enter the new repository). Thresholds can be adjusted after the first run based on false positive rates; adjustments must be recorded in the report.

### Calibration (Preventing Tool Self-Deception)

- **Positive Control**: Take a file known to be copied from upstream (e.g., an upstream copy prior to `generateDataManifest.ts` created upstream, or test directly with an upstream file), the tool must report `DERIVED`.
- **Negative Control**: Take a confirmed purely original file (e.g., an eval report generator), the tool must report `CLEAN`.
- If either control fails, fix the tool before running the full set.

### Output

`docs/analysis/2026-07-XX-own-code-audit.md`, including:

- File-by-file trichotomy: `CLEAN` (direct copy) / `NEEDS_SCRUB` (list snippet locations and source files) / `DERIVED` (fully derived, requires a rewrite from scratch).
- Appendix: An extraction list of own modification hunks (`git diff 7842b644..main -- <file>`) across all upstream files modified by the user (including 58 overlapping files modified by both the user and upstream during the ND era), for logic extraction in subproject 4.
- Detection methods, thresholds, and records of control results.

### Error Handling and Boundaries

- Binary/JSON data files will skip snippet detection and be judged individually by their source of origin (confirmed: `spellNames.json`, `talentModifiers.json`, `trinketItemIds.json` are owned; `spellIdLists.json`, `spellClassMap.json` are from upstream ND era and will not be taken).
- Test fixtures (real combat logs `.txt`) are Blizzard game outputs and not upstream copyright material, so they can be taken. However, if fixtures included in the upstream repository were copied into own tests, their source should be marked as "collected from upstream repository." It is recommended to replace them with self-collected logs (the user has a windows-agent collection pipeline, so replacement cost is low).
- Any files with uncertain determinations will be downgraded (better to mark as `NEEDS_SCRUB` than to pass).

### Success Criteria

- All newly added own files have a clear trichotomy conclusion, with zero "unaudited."
- Both calibration controls pass.
- `NEEDS_SCRUB`/`DERIVED` files are each accompanied by specific evidence (upstream corresponding file + line numbers) for manual spot-checking.

## Design Decision Debate Record (agy debate ritual)

On 2026-07-10, a debate-open/reply was run on the core decision ("rewrite from scratch, not using a single line") (conversation `44891a10`, initial OPPOSE → final PARTIAL).

**Concession (Design Revised)**: The original plan "new parser data model is compatible with downstream consumption" was self-contradictory—fully replicating dozens of upstream interfaces would lock the new parser architecture into upstream designs and create the perception of a derivative work. This has been corrected to a **thin adapter layer**: the new parser freely designs its model, and the adapter only maps the minimum subset of fields actually consumed downstream.

**Defense Sustained**: Undocumented log semantics (e.g., "immunity does not trigger SPELL_AURA_APPLIED") are objective facts output by Blizzard games and are not protected by copyright; the new parser validates these behaviors with self-collected logs instead of copying upstream code.

**Disclosed Hidden Costs (User must be informed)**: Empirical thresholds and benchmark calibration data for AI analysis were fitted based on the output of the old parser. Minor differences in event ordering, fault tolerance, and edge-case handling in the new parser will cause these calibrations to drift—Subproject 4 is not just import replacements, it also involves a **data realignment phase**: threshold review + benchmark rerun + eval system regression. Mitigation strategy: retain the old fork locally as a **private test oracle** (CC BY-NC-ND does not restrict private use), run differential tests with the old and new parsers on the same batch of fixture logs, quantify the drift, and then decide which thresholds need to be refitted.

## Unresolved Items

- New project name: use a codename for now, decide before registering the repo.
- Audit report specific date placeholder (`2026-07-XX`) to be filled during execution.
