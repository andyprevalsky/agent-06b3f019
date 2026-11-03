---
id: 2026-10-19-interrupt-during-owned-archive-wait-lost-run-record
date: 2026-10-19
title: Interrupt during the owned-batch archive wait discarded the evaluated run record and skipped exact cleanup
surface: harness
component: benchmark-owned-cloud-finalize
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py main_async owned-batch tail caught only Exception around _finalize_owned_cloud_batch, so a CancelledError from the diagnostic archive wait skipped run.save(), the remaining roots' exact cleanup and the interrupt-cleanup completion
symptoms:
  - "no fresh matching benchmark run produced"
  - "Benchmark interrupt cleanup status: state=failed started=1 completed=0"
  - "FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup acknowledgement"
  - "Polar benchmark made no semantic progress for 300s"
  - "Timed out waiting for browser terminal messages after pause; archiving latest snapshot anyway"
tags:
  - cloudbench
  - polar
  - interrupt
  - run-record
  - archive-deadline
  - teardown
sources:
  - fleet run 20261019-201626-26147
  - fleet run 20261019-201740-25270
  - fleet run 20261019-201626-26089
  - task polar-odysseys-a24232e8f6e7
  - agent e31ee1ae-3a39-4ab2-8508-eb691a51efc6
  - commit 6d3b7c4daf4737c90d1671bc4555f3869bf2b5f9
repro: agents/benchmarks/cloud_batch_cleanup_test.py
status: fixed
---

## Problem

A 70-task Polar fresh-agent cloud run (`--timeout 300`) left three jobs UNKNOWN
and their guests retained. On guest `8ed954ef9d2138`
(`polar-odysseys-a24232e8f6e7`) the agent hit its genuine 300 s backstop, the
FAIL outcome was evaluated and Hub-acknowledged at about 20:30:53, and then
`_finalize_owned_cloud_batch` sat in `_refresh_browser_archive_snapshot` until
the controller's Polar semantic watchdog (300 s) requested guest shutdown at
20:34:38. The SIGINT cancelled the archive wait; `Verified cloud root provider
cleanup` still printed, yet the runner reported `state=failed started=1
completed=0`, emitted `no fresh matching benchmark run produced`, and the guest
refused its cleanup acknowledgement. `e82037df15e468` repeated the same chain.

## Diagnosis

Backend logs show the finalize loop issuing `GET /api/agents/tree` plus
`GET /api/agents/<root>` every ~3.5 s from 20:30:59 to 20:34:34, all fast
(2–640 ms). It was waiting for browser readiness that never arrived: two of the
six browser tasks (`fd2f63ab…`, `54182eba…`) kept polling
`/captcha-telemetry` until 20:33:33 and 20:37:40 and only then logged
`Browser agent activity cancelled (paused)`, 4–8 minutes after the 20:29:24
pause. The archive bound (`60 + 30 * browser_sessions`, here 300 s) outlasted
the watchdog. Normal jobs in the same run finalized in 18–69 s; every slow job
(117–250 s) also logged the in-run browser-terminal timeout.

The harness defect: `main_async` wrapped the finalizer in `except Exception`.
The interrupt's `CancelledError` bypassed it, so `run.save()` never ran even
though the outcome was final. Inside the finalizer the cancellation also
escaped the per-root loop after the first root's `finally`, so later roots
would not be released, and `_complete_interrupt_cleanup()` was skipped even
when exact provider and payment cleanup had been verified, producing a false
`state=failed` receipt and a retained guest.

Searches: `no fresh matching benchmark run produced KeyboardInterrupt run.save
interrupt cleanup state=failed`, `semantic-inactivity watchdog polar
post-outcome finalize archive refresh killed`, `refusing guest cleanup
acknowledgement retained guest`, `owned cloud batch finalize archive refresh
timeout browser recordings session-scaled`. Relative of
`2026-10-07-archive-deadline-spent-in-readiness-raised-runtime-error` (same
archive wait) and of the open
`2026-09-29-runner-receipt-accepted-before-stack-cleanup` (guest
`820120f7764438` saved its run but hit `stack worker cleanup was not
confirmed`). Novel for the run-record loss.

## Solution

The owned-batch tail is now `_finalize_owned_batch_and_save_run`. The
finalizer treats a cancellation as an archive warning (`archive: interrupted
during archive refresh`), skips archive waits for the remaining roots, still
carries every owned root through exact pause, delete, provider and payment
cleanup, and then re-raises the same cancellation tagged with
`owned_batch_cleanup_verified`. The caller catches `BaseException`, completes
the interrupt-cleanup receipt only when that flag is true, saves the run
record, and re-raises. Unverified provider release stays fail-closed
(`state=failed`, task `ERROR`). Evaluated verdicts are unchanged. No timeout,
watchdog bound, task or evaluator changed.

Regression: `test_interrupt_during_archive_wait_keeps_run_record_and_exact_cleanup`
in `agents/benchmarks/cloud_batch_cleanup_test.py` cancels the real helper
mid-archive-wait for two roots. On the unfixed code it failed with
`interrupted finalization skipped run.save()` and printed the production
`state=failed started=1 completed=0`; it passes after the fix. It is registered
by the agents `benchmark` blackbox domain (`cloud_cleanup_*`).
Per root the change adds no requests; at 10k agents it is unchanged.

Open, separate causes: browser activities blocked in the CAPTCHA telemetry
path ignored pause for 4–8 minutes, and the controller watchdog's semantic
signature ignores bounded post-outcome finalization phases.

## Human feedback

None recorded.

## Reusable lesson

Once an outcome is evaluated, persist it before any optional wait that an interrupt can cancel, and treat cancellation of diagnostic work like any other diagnostic failure: finish exact cleanup, then re-raise.
