---
id: 2026-07-04-app-update-yml-missing-from-mac-bundle
date: 2026-07-04
title: Two-step electron-builder release never emitted `app-update.yml`, so every auto-update download failed
surface: mac-app
component: mac-app-autoupdate
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "the `electron-builder --mac dir` + `--prepackaged` release build never wrote `Contents/Resources/app-update.yml` into the .app bundle"
symptoms:
  - bare Update failed message in the mac app with nothing in the renderer console or network tab
  - "ENOENT: no such file or directory, open '/Applications/Rose.app/Contents/Resources/app-update.yml'"
  - update checks succeed but every download dies instantly
tags:
  - mac-app
  - electron-updater
  - auto-update
  - packaging
  - codesign
sources:
  - PR #710
  - memory:project_macapp_update_failed_differential_cache
repro: none-recorded
status: fixed
---

## Problem

Every shipped mac-app build could check for updates but no build could download
one. Users saw a bare "Update failed" with nothing in the renderer console or
network tab, because the failure lived in the main process. Relaunching the
packaged app from Terminal captured the real error:

```
Downloading update from .../Rose-mac.zip, .../Rose-mac.dmg
Error: ENOENT: no such file or directory, open '/Applications/Rose.app/Contents/Resources/app-update.yml'
```

The file was confirmed absent from both 1.1.79 and 1.1.80. The feed itself was
healthy: the 1.1.80 zip sha512 matched `latest-mac.yml`, `codesign --deep --strict`
was valid, and Gatekeeper reported `Notarized Developer ID`.

## Diagnosis

`electron-updater`'s `downloadUpdate()` resolves the update feed by reading
`Contents/Resources/app-update.yml` from the app bundle. Our release used a
two-step `electron-builder --mac dir` followed by `--prepackaged`, a path that
never emits that file. Update _checks_ still worked because our own code calls
`setFeedURL` in memory — so the in-memory feed masked the missing on-disk feed and
the defect only appeared at download time. Nothing in the pipeline asserted the
file existed, and because the error was thrown in the main process (which has no
log file) it surfaced to users with no diagnosable output at all.

## Solution

New `scripts/write-app-update-yml.mjs` generates `app-update.yml` from
`package.json` `build.publish`, keeping one source of truth for the feed. The
release workflow writes it into the built `.app` **before final codesign**, so it
is sealed inside the signature. Release safeguards now fail the build if the
metadata is missing from either the `.app` or the shipped archive. Hardening:
`disableDifferentialDownload = true` in `repo.ts` — a stale cached zip was found
locally and differential reconstruction from a stale base would sha512-mismatch
once downloads worked again, so full downloads re-verify end to end. Because
already-installed builds and 1.1.80 on the feed all lack the file, users had to
install the first fixed DMG manually once; auto-update works from there.

## Human feedback

None recorded.

## Reusable lesson

When an update _check_ succeeds but every _download_ fails, suspect packaging
metadata that the library reads from disk while our code supplies the same value in
memory — and assert the file's presence in the release pipeline before the signing
step that seals it.
