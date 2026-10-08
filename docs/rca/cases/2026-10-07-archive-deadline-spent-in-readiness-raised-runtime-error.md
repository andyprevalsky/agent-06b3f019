---
id: 2026-10-07-archive-deadline-spent-in-readiness-raised-runtime-error
date: 2026-10-07
title: Browser archive refresh reported an exhausted deadline as RuntimeError when it expired during readiness evaluation
surface: harness
component: benchmark-browser-archive-refresh
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _refresh_browser_archive_snapshot post-readiness deadline check
symptoms:
  - "cloud_cleanup_archive_does_not_accept_terminal_without_recording: browser evidence did not become terminal with attached recordings before archive"
  - "RuntimeError: browser evidence did not become terminal with attached recordings before archive"
  - agents benchmark blackbox domain failed only under parallel coverage load
tags:
  - archive-deadline
  - exception-contract
  - load-dependent-flake
  - browser-recording
sources:
  - PR #1417
  - commit 445fcc699
repro: agents/benchmarks/cloud_batch_cleanup_test.py
status: fixed
---

## Problem

After PR #1417 merged `main` at `996266553`, the agents coverage gate failed
one case in the `benchmark` domain:
`cloud_cleanup_archive_does_not_accept_terminal_without_recording` expected
`TimeoutError` from `_refresh_browser_archive_snapshot` with a 10 ms budget and
a browser activity that has no recording, but received
`RuntimeError: browser evidence did not become terminal with attached recordings before archive`.
The same suite passes when run on its own.

## Diagnosis

`_refresh_browser_archive_snapshot` checks its deadline twice per poll. After
the tree snapshots arrive it raises `TimeoutError`; after the readiness
evaluation it raised `RuntimeError` for the same exhausted deadline. Commit
`445fcc699` added preparation-receipt parsing (and its module import) between
those checks. Under the coverage run's parallel load that work took longer
than the remaining budget, so the deadline was first observed at the second
check and the condition surfaced with a different exception type. A
deterministic repro, `test_archive_deadline_spent_during_readiness_is_a_timeout`,
makes the receipt parse outlast a 0.5 s budget and fails with that
`RuntimeError` on the unfixed code.

## Solution

Both deadline exits now raise `TimeoutError`; the post-readiness exit keeps its
descriptive message. Callers catch every exception and record its message as
an archive warning, so warning text and cleanup behavior are unchanged. The
repro is a `test_*` function in `cloud_batch_cleanup_test.py`, which the
agents `benchmark` blackbox domain registers automatically, so it runs in the
`/deploy` coverage gate. The change is per-root and adds no work at any agent
count.

## Human feedback

None recorded.

## Reusable lesson

When a loop has several deadline checks, every check that observes the same exhausted budget must report the same error type, regardless of which work consumed it.
