---
id: 2026-10-06-controller-positive-readiness-used-two-second-window
date: 2026-10-06
title: Positive controller startup used a two-second readiness override
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: the positive scenario 2b2 replaced ordinary proxy readiness with a two-second fixture window even though the acceptance requirement is a usable startup handoff
symptoms:
  - mandatory autoscaler attach budget must not run while its primary is intentionally stopped behind the boot-config barrier
  - every isolated stack failed before the start barrier
tags:
  - cloudbench
  - stage-readiness
  - controller-fixture
sources:
  - commit 83e02e99ae6c75ea8e8cf860a72c9028cf619a96
  - PR #1424 deploy
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/controller-2b2-diagnostic.private/selection-handoff.safe.json
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenario 2b2
status: open
---

## Problem

The full mandatory Linux fixture failed in scenario 2b2 after 533.864 seconds.
The earlier cancellation readiness repair and scenario 2b passed. The positive
2b2 startup instead returned nonzero. The original full result remains failed.
Its exact native container is confirmed absent; the partial diagnostic export
cannot establish that uncopied child artifacts were absent originally.

## Diagnosis

Archive searches used the exact autoscaler/boot-barrier message and positive
startup/readiness terms. The October 2 PID-birth case has the same outer failure
but proved a different identity defect. The September 9 status-proxy case proved
premature publication from PID liveness. Both fixes remain present; neither is
an established recurrence. The October 6 cancellation readiness case concerns
a different fixed-count polling condition and is a relative.

The retained fake guest logged task readiness. The retained journal submitted
both proxies after boot configuration and explicit start. The parent observed
its sole child exit before accepting task-barrier readiness. Missing local
remote-logs evidence and shutdown-proxy errors followed that abort. The first
child error was not recovered from the partial export, so no specific production
or proxy-timeout cause is claimed.

One unchanged focused 2b2 replay passed in 45.147 seconds with the original
two-second override. A second replay of the exact preceding negative 2b followed
by positive 2b2 passed in 171.623 seconds, preserving the original four-second
and two-second settings, fake provider and assertions. These counterexamples do
not repair or relabel the original full failure. They show that a deterministic
owning production defect was not established by those reductions.

The actionable policy boundary is the positive fixture's artificial two-second
window. The user explicitly required usable stage-end state and generous
infrastructure readiness, rather than narrow intermediate performance gates.

## Solution

Remove only scenario 2b2's two-second proxy-readiness override so it uses the
ordinary 180-second readiness default. Preserve the positive controller success
assertion, delayed configuration and started-Machine fault predicates, and all
existing scenario 2a journal ordering assertions. Production sources, benchmark
execution and allocation-to-full-release budgets are unchanged. This alignment
is not presented as a proved explanation of the original child exit.

## Verification

Both unchanged diagnostic selections completed their own original assertions.
Their normal stop, private copy and removal returned zero; independent exact
native inspection confirmed both containers absent. All 241 captured source
files match the frozen source except the declared invocation-selection fixture.
They grant no full-suite, paid-fleet or cached fifty-copy acceptance credit.

Independent review sealed both limited greens. The combined full mandatory
fixture remains required on the final source, so this case remains open. Passed
unmodified main, live and five-cold-seed controls retain their original receipts.

## Human feedback

The user required agents to continue through transient observations and judge
usable stage handoffs and correct overall budgets. Actual fatal outcomes and
exact ownership or resource-release violations remain failures.

## Reusable lesson

A positive lifecycle fixture should use the ordinary stage readiness contract.
Retain a transient intermediate miss honestly without promoting an unproved
micro-window explanation into a production root cause.
