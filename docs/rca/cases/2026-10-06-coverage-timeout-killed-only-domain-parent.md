---
id: 2026-10-06-coverage-timeout-killed-only-domain-parent
date: 2026-10-06
title: Coverage timeout killed its domain interpreter and left owned browser descendants alive
surface: harness
component: run-coverage-blackbox-parallel
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_coverage_blackbox_parallel.py run_domain calls process.kill on timeout, leaving descendants outside interpreter finally cleanup
symptoms:
  - write-lock-misfire exits 124 after 300 seconds but its test-profile Chrome family remains parented to PID 1
  - timed-out domain left its exact descendant running
  - cancelled domain left its exact descendant running
  - CLI SIGTERM exits -15 while its exact descendant TCP listener remains alive
tags:
  - coverage
  - subprocess
  - process-group
  - cancellation
  - orphan
sources:
  - PR #1420
  - plan:.context/write-lock-misfire-rca-20261006
repro: agents/tests/unit/test_coverage_blackbox_parallel.py actual timeout and cancellation descendant-listener owners
status: fixed
---

## Problem

The 300-second coverage timeout killed only the Python domain interpreter, so
its browser-finally cleanup never ran. Exact profile, process birth, and command
identity linked an eight-process Chrome family to the original failing domain.
An unchanged isolated domain reproduced the timeout and left descendants alive.
Only those captured test-owned handles were retired; user browsers were untouched.

## Diagnosis

The old timeout unit mocked process.kill and could not observe descendants.
Replacing it with an actual parent that owns a child TCP listener reproduced
an alive descendant after timeout: RED 10.29 seconds, then unchanged GREEN
5.22 seconds after group cleanup. Both fixture readiness and retirement allow
five seconds; the production domain ceiling stays 300 seconds.

Isolating each domain in a new session also requires cancellation ownership.
The same actual listener control reproduced a direct Task.cancel leak, then
passed unchanged after group retirement and communicate-before-reraise. Review
identified the top-level CLI SIGTERM/SIGHUP path: default signal exit bypassed
task cancellation. Actual main -> async_main, narrowed only to one fixture
domain, exited -15 on SIGTERM while its exact child listener remained alive.
The permanent SIGTERM/SIGHUP owner failed unchanged against captured pre-fix
runner bytes, then passed against the repair. All five final owners also passed
on actual tracked source in 6.21 seconds; proper signal exits are 143 and 129.

Archive searches covered coverage timeout, cancellation, orphan, process group,
and browser cleanup. The September 11 subshell/listener ownership case and
October 5 publisher-drain case are relatives at different launchers, not repeats.
Original timeout, cancellation RED/GREEN receipts, exact cleanup identities, and
captured pre-fix runner bytes remain private under
`.context/write-lock-misfire-rca-20261006/`.

## Solution

Each domain acquires a new session; timeout and cancellation retire that owned
group and await communicate. Cancellation is reraised. The CLI registers TERM
and HUP before domains launch, cancels its owned async_main task, and reports
the signal-derived exit only after async_main cancels and awaits every domain.
Repeated stop signals leave that first drain intact. The permanent unit owners
use actual parent/child processes and prove the child listener closes. They are
discovered by the normal coverage unit lane. No global process sweep, proxy
change, Freedom change, or timeout relaxation is part of the repair.

Full normal coverage completed before the final CLI-only repair: 109/109
domains, 178 fast-cache tests, 129 units, 82% coverage, wrapper exit 0. This proof
remains bound to its executed runner hash; it is not relabeled as the final
wrapper. Measured production coverage inputs and normal run_domain code are
unchanged, while the final stop paths have their own actual five-owner proof.

## Human feedback

None recorded for this incident. Standing user instructions require preserving
Freedom and unrelated processes.

## Reusable lesson

A subprocess owner must retire and drain its entire newly owned process group on both deadlines and every supported stop path.
