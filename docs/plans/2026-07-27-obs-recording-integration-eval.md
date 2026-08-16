# OBS Recording Integration Evaluation Report (Undecided)

2026-07-27. Corresponds to backlog #1. This document is evaluation only — no route decision is made. Sources: old fork
(`~/code/wowarenalogs`, CC BY-NC-ND, **concept reference only, implementation must be clean-room**) recorder
subsystem read-through + gladlog six integration seams point-by-point verification (all with file:line evidence) + npm ecosystem current state.

## 0. Goal

Automatically record arena match videos and play them back in sync with the combat log timeline — clicking a death/finding/burst window jumps to the corresponding video timestamp.

## 1. How the Old Fork Did It (Concept Distillation)

The old fork used `noobs` (a native Node binding by the Warcraft Recorder author) to **embed** an
OBS engine, with five core design points:

1. **Continuous buffer recording + post-hoc trimming, rather than event-triggered start/stop**. Root cause: WoW combat logs are not written to disk in real-time — `ARENA_MATCH_START` may be observed 20 seconds after the actual start. So as soon as the WoW process runs, it continuously records mkv to a buffer directory; when the start event arrives, it "promotes" the recording and rewinds (`StartRecording(offset)`); after end, ffmpeg stream-copies without re-encoding to trim out an mp4 (`keyint_sec: 1` ensures keyframe alignment error ≤1s).
2. **Two detection responsibilities are orthogonal**: process detection (tasklist polling, controls buffer on/off) vs log events (controls match boundaries). Match boundaries come 100% from the combat log parser; the recorder itself does not tail logs.
3. **Wall clock anchor written at recording time, pure lookup at playback time**: metadata records `recordingBufferStartWallClockMs`, trim offsets, etc.; the playback side uses a pair of pure functions for bidirectional combatTime↔videoTime conversion.
4. **Same-name triple association**: `<name>.mp4/.json/.png`, json embeds matchId; lookup is a full-directory linear scan with json substring matching (author self-annotated as hacky).
5. **`vod://` privileged custom protocol** for playing local video: bypassCSP + full HTTP Range (prerequisite for scrubbing), base64-encoded path to avoid Chrome domain lowercase normalization.

Scale: recorder package 3,910 lines (17 files, core `recorder.ts` 1,233 lines) plus playback component
526 lines, bridging ~300 lines, totaling ≈ **4,750 lines**. Additionally, three areas of "designed but botched implementation": disk quota SizeMonitor not wired, video processing queue commented out, uiohook PTT entirely disabled due to packaging conflicts.

`noobs` current state (npm tested): v0.0.204, LGPL-2.0, unpacked **85MB**, install stage
`node-gyp rebuild` (consumers need native toolchain/electron-rebuild), scripts use Windows path syntax,
**effectively Windows-only** (old fork throws on non-win32, package is optionalDependency).

## 2. gladlog Existing Seams (Point-by-Point Verification)

| Seam                          | Rating              | Details                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Currently in match" boolean  | **Ready to use**    | `worker/pipeline.ts:77` already consumes `hasOpenSegment()` (checkpoint not advanced), `parser/src/l2/segmenter.ts:139`                                                                                                                                                                                       |
| Match start/end **real-time events** | **Needs minor change** | Does not exist today — parser only emits `match` on `ARENA_MATCH_END`; match start is completely invisible to the main process. Option A: pipeline detects `hasOpenSegment` flipping (~8 lines, cannot get bracket/exact timestamp); Option B: segmenter adds `segmentOpen` callback (~25 lines across 2 packages, with bracket/zone/timestamp, cleaner). Note: file rotation `createParser()` silently clears open state, needs supplementary close |
| Start detection latency       | **Hard constraint ~2s+** | watcher is batch-flush (`flushIntervalMs: 2000`, `main/index.ts:71`), plus WoW's own log write latency (can reach several seconds to 20s+)                                                                                                                                                                   |
| Time domain                   | **Ready to use**    | `StoredMatchMeta.startTime/endTime` is epoch ms (`matchStore.ts:188`), same domain as `Date.now()`, video time window directly comparable                                                                                                                                                                     |
| Video↔match association storage | **Needs creation** | 🔴 **Must NOT be placed in `<matches>/<id>/` directory** — re-store self-healing path `rmSync`s the entire directory (`matchStore.ts:443`), videos would be silently deleted. Should use independent `<userData>/recordings/` + `recordings.ndjson` index; ingestion hook at `main/index.ts:77-80` (`r.meta` is in hand, zero extra IO to backfill matchId) |
| Unified seek pipeline         | **Ready to use**    | `SeekRequest{tMs,nonce}` (`ReplayView.tsx:60`) already reused by 10+ components (KeyMomentAxis/MistakesCard/KickDashboard/EventsPanel/StatsTable…), unified signature `onSeek(tSeconds, unitNames)`                                                                                                            |
| Video player mounting         | **Needs minor change** | Must mount inside ReplayView; video element acts as a **follower** of the replay clock `t` — two comments explicitly state the replay clock is intentionally kept local to prevent three-view hot re-rendering (`MatchReport.tsx:66`, `ReplayView.tsx:120`). This way 10+ seek entry points work with zero changes |
| Settings/IPC                  | Mostly **ready to use** | `settings:get/save` generic pass-through, preload types auto-follow; need to add fields + defaults + **password masking** (`redactSettings`, following `anthropicApiKey` pattern) + SettingsPanel new group; directory chooser is hard-bound to wowDirectory, needs generalization (`ipc.ts:92-102`)              |
| recorderService               | **Needs creation**  | `main/recorder.ts`, following the `createXService({getSettings, emit, …})` factory pattern of analysis/compare, created at `main/index.ts:164` vicinity; exit hook supplement at `:189-192` (otherwise leaves unclosed video files). **Do not put in worker process** — utilityProcess crash isolation would kill the recording connection along with it |
| Packaging extraResources precedent | **Ready to use** | `reference_vectors.json` (`package.json:57-62` + `process.resourcesPath` branch)                                                                                                                                                                                                                              |
| Packaging hazard              | **Needs cleanup**   | Repo has a **stale `electron-builder.yml`** (`files` whitelist + `npmRebuild:false`, contradicts the actually active package.json `build` block) — harmless now, but once native modules are embedded, if someone "fixes the yml" it will simultaneously break both lifelines of native modules. Pre-requisite for embedded route: delete it |
| macOS                         | **Hard blocker**    | Screen/game capture needs TCC permissions + entitlements; current state is ad-hoc signed without notarization (`build/afterSign.cjs`). Mac recording not recommended for scheduling, Windows-first (consistent with backlog original text)                                                                       |

## 3. Three Routes

### Route A: Externally Control User-Installed OBS (obs-websocket)

OBS 28+ has a built-in websocket v5 server; `obs-websocket-js@5.0.8` is a ready-made client.
recorderService connects to `ws://127.0.0.1:4455`, start event → `StartRecord`, end (or ingestion)
→ `StopRecord` (returns outputPath) → backfill matchId by time window.

- **Engineering effort**: start/end events (8–25 lines) + recorderService (~300–500 lines) + association index
  (~150 lines) + settings (~100 lines) + `vod://` protocol (~70 lines) + ReplayView video follower
  (~150 lines) ≈ **1–1.5k lines, day-level**. Zero native dependencies, zero bundle size increase, no packaging changes.
- **Cost**: user must install OBS, enable websocket, configure capture scene (game capture source/resolution/encoder)
  — threshold transferred to user; tension with FAQ-driven new user acquisition direction.
- **Missing start problem**: external control has no buffer rewind; start detection latency (2s flush + log lag) means
  the video **is missing a few seconds to tens of seconds at the beginning**. Three mitigations (to be chosen):
  1. Accept missing start (deaths/findings rarely occur in the first 10s of a match; replay sync value essentially unharmed);
  2. Use OBS Replay Buffer: on match end `SaveReplayBuffer` to get "last N seconds" covering the entire match
     — N must be ≥ longest match (long lobby memory/disk pressure), and the result is a single file requiring no stitching;
  3. Start recording early: detect log file write activity (WoW is running) then `StartRecord`, after end self-trim with
     ffmpeg — this starts reinventing the buffer model, and the trimming chain's complexity slides toward Route B.
- **Robustness**: OBS not running/disconnected/user manually stops recording must all degrade to "this match wasn't recorded", must not affect the analysis main pipeline.

### Route B: Embedded Recording Engine (noobs, Clean-Room Reimplementation of Old Fork Concepts)

Zero user configuration — just having gladlog open auto-records (Warcraft Recorder experience).

- **Engineering effort**: old fork equivalent ≈ 4,750 lines, of which `recorder.ts` (OBS state machine, signal bridging,
  source property negotiation, preview) is the difficulty core; plus CC BY-NC-ND constraint requiring **clean-room rewrite**,
  buffer+ffmpeg trim pipeline, wall clock anchor metadata. Estimate **4–6k lines, multi-week level**.
- **Native integration cost** (the real heavy lift, not counted in lines): noobs 85MB + electron 38.8.6 ABI
  node-gyp rebuild (monorepo hoisting requires CI testing), OBS runtime DLL/plugin directory via
  extraResources, asar unpacked path correction, noobs version-to-version signal/property name drift (old fork has
  extensive dual-name compatibility defenses). Pre-requisite: delete stale `electron-builder.yml`.
- **Platform**: Windows-only (noobs is effectively so; mac has separate signing hard blocker). Bundle +100~200MB.
- **License**: noobs is LGPL-2.0, no issue as a dynamically linked npm dependency; old fork code cannot
  be copied at all, concept checklist see §1.

### Route C: Two-Phase (A First, Then B, Interface Unchanged)

First version takes Route A to wire up the full "auto start/stop + association + sync playback" pipeline,
with an `IActivity`-style 9-line data contract (time window + naming + metadata) as the capture abstraction;
after value validation, swap the capture side for an embedded engine — playback/association/seek layer
zero changes. The old fork's "detection and recording are orthogonal" design naturally supports this swap.

## 4. Parts Independent of Route — Must Be Done Regardless (≈60% Engineering Overlap)

1. Start/end real-time events (§2 Option A or B);
2. `recordings/` independent storage + ndjson index + time window association (with tolerance; Solo Shuffle's entire
   lobby is one video segment corresponding to 6 rounds, seek by round `startTime` offset — granularity is correct.
   Note: shuffle single-round `endTime` is clamped to the decisive death timestamp, `compose.ts:153-163`);
3. `vod://` privileged protocol (Range support);
4. ReplayView video follower + wall clock conversion (video start epoch ms − match `startTime`);
5. Recording settings group (toggle, directory, retention policy; Route A adds websocket address/password, password uses masking);
6. Disk retention policy: 15Mbps × 10min ≈ 1.1GB/match, current library 794 matches — **must have quota + rolling
   deletion** (the old fork's SizeMonitor was exactly the botched part, learn from it: quota must be wired from v1,
   and protected markers must pass through deletion filter).

## 5. Deployment Model Pitfalls (gladlog-Specific, Old Fork Doesn't Have)

gladlog supports cross-machine log relay (streamer→Google Drive→collector). **Video only exists on
the gaming machine locally** — 1GB/match cannot go through Drive relay. If analysis/playback happens on the collector machine, the entire video
association and playback pipeline fails. Evaluation conclusion: recording feature is positioned as a **gaming machine local feature**; cross-machine scenario explicitly
degrades (index matchId association still written, playback entry hides when file doesn't exist), v1 does not do video transfer.

## 6. Risk Summary (Condensed)

| Risk                            | Route | Mitigation                                                    |
| ------------------------------- | ----- | ------------------------------------------------------------- |
| Log lag → missing video start   | A     | §3A three choices, leaning toward accepting missing start     |
| Video deleted by matchStore self-healing path | All | Physical storage isolation (§2 red line)                |
| OBS disconnected/not running → silent missed recording | A | Status reporting to UI (following `watching` status bar pattern), missed recording doesn't touch analysis pipeline |
| Native module × electron-builder | B    | Delete stale yml; extraResources; CI win runner test rebuild  |
| mac permissions/notarization    | B     | Don't schedule mac, Windows-first                             |
| Disk full                       | All   | Quota wired from v1                                           |
| License (CC BY-NC-ND / LGPL)    | B     | Clean-room + noobs as dependency only                         |

## 7. Inclination (For Decision, Not a Decision)

**Route C (A first, then B)**. Rationale: ①The two routes have 60% engineering overlap all on the gladlog side; the parts done first
are not wasted regardless; ②The product value of "replay sync" can be validated with 1–1.5k lines and zero packaging risk first; ③The embedded engine's
native integration is a risk category unseen in the entire project (85MB native dependency + ABI + OBS runtime layout), worth
tackling separately after the pipeline is through and value is proven. Signal to trigger upgrade to B: actually using replay sync ourselves/from users, and "having to install
OBS" becomes a real threshold in feedback.
