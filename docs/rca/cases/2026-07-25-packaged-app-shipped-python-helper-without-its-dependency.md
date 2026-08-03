---
id: 2026-07-25-packaged-app-shipped-python-helper-without-its-dependency
date: 2026-07-25
title: The packaged mac-app shipped a Python IndexedDB helper without `ccl_chromium_reader`, making the read a silent no-op while forcing a 15-minute CLT install
surface: mac-app
component: indexed-db-reader
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: packaged app extraResources — only the bare read_indexeddb.py shipped; ccl_chromium_reader was never bundled or pip-installed
symptoms:
  - mac-app onboarding stalls on a ~15-minute macOS Command Line Tools install
  - "/usr/bin/python3 stub launches the CLT installer GUI when no toolchain is present"
  - IndexedDB reading returns nothing in the packaged app while appearing wired up
tags:
  - mac-app
  - indexeddb
  - packaging
  - python
  - silent-failure
sources:
  - PR #895
  - commit fd86243dd
  - memory:project_macapp_native_indexeddb_reader
repro: none-recorded
status: fixed
---

## Problem

mac-app onboarding forced users through a ~15-minute macOS Command Line Tools
install. The trigger was `spawn('python3', scripts/read_indexeddb.py)`: on a machine
with no toolchain, Apple's `/usr/bin/python3` is a **stub** that launches the CLT
installer GUI.

## Diagnosis

The onboarding stall was the visible symptom; the non-obvious finding underneath was
worse. The Python helper requires `ccl_chromium_reader`, and that dependency was
**never bundled or pip-installed in the packaged app** — only the bare `.py` file
shipped. So IndexedDB reading had been a **silent no-op in production all along**.

That reframes the whole feature: the Python dependency bought nothing except the
onboarding stall. The failure was invisible because a missing-import failure in a
spawned helper produced no user-visible error, only empty results, so the feature
looked wired up while doing nothing.

The generalizable cause is packaging: a runtime dependency of a shipped helper was not
part of the packaging contract, and nothing asserted that it was present.

## Solution

Replaced the entire Python path with a **pure-TypeScript native reader** under
`mac-app/main/domains/indexed-db-reader/native/`:

- `leveldb.ts` + `snappy.ts` — LevelDB physical format (.log + .ldb SSTable + pure-JS snappy)
- `v8-deserializer.ts` + `v8-reader-base.ts` + `blink-deserializer.ts` — V8/Blink structured-clone decode
- `idb-coding.ts` (keys/varints/envelope), `indexeddb.ts` (metadata + record iteration +
  blob resolution), `serialize.ts` (JSON shaping), `discovery.ts` (profile/folder location)

`repo.ts` now exposes only `resolveHomeDir`, `config.ts` was trimmed, and
`read_indexeddb.py` plus its bundling and the config blackbox were deleted. The class of
defect is now guarded: an electron-compiled-startup test asserts **no `.py` in
extraResources**, so a helper whose dependencies aren't packaged cannot ship again.

Validated as a faithful 1:1 port of `ccl_chromium_reader`, **byte-for-byte against ccl
across 10 real Chrome origins** (order.online, notion, reddit, linkedin, muay, cosmos,
gmail, cal, docs, drive — covering Maps/Sets/typed arrays/bigint/Date/BlobIndex/external
blobs). Every apparent diff was a Python↔JS harness artifact (JSON whitespace,
`ensure_ascii` unicode escaping, int-vs-float formatting, `JSON.stringify` numeric-key
reordering, Map/Set/dict representation) or ccl being _less_ robust — it crashes with
"Can't resolve blob if blob dir is not set" / FileNotFoundError on stale external-blob
records, where the native reader skips them. Record policy matches ccl's tolerant
handler: undecodable or missing-blob records are skipped, not emitted as null
placeholders. Gates: 1149 mac-app tests pass, tsc/eslint/prettier clean, coverage
branches 85.11%.

## Human feedback

None recorded.

## Reusable lesson

If a shipped helper's runtime dependency isn't in the packaging manifest, the feature is
silently dead in production — assert the packaged surface, and prefer an in-process
implementation over spawning an interpreter you don't ship.
