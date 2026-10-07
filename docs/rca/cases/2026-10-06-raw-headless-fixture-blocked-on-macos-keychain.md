---
id: 2026-10-06-raw-headless-fixture-blocked-on-macos-keychain
date: 2026-10-06
title: Raw headless write-lock fixture blocked on macOS keychain before local navigation
surface: harness
component: write-lock-misfire-browser-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: write_lock_misfire.blackbox.py _Browser.start launches an ephemeral headless Chrome without mock keychain; _Browser.open waits for Page.navigate before any corpus request reaches the local server
symptoms:
  - TIMEOUT domain write-lock-misfire exceeded 300s
  - Page.setLifecycleEventsEnabled and Page.enable CDP requests timed out
  - Page.navigate waits while the local fixture server receives zero browser requests
  - SecItemCopyMatching and SecKeychainItemCopyContent appear in the native browser call graph
tags:
  - chromium
  - macos
  - keychain
  - navigation
  - blackbox-fixture
sources:
  - PR #1420
  - plan:.context/write-lock-misfire-rca-20261006
repro: agents/tests/blackbox/write_lock_misfire.blackbox.py through agents/scripts/run-coverage.sh
status: fixed
---

## Problem

Normal agents coverage completed 107/109 domains; write-lock-misfire hit its
unchanged 300-second ceiling. Running the unchanged domain alone through
`coverage run --parallel-mode scripts/run_blackbox_tests.py write-lock-misfire`
also exited 124 after 300 seconds with no completed corpus checks. Host
concurrency therefore does not explain the failure.

## Diagnosis

Passive asyncio tracing placed the await in `_Browser.open` -> `Page.goto` ->
`Page.navigate`, before DOM state or the write-lock classifier. Raw CDP on the
same pinned Chrome and first fixture also timed out at 60 seconds. Disabling
GPU did not change that result. On the same raw session, blank and data-document
navigation completed, while loopback navigation hung; an independent HTTP
preflight returned 200, but the server saw zero browser requests.

A native sample of that stalled browser contained `SecItemCopyMatching`,
`SecItemCopyMatching_osx`, and `SecKeychainItemCopyContent` in its call graph,
excluding loaded-image metadata. The raw launcher omitted Playwright's standard
`--use-mock-keychain` flag. Adding only that flag to an ephemeral test profile
completed the same fixture navigation in 0.013 seconds. The actual unchanged
owning domain then passed in 10.28 seconds under the original 300-second ceiling.
This proves the owned startup configuration boundary, without attributing a
particular keychain policy or changing the system keychain.

Archive searches covered literal CDP timeouts and navigation symptoms, then
`SecItemCopyMatching mock keychain Page.navigate` and `headless fresh profile
keychain navigation`. Browser-state and dependency-floor cases are relatives;
none records this pre-dispatch native keychain boundary.

Private evidence remains under `.context/write-lock-misfire-rca-20261006/`:
`unchanged-coverage-domain`, `passive-async-observer`, raw CDP inverses,
`passive-chrome-network-sample`, and `fixed-current-domain`. Original RED
receipts and native samples are preserved.

## Solution

Add only `--use-mock-keychain` to this test's ephemeral Chromium launch. Keep
all corpus cases, classifier code, action contracts, and assertions unchanged.
The normal agents coverage runner continues to discover this owning domain;
full coverage remains a separate required gate. No production browser launch,
user profile, real keychain, proxy alias, Freedom setting, or timing bound changes.

## Human feedback

None recorded for this incident. Standing user instructions preserve Freedom
and its protected instructions throughout the investigation.

## Reusable lesson

Match the automation startup contract for ephemeral headless profiles and prove the blocked browser boundary before changing classifier logic or timeouts.
