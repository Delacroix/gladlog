# Data & Licensing Compliance

**English** · [中文](DATA-COMPLIANCE.zh-CN.md)

This page records what gladlog takes from outside sources, under what terms, and
which practices we have explicitly ruled out. It exists so the question does not
have to be researched from scratch every time — and because this repo has already
been wrong about it once (an earlier note called the wowarenalogs feed "our own
product"; it is not).

Findings below were verified on **2026-08-01** unless stated otherwise. Anything
load-bearing is dated, because terms change and code does not notice.

## 1. The upstream data source

`wowarenalogs.com` is a **third-party volunteer project** (legal entity: Alotof
Technology LLC, Kirkland WA; contact `privacy@wowarenalogs.com`; maintainer
channel: their [Discord](https://discord.gg/NFTPK9tmJK)). We are not affiliated
with it. Its Firestore reads and Cloud Storage egress are billed to them, not us.

What governs use of the site, in full:

| Document                                                | What it says                                                                                                                                    | Effect on us                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [privacy.html](https://wowarenalogs.com/privacy.html)   | "Your contributions to the Service are intended for public consumption and are therefore viewable by the public, **including your game logs**." | Uploaders consented to their logs being public. This is our strongest footing. |
| `robots.txt`                                            | `User-agent: * / Disallow:` — fully permissive, no `Crawl-delay`                                                                                | Automated access does not violate robots.                                      |
| [LICENSE](https://github.com/wowarenalogs/wowarenalogs) | `CC BY-NC-ND 4.0`, worded as covering "WoW Arena Logs and **all other code** in this repository"                                                | Covers **code only**, not the uploaded log data.                               |

**There is no Terms of Service.** `tos.html` returns 404 and the repository
contains no terms file — only `packages/web/public/privacy.html`. So there is no
contractual prohibition on automated access, and equally no express permission.
Our restraint is a choice, not a compliance obligation.

## 2. Interfaces we use, and the one we refuse

**Used — the public GraphQL feed.** `POST https://wowarenalogs.com/api/graphql`,
anonymous, `latestMatches(...)` with server-side `bracket` / `minRating` /
`compQueryString` filters, page size capped at 50. Then a plain GET of the
returned `logObjectUrl`. This is the interface their own web client uses.

**Refused — bucket enumeration.** The GCS bucket `wowarenalogs-log-files-prod`
grants `storage.objects.list` to `allUsers`, so
`GET https://storage.googleapis.com/wowarenalogs-log-files-prod?max-keys=1`
returns a full object listing to anyone, unbounded by the feed's ~7-day retention
window. Their web client never needs to list the bucket, so this is almost
certainly a misconfiguration rather than an offered interface.

**We do not use it.** Publicly reachable is not the same as intended to be
public, and taking data outside the surface a project actually publishes is not
something we want to rely on. Decision of 2026-08-01: do not use it, and do not
report it either. Recorded here so the option is not rediscovered and quietly
taken later.

## 3. Collection discipline (`packages/corpus-tools`)

- **Identifying User-Agent** on every outbound request — feed and GCS alike,
  attached at the single choke point `fetchWithRetry` in
  `src/feedClient.ts`. Without it we are indistinguishable from any other
  scraper in their logs, and the only remedy available to them is a blanket
  IP ban that also hits other people.
- **Separate throttles per cost centre.** Paging costs them Firestore reads;
  a log download costs GCS egress and a single Solo Shuffle log can reach ~30 MB.
  Page interval 500 ms, download interval 2 s (`DOWNLOAD_SLEEP_MS`), serial,
  never concurrent. The download counter counts _attempts_, not successes — a
  discarded incomplete download still consumed their bandwidth.
- **Bounded paging** (`MAX_PAGES`, default 40) and resume-by-manifest so a
  re-run never re-downloads what we already have.
- **Retry only on 429/5xx/network**, exponential backoff capped at 15 s.

The feed only retains about 7 days (GCS objects about 30). Accumulating a corpus
therefore means low-frequency polling over time, not a burst. If that ever
becomes a standing scheduled job, revisit this section.

## 4. Personal data in the logs

Combat logs contain character names, realms, and `Player-realmID-hexID` GUIDs.
A GUID is stable across a player's characters, which makes this pseudonymous
personal data under GDPR, not anonymous data. The uploader consented to
publication (§1); the other players in the match did not, beyond what the game
itself broadcasts to participants.

Current policy (decision of 2026-08-01): **store as-is, no pseudonymisation.**
Rationale: the parser needs GUIDs to relate units, and the data is already
public. This is a deliberate choice, not an oversight.

What we deliberately do **not** collect: the GCS object metadata header
`x-goog-meta-ownerid`, which carries the uploader's account id. `downloadWithMeta`
takes only `wow-version`, `client-timezone`, `client-year`, and `starttime-utc` —
the fields needed to reconstruct absolute time, since log timestamps carry no
year and are in the uploader's local timezone.

Downloaded logs and `manifest.json` live outside the repo by default
(`$GLADLOG_EVAL_HOME`) and must never be committed to the public repository.

## 5. Code licensing — the part that actually mattered

gladlog is MIT. wowarenalogs' code is **CC BY-NC-ND 4.0**, which forbids
commercial use _and_ derivative works. These are incompatible: MIT
redistribution cannot be layered on top of an ND licence, and attribution alone
does not cure it.

`packages/parser-compat/src/enums.ts` was, until 2026-08-01, transcribed line for
line from their `packages/parser/src/types.ts` — including their code style and
their misspelling of Blizzard's "Brewmaster" as `Monk_BrewMaster`.

**Fix:** `CombatUnitSpec` and `CombatUnitClass` are now generated from Blizzard's
own DB2 tables (`ChrSpecialization`, `ChrClasses`) by
`packages/analysis/scripts/datagen/genCombatUnitEnums.ts`, with a naming rule
this repo defines and documents. The remaining enums are each anchored to a
Blizzard fact: `LogEvent` values are the literal event tokens in the log format,
`CombatUnitPowerType` mirrors the client API's `Enum.PowerType`, and the flag
masks are the published `COMBATLOG_OBJECT_*` constants.

An honest note on what this did and did not change. Line-for-line overlap with
their file did **not** drop — normalised for quote style it went 108 → 115 lines,
because 51 `LogEvent` lines and 39 `SpecName = "blizzardId"` lines are the same
facts any correct implementation must express. The argument is independent
derivation and merger, not textual difference. What did change is the part that
was **not** factual:

- `CombatUnitClass`: 13/13 values replaced. Their numbering was invented
  (`Hunter = 2`), and we carried a `BLIZZARD_CLASS_TO_LEGACY` translation table
  just to speak it. Now the values _are_ Blizzard's `ChrClasses.ID`
  (`Hunter = 3`) and the translation table is deleted.
- Member ordering: 41/41 positions matched theirs, now 1/41.
- Provenance: values regenerate from DB2 on each game build, so there is no
  manual transcription path from their repository any more.

`packages/parser-compat/data/legacy-enum-manifest.json` is kept and is _not_ a
problem: it was dumped from the old package at runtime (the M4 plan explicitly
forbade reading their source) and records observed interop facts. Copying
interface facts for interoperability is the favoured case, not the disfavoured
one. The differential oracle does not compare `class` (its `NormUnit` takes
`spec`/`reaction`/`type`), so the renumbering does not touch that gate.

## 6. Blizzard's assets, and their CDN

Combat logs are client-generated text that players opt into and upload
themselves; Warcraft Logs has operated this way for over a decade. The exposure
sits in **art assets**, not log data.

Until 2026-08-01 the shipping app hot-linked `images.wowarenalogs.com` at runtime
for spec icons and arena minimaps — spending a volunteer project's bandwidth on
every install, for Blizzard art they re-host.

- **Spec icons: fixed.** `specIconName()` now resolves Blizzard's
  `ChrSpecialization.SpellIconFileID` to an icon base name
  (`genSpecIcons.ts`, 40/40 resolved) and rendering goes through the existing
  main-process `iconCache` — the same path spell icons already used, with a
  permanent disk cache and a per-session fetch budget.
- **Arena minimaps: fixed, by reversing an earlier decision.** The 15 backgrounds
  now ship with the app (`src/renderer/src/report/data/minimaps/`, resolved by
  `import.meta.glob` so a missing file fails the build rather than 404-ing at
  runtime). `arenaMaps.ts` had previously kept them out of the repo citing
  "copyright + size"; that was reconsidered on 2026-08-01. Size turned out to be
  164 KB total, and on copyright the art is Blizzard's either way — bundling and
  hot-linking do not differ on that point, while hot-linking additionally spends
  a volunteer project's bandwidth. This is a deliberate reversal, recorded here
  so it does not look like an oversight.

The app now makes **no runtime requests to `images.wowarenalogs.com` at all**.
The visual-regression harness asserts this: `qa/support/stubExternal.ts` no longer
allows any external host, so a new CDN dependency fails the test by name instead
of leaving a flaky baseline. Icon fetching happens in the main process, which
Playwright's `page.route` cannot intercept, so `iconCache` takes an `offline`
flag set from `GLADLOG_E2E=1`.

## Open items

- **Scheduled polling** (BACKLOG #19). Decision of 2026-08-01 is to proceed
  without contacting the maintainers, keeping frequency low. If the cadence ever
  rises materially, revisit §1 and §3.
- **Bundled Blizzard art.** Spec icons are still fetched from Wowhead's CDN
  (`wow.zamimg.com`) at runtime and the minimaps now ship in the installer.
  Neither is licensed to us; both rest on Blizzard's general tolerance of fan
  tools. If Blizzard's fan content policy is ever tested, this is the exposure.
