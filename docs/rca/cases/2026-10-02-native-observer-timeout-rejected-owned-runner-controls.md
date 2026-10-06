---
id: 2026-10-02-native-observer-timeout-rejected-owned-runner-controls
date: 2026-10-02
title: Native process observation timed out inside the runner ownership gate
surface: harness
component: benchmark-native-process-observer
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the owning benchmark subprocess gate gave each whole-host ps snapshot only two seconds
symptoms:
  - "ps -axo pid=,ppid=,pgid=,stat= timed out after two seconds"
  - terminal-evidence controls failed inside their unchanged sixty-second gate
tags:
  - benchmark
  - native-observation
  - cleanup
  - timeout
sources:
  - PR #1299
  - commit 63ac9a3a1b05259f98229be1c739ebe2e6b74ba0
repro: agents/tests/blackbox/benchmark.blackbox.py::test_benchmark_native_checks_overlap_judges_without_losing_ownership
status: fixed
---

## Problem

The final-source agents gate passed 105 of 106 domains. The benchmark domain
failed its terminal-evidence controls; an isolated whole-domain replay instead
hit the authentication suite's sixty-second limit. Those original failures
remain preserved and are not aggregate passes. The authentication suite passed
all 56 cases in 20.148 seconds when observed separately; its historical delay
is not attributed to the process observer.

## Diagnosis

Two focused native replays reproduced the terminal-evidence failure. The second
recorded the actual failing command and stack: the two-second process-table
snapshot failed after 40.061 seconds of otherwise bounded controller work.
That was an inner observation failure, not expiration of the sixty-second
command-group deadline. Archive searches covered native snapshot timeouts and
benchmark/controller ownership. The September 30 scheduling case is related,
but its first bad boundary was an additive native queue. The host-level cause
of the delayed process query remains unknown.

## Solution

Each snapshot now has 2.4 seconds, the user-authorized twenty-percent
infrastructure allowance, and one bounded re-observation after a timeout.
A failed observation authorizes no signal and is never interpreted as absence.
The successful snapshot must still prove each unreaped leader's parent and
process group. A second timeout, malformed state, or other command failure
remains fatal. Existing descendant drain and child joining are unchanged.

The existing registered ownership control delays its first real observer by
2.6 seconds. A marker proves that observation was cancelled; the retry must
recover ownership, retire a TERM-resistant inherited descendant, and preserve
another child's real exit seven. Independent review caught and corrected an
initial 2.1-second fixture delay that did not deterministically force retry.
The identical final control failed the original observer in 5.526 seconds and
passed the repair in 5.962 seconds. The complete actual terminal-evidence group
passed in 40.648 seconds under its original sixty-second limit.

This adds no test file, verification stage, provider call, or model call. It
runs in the existing benchmark blackbox under canonical agents coverage and
normal deploy. The sixty-second group, three-hundred-second domain, normal
7,200-second execution backstop, temporary three-hundred-second execution
backstop, and independent 1,800-second allocation cutoff are unchanged.

Originals, intermediate failed controls, final paired receipts and independent
review remain private under `.context/acceptance/proof114-native-observer-rca/`.
Independent review SHA256 is
`2b409b9fef7ae4b3184c724381ed49d06a2a0b4d23d14f00f8cc537200453244`.
Full final-source gates and the hundred-task fleet proof are separate required
outcomes. This offline correction does not resolve the original live browser
injection timeout or backend OOM by itself.

## Human feedback

The user requested infrastructure breathing room, compact permanent tests,
parallel diagnosis, and the unchanged acceptance gate.

## Reusable lesson

Re-observe a bounded
read before declaring ownership unknowable; require positive native evidence
before mutations, and cement that recovery path in the existing owning suite.
