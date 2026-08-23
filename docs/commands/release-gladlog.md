# /release-gladlog — cut a gladlog desktop release

**The authoritative flow lives in [`.claude/skills/release/SKILL.md`](../../.claude/skills/release/SKILL.md). Read it and follow it.**
This page is not a second copy of the procedure — it holds only the two things
the skill does not carry (the release-notes install footer and the failure
playbook) plus the pointers below. When they disagree, the skill wins.

Why this page is a pointer and not a runbook: it used to duplicate the flow, and
the duplicate went stale in three places that each cost a user something —
it prescribed the retired three-command pre-flight (missing `verify:vision` and
the production build), never mentioned `latest.yml`, and never mentioned the
prohibition on reusing a version. Argument: the target version, e.g. `0.1.28`
(no `v`); omitted means bump the patch.

## What the skill covers, so it is not re-derived here

- Pre-flight is `npm run presubmit` from the repo root plus a **green test.yml
  run selected by headSha** — not a hand-typed subset.
- Version policy: **+1 always**; overwriting `vN` is only ever done when the
  user says "overwrite N" *and* has been told the consequence (every machine
  already on `vN` compares version numbers, matches, and never receives the fix).
- The CHANGELOG section format, and syncing it onto the GitHub Release.
- Asset acceptance: the **7 required assets**, and the character-exact
  `latest.yml` ↔ asset-name cross-check. `latest.yml` is the auto-update
  lifeline — if it is missing or its `path`/`url` disagree with the real asset
  names by one character, every Windows client fails its update check silently
  while the Release page looks perfectly normal.
- Watching the build: a `gh run watch --exit-status` that exits 0 is **not**
  proof of green — re-read the run's own conclusion line and confirm the run id
  matches the headSha you pushed (a watcher exit was misreported as green on
  2026-08-11). If the tag push does not deliver a run at all, fall back to
  `gh workflow run build.yml --ref <tag>`; never re-push the tag.

## Release-notes install footer (append under the changelog body)

The changelog body itself comes from `CHANGELOG.md` per the skill. Always append
this footer — the builds are unsigned on both platforms:

```
## Windows (x64)
- `gladlog.Setup.X.Y.Z.exe` — installer. SmartScreen → **More info → Run anyway**.

## macOS (Apple Silicon)
Not notarized. On first open drag **gladlog.app** to /Applications, then **right-click → Open** (or run `xattr -cr /Applications/gladlog.app`).
```

The macOS `afterSign` hook applies a clean ad-hoc signature, so a download needs
only `xattr -cr` — no re-sign, no "damaged" dialog.

## Report back with login-free links

- Windows: `https://github.com/mingjianliu/gladlog/releases/download/vX.Y.Z/gladlog.Setup.X.Y.Z.exe`
- macOS: `https://github.com/mingjianliu/gladlog/releases/download/vX.Y.Z/gladlog-X.Y.Z-arm64.dmg`
- Release page: `https://github.com/mingjianliu/gladlog/releases/tag/vX.Y.Z`

## If it goes wrong

- **Wrong version in the filenames** → the bump was skipped. The installers are
  named from `packages/desktop/package.json`, so a stale version ships
  `0.0.1-*` files inside a `vX.Y.Z` release. Bump, then
  `gh release delete vX.Y.Z --yes --cleanup-tag` and re-tag.
- **electron-builder "version is a range"** → `build.electronVersion` must be
  pinned to the installed electron
  (`node -e "console.log(require('./node_modules/electron/package.json').version)"`).
- **macOS "damaged" persists** → the `afterSign` hook regressed; check
  `packages/desktop/build/afterSign.cjs` exists and `build.afterSign` points at
  it. Per-machine workaround: `xattr -cr <app> && codesign --force --deep --sign - <app>`.
- **Only mac assets present** → the macOS job finishes first; Windows is still
  compiling. Not a failure until the run concludes.
- The only "just works, no warnings" fix on either OS is a paid signing
  certificate (macOS notarization / Windows code-signing); wire the secrets into
  the CI workflow when they exist.
