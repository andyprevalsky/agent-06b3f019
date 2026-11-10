---
id: 2026-11-10-approved-phone-guide-left-dependent-golden-stale
date: 2026-11-10
title: Approved phone guide changed without its dependent strict golden hash
surface: harness
component: rose-browser-use-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: test_phone_setup_settings_actual_handler_observation retained the prior PHONE_GUIDANCE SHA
symptoms:
  - Ordinary enabled guide must match the saved-credential binding contract
  - rose-browser-use FAIL (121 passed, 1 failed)
tags:
  - phone
  - golden-fixture
  - approved-prompt
sources:
  - PR #1912
  - commit 2d0a00cb52caccb8e090ff4e1f3597769f3b7986
  - task f7b6c44dea194ddf86fe6bd734c7f208
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_phone_setup_settings_actual_handler_observation
status: open
---

## Problem

The independently GROUNDED PHONE-EVIDENCE-WINDOW-02 guide changed the exact
PHONE_GUIDANCE bytes. Its dependent rose-browser-use fixture still pins the old
SHA. The original round12 gate reported the domain at121PASS/1FAIL. Its published
native log lines979-986 confirm test_phone_setup_settings_actual_handler_observation
failing at line3523 on the strict old hash. A separately authorized unchanged
mocked owning-method invocation reproduces that same assertion locally.

## Diagnosis

Archive searches were `stale.*golden|golden.*stale|prompt.*hash|hash.*prompt`
and `dependent.*(fixture|consumer)|approved.*snapshot|fixture.*synchron`.
Read the phone-window case, native-AutoFill transcript case and phone rollout
isolation case, plus process-feedback. This is a new dependent-fixture boundary,
not recurrence of invalid physical evidence or swallowed409 feedback. The code
under test now has the approved behavior; its strict expected snapshot is stale.

Baseline main5234 PHONE_GUIDANCE has SHA
`db9ef5717b85df6eb494d6e6e5672cc04f1ba9a638c3800085a76746102197ac`, exactly
the old assertion. Approved current guidance has SHA
`46fe023ec67942b75ad363f5212f9b23cc479b7250e82838f010f0f0e3c16c79`.
The independent final review hash is
`e0283c920cd3bd57ea7ae6d7e211958fdc110cbf3888ba6ea934d32032045430` and
approved prompt diff hash is
`2beed968df551bee3d1f31b89e59b3549dd8e443d345ede6bf81397f4ceae7f5`.
The canonical phone source remains
`43ce7c83f6ea1d0a5098c1e3654bbdde50c57ac6f0c8080065c72e630e481d9e`.

The exact mocked method locally failed at line3523 with the strict hash message.
Only the expected SHA literal changed in the ignored candidate; the same command
then passed and passed five further unchanged invocations. All seven supervisor
receipts are quiescent with no orphans, signals or remaining children. The full
domain was not rerun locally: its registered real-model AutoFill controls are
funded calls, outside this local authorization.

## Solution

Synchronize only the expected golden SHA to the independently approved bytes.
Keep equality strict and every other runtime, privacy, negative and persistence
assertion unchanged. Reverting approved behavior or replacing strict comparison
with dynamic self-trust would undermine the test. No new prompt content, runtime
fallback, timing change or coverage reduction is required. The simple dependent
constant update is the smallest coherent repair. The one-line fixture update is implemented; canonical validation and full new-source gates remain required before release.

## Human feedback

None recorded specifically for this fixture incident. The parent and reviewer
instructions were agent coordination, not human feedback. The original native
log now confirms the strict assertion and matches the separate local replay.

## Reusable lesson

When approved prompt bytes change, find every strict snapshot consumer and
update it to that reviewed identity; retain the assertion rather than making it
accept its own current output.
