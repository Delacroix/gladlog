# Cross-Machine Log Relay + Lint + Windows Build Design

Date: 2026-07-12
Status: Pending User Review

## Background and Objectives

Port three pieces of **user-owned** infrastructure from the old fork (`/Users/mingjianliu/code/wowarenalogs`, now CC BY-NC-ND) into gladlog, and produce a Windows build of the main analysis app:

1. **windows-agent** (log streaming upload agent) + **wal-pilot** (streamer/collector orchestration) → Combine into a single `packages/log-pipeline` package.
2. **lint** (gladlog currently lacks ESLint) → Root-level flat config.
3. **Windows binary**: electron-builder Windows build of the main gladlog desktop application.

**Deployment Topology (User Confirmed)**: Cross-machine Windows → Mac. Run the streamer on the Windows gaming PC and the collector on the Mac for post-match analysis. The old design used a GCS bucket as an intermediate layer; gladlog is cloudless, so it switches to a **Google Drive (Drive for Desktop) shared folder** for transfer (both ends set to "available offline/mirrored").

**Collector Responsibility (User Confirmed)**: Reconstruct-only — reconstruct segments into complete `.txt` logs written to a regular output folder, with no analysis. The user will manually open this folder with gladlog.

## Compliance Conclusion

`windows-agent` (18 commits) and `pipeline-app` (19 commits) were **100% written by the user (Mingjian Liu) personally**, are owned assets post-fork, and are not upstream expressions. The Subproject 0 audit's only hits on these three packages were 7 instances of **trivial configuration boilerplate** (`.eslintrc.js`/`jest.config.js`/`.eslintignore`, 1–5 lines, matching similar configs in other packages within the same fork), plus a 1-line coincidence in `cli.ts` — none of which are copyrightable expressions. Per the roadmap rule "Files that pass audit → direct copy", these user-owned files can be ported into gladlog almost verbatim. The ported trivial configs would have been rewritten anyway for the gladlog toolchain (vitest, flat ESLint). **Not a single line of upstream (original wowarenalogs author) code is touched**; controller extraction, subagents/agy do not read the old fork.

## Out of Scope

- Electron pilot tray GUI + setup wizard (`main.ts`/`preload.js`/`wizard.html`) — user opted not to package pilot. Its orchestration logic (role resolution, config) is reused as a CLI.
- The Collector's batch analysis chain (`localBatchAnalysis`, `claudeCli`, analysis steps in `collectLogs`) — reconstruct-only.
- GCS adapter + `@google-cloud/storage` dependency — cloudless.
- Code signing, actual Windows machine installation acceptance — user barrier items.

---

## Component One: `packages/log-pipeline`

### Package Structure and Reuse/Discard

Single package, two bin commands. **Verbatim reuse** (user-owned CLEAN files, only changing import paths + ESM + vitest):

- `protocol/{identity,segments,reconstruct}` (see "Protocol Hardening" below — segments/reconstruct have targeted modifications)
- `storage/{StorageAdapter,adapterContract,createAdapter,LocalDirStorageAdapter,MemoryStorageAdapter}`
- `config` (`AgentConfig` + `loadAgentConfig` validation)
- `watcher`, `flusher`, `state`, `initialScan`, `heartbeat`, agent `index` (`flushBatch`)
- streamer/collector service logic, `pilotConfig`, `detect`, `cleanup`
- `collectLogs.runCollection` (reconstruction loop) + `collect/{collectorConfig,statusFile}`

**Discard**: `GcsStorageAdapter` + `@google-cloud/storage`; collector analysis calls; pilot Electron shell.

De-Windowsification of naming: the `stream`/`collect` commands can run on either OS; only the "run streamer" step happens to be on the Windows side.

### Data Flow

1. **Windows streamer** — `startLogWatcher` monitors the WoW `Logs` directory. File by file, it uses `firstLineChecksum` → `gen8` (content identity, a reconstructed log with the same name is treated as a new stream) and records the uploaded byte offset in a local `state`. Every flush reads incremental bytes, `put`s them into the Drive folder as **immutable segments**, and writes a `status/<host>.json` heartbeat.
2. **Google Drive** mirrors whole files Win → Mac.
3. **Mac collector** — `runCollection` lists segments, groups them by (host, logfile, gen8), precisely reconstructs bytes, appends them to `.txt` files in the output directory, deletes fully applied segments with `cleanupAppliedSegments`, and writes the runtime status file.

### Protocol Hardening (From agy debate — see bottom)

The original scheme keyed segments solely by starting offset (`<startOffset>.seg`) and read the delta to the current EOF (non-deterministic length). A silent corruption path **independent of the transport layer** was discovered: if the process is killed between `adapter.put` and `saveState`, restarting will re-flush a **longer** delta with the **same offset key**; if the collector has already consumed and cleaned up the shorter one, the longer segment is treated as a duplicate and discarded because `offset < currentSize` → silent byte drop + permanent stall. This flaw was equally latent in the original GCS design; Drive doesn't introduce it.

**Adopted Fix** (agy steelman, refined):

- Segment keys are changed to `raw/<host>/<logfile>/<gen8>/<startOffset>_<length>.seg` (encoding uncompressed delta length); content remains `gzip(delta)`. Two different-length re-flushes at the same offset (e.g., `100_50.seg` and `100_200.seg`) become **coexisting distinct files**.
- Collector reconstruction is changed to be **overlap-aware**, processing candidate segments in ascending startOffset order:
  - `startOffset + length ≤ currentSize`: Entirely within the reconstructed area → duplicate, skip.
  - `startOffset ≤ currentSize < startOffset + length`: **gunzip first**; if it fails (Drive partial materialization/in-flight corruption — gzip has built-in CRC32 + length tail) → treat as not ready, **do not advance**, try again next poll; if successful, seek to `(currentSize - startOffset)` to append the remaining bytes, and advance `currentSize` **by the actual number of decompressed bytes appended** (never advance by the length claimed in the filename).
  - `startOffset > currentSize`: gap → wait.
- **gzip's CRC32 doubles as an integrity check**: partially synced or corrupted `.seg` files fail decompression → safely deferred, no need to add a crc to the filename. WoW logs strictly append; re-reading source bytes at the same offset is identical, so there's no "overlap content divergence" scenario.

This fix completely eliminates both the silent byte drop and permanent stall failures. It's a **targeted hardening** of the user's own code during the porting phase, with changes concentrated in `segments.ts` (building/parsing keys with length), `reconstruct.ts` (`nextAction` → overlap awareness), `flusher.ts` (passing length to `buildSegmentKey`), and the collector application loop (gunzip validation + actual advancement).

### CLI and Configuration

Two explicit commands, JSON config driven (reusing `loadAgentConfig`/`pilotConfig`/`collectorConfig` validation):

- **Windows** `gladlog-stream --config stream.json`
  ```json
  {
    "wowDirectory": "C:\\...\\World of Warcraft\\_retail_\\Logs",
    "hostname": "gaming-pc",
    "flushIntervalMs": 60000,
    "storage": {
      "provider": "localDir",
      "directory": "G:\\My Drive\\gladlog-relay"
    }
  }
  ```
- **Mac** `gladlog-collect --config collect.json`
  ```json
  {
    "segmentsDir": "/Users/you/Google Drive/gladlog-relay",
    "outputDir": "/Users/you/gladlog-logs",
    "pollIntervalMs": 15000,
    "cleanup": true
  }
  ```

Both ends run under Node (`npm run stream`/`npm run collect` or bin names). The `resolveRole`/`detect` of `pilotConfig` are kept in the tree to facilitate adding a platform-based automatic dispatch `gladlog-pilot` thin wrapper later (reuse instead of delete, not the main entry point). Config errors fail fast with clear messages; if the Drive directory doesn't exist, it's treated as "no segments yet" — wait and poll.

### Drive Setup Requirements (Non-code)

The Drive folder must be set to "Mirrored/Available offline" on **both ends**, not just online placeholders, otherwise reads return placeholders instead of bytes. This will be documented. Sync delays only prolong the gap wait; the heartbeat file allows the collector to mark the streamer as stale. Drive conflict copies (`… (1).seg`) are ignored due to mismatched key parsing.

### Privacy Notice (Non-blocking)

Drive transmission means the user's own combat logs transit through Google's cloud. This is a personal choice by the user for their own data across their own two machines, not a product default or a community upload like the old fork. The documentation will accurately state this.

---

## Component Two: Lint (Root-level flat config)

Add a single root `eslint.config.js` (ESLint 9 + `typescript-eslint`), covering all packages. Reuse valid rules from the old `linter/index.js`, discarding Next.js specific parts:

- Reuse: `@typescript-eslint` recommended, `simple-import-sort` (warn), `no-console` (allow `warn`/`error`), `no-unused-vars` (ignore `^_`), `react/react-in-jsx-scope: off`.
- Add to gladlog stack: `eslint-plugin-react-hooks` (rules-of-hooks + exhaustive-deps, for the desktop renderer); `eslint-config-prettier` (leave formatting to the existing Prettier).
- Ignore: `node_modules`, `dist`, `out`, `coverage`, build artifacts.
- Scripts: Root `lint` (`eslint .`) + `lint:fix`. Root-level devDeps.

**Severity Strategy**: True bug classes (`no-unused-vars`, rules-of-hooks) must be `error`; style classes (`simple-import-sort`) start as `warn`. The lint task includes making `npm run lint` pass: fix real issues, don't churn unrelated code en masse. If violations are numerous, report the numbers first and scope it with the user; no silent churn.

---

## Component Three: Windows Build (Main gladlog desktop app)

Current State: The `package:win` script is present, electron-builder 26 is installed, but there is **no `build` config, no app icon, and no Wine locally** (cross-building NSIS from macOS requires Wine).

- **Add electron-builder `build` config** (`packages/desktop/package.json`): `appId` `com.gladlog.desktop`, `productName` `gladlog`, output to `release/`, `files` covers `out/**` + `package.json`, `win.target` = `nsis` + `zip`, `nsis` options (per-user, allow changing install dir), `win.icon`.
- **Original App Icon** (256px `.ico` in `build/`): Simple original mark, no upstream/Warcraft imagery (compliant).
- **Locally Producible**: `--win zip`/`dir` doesn't need Wine → Produce a runnable unpackaged Windows app from Mac for end-to-end config verification.
- **True `.exe` NSIS Installer** requires one of two: `brew install --cask wine-stable` locally, or run `npm run package:win` on the user's Windows machine. The repository has **no git remote**, so CI is not available without a remote.
- **User Barriers**: Code signing (requires a certificate; unsigned → SmartScreen warning), actual Windows machine installation-launch smoke test.

**Recommendation**: First fully configure + icon + produce win-zip build from Mac to prove the packaging pipeline; the NSIS installer via Wine (local) or Windows machine will serve as the acceptance step. The installer route will be decided in the implementation plan.

---

## Error Handling

- **Streamer**: Single-file failure isolation (one bad file doesn't starve the whole batch); ENOENT (file disappeared) drops from queue, no retry; heartbeat write failures are deduplicated and warned, non-blocking.
- **Reconstruct**: gap → wait; gunzip failure (partial sync/corruption) → defer; duplicate segment → skip; conflict copies → key parsing ignores.
- **Config**: Validation failures exit fast with clear messages.
- **Collector Output**: Atomic writes (tmp→rename) to prevent downstream reading half-files.

## Testing Strategy (vitest)

- **Protocol Unit Tests**: `segments` (key building/parsing with length, rejecting invalid/conflict names), `reconstruct` overlap awareness (duplicate no-op, gap, partial overlap append, actual advancement), `identity` (CRLF first-line validation).
- **End-to-End Round Trip** (`MemoryStorageAdapter`, no Drive): Write log → streamer flush → collector reconstruct → byte-for-byte equals original log.
- **Regression/Hardening Cases** (Targeting agy flaws): Simulate "crash after put, before saveState" → longer re-flush at same offset → assert reconstruction has no dropped bytes, no stall; simulate partial materialization (truncated gzip `.seg`) → assert collector defers and subsequently completes.
- **Lint**: Passing `npm run lint` acts as a gate.
- **Windows Build**: Successfully producing a win-zip from Mac, containing an icon and complete `out/**`, serves as acceptance (installer + real-device launch is a user barrier).

## Subproject Breakdown and Sequencing

Three loosely coupled pieces, recommended sequence (each independently testable):

1. **Lint** (Small, independent) — Do first, so subsequent new packages are bound by lint upon landing.
2. **log-pipeline** (Main body) — Protocol hardening + streamer/collector CLI + round-trip tests.
3. **Windows Build** (Small-Medium) — electron-builder config + icon + win-zip verification.

These three can be placed in a single implementation plan (lint and build are bookends, pipeline is the main body).

## Design Decision Debate Record (agy ritual)

2026-07-12 debate-open/reply run on "Google Drive for byte-exact log reconstruction transport" (conversation `10aa57bb`, OPPOSE → PARTIAL).

- **surfaced (fixed design)**: The original `<offset>.seg` key + reading to EOF with non-deterministic chunks could silently drop bytes and permanently stall upon "crash between put and saveState + file has grown". **Independent of transport**, equally latent in the original GCS design. Adopted "length-encoded keys + overlap-aware reconstruction" fix.
- **PARTIAL (Secondary Refinement)**: agy pointed out that "advancing by filename claimed length" would still evaporate in-flight tail bytes under Drive partial materialization. Corrected to **gunzip validation first, advance by actual decompressed bytes**; gzip's built-in CRC32 doubles as in-flight corruption detection, no need for crc in filename. WoW append semantics → no overlap content divergence.
- **Defense Upheld**: Drive's eventual consistency, sync delays, and conflict copies do not cause corruption in themselves — immutability + offset keys + strict key parsing + gap waiting covers this; the true risk is non-atomic (put, saveState) + non-deterministic chunks, which is now closed by hardening.

## Outstanding Items

- Windows NSIS installer route: Local Wine vs. User Windows machine (decide in implementation plan).
- Whether to add `gladlog-pilot` single command automatic dispatch later (keep `resolveRole`/`detect`, out of current scope).
