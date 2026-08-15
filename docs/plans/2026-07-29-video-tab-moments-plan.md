# Video tab key information association (marker strip + event feed) implementation plan

2026-07-29, user approved brainstorm plan A+C: A=marker strip aligned below the video; C=**playback event feed in an independent column on the right side of the video** (user specified: not overlapping the top right of the screen). Behavior: slides in from bottom when playback passes the event moment, old items fade out when time is up, pushed up from below (kill-feed style). Branch `feature/obs-recording`, accept v0.1.14-obs.6 test package.

## Design Points (brainstorm finalized)

- **Single source of truth for data**: New derive `videoMoments.ts` merges three streams——`deriveKeyMoments`
  (death/burst band/defense/dispel/cc, relative seconds) + `deriveMistakes` (⚠ 8 categories) +
  AI deep dive chips (`analysis.getCached(matchId)`'s `findings[].deepDive.chips`,
  `t` is already relative seconds). Unified as
  `VideoMoment {tS, toS?, kind, weight, label, unitNames}`.
- **A Marker Strip**: Monospaced alignment with video progress; background paved with burst-band gold strips, ✕ death (red),
  ⚠ mistake (gold) markers; hover title, click `video.currentTime = tS + offset`.
  Only draw major + mistakes, minor not in strip (prevent dense).
- **C feed**: Right side ~280px column. The core is a **pure function reducer** (testable):
  `advanceFeed(state, nowS, wallNow, moments)` —— normal progress receives `(lastS, nowS]`
  moments; time jump (rewind or fast forward >3s) resets to `(nowS-5, nowS]`; wall clock TTL
  expires in 5s (first mark `out` to play 400ms fade-out animation then remove); on-screen cap 4, discard oldest if exceeded.
  Driver = video `timeupdate` (~4Hz), does not touch replay page clock. Toggle button + localStorage
  memory.
- **Conversion**: `videoS = tS + (source.startTime - startedAt)/1000`; strip percentage
  uses video.duration (after loadedmetadata).
- **AI chips fetching**: VideoTab adds new `matchId` prop (MatchReport passes
  `resolvedMatchId` —— shuffle's analysis cache for each round is already by round, chips relative seconds are also by round,
  which are two orthogonal ids compared to the recording videoMatchId, don't mix).
- Known boundary: Native fullscreen fullscreens the video element, feed/strip invisible——accepted for phase 1.

## Tasks

1. `derive/videoMoments.ts` + tests: merge three streams on fixture, sort by tS, label non-empty;
   AI chips injection path uses fake chips.
2. `components/VideoFeed.tsx`: export pure `advanceFeed` + component; reducer unit test coverage
   progress/jump reset/TTL/cap.
3. `components/VideoMomentStrip.tsx`: pure display + onSeek; test: major count rendering
   and click callback.
4. `VideoTab.tsx` wiring: flex layout (video main body + right column), timeupdate → battleS,
   strip/feed mounting, AI chips fetching (try/catch degraded if missing), toggle;
   MatchReport passes matchId. Update existing VideoTab tests.
5. presubmit → commit → v0.1.14-obs.6 → Real device acceptance (strip click tracking, feed slide in/
   fade out/push up, dragging progress bar doesn't pop history).
