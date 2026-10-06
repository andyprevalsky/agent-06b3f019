---
id: 2026-09-12-worker-port-fixture-released-primary-sockets-before-startup
date: 2026-09-12
title: Worker port fixture released primary sockets and hid startup failures during cleanup
surface: harness
component: worker-blackbox-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the worker port fixture closed its primary socket reservations before startup and signalled an already-terminal supervisor group before joining it
symptoms:
  - ready-1 exists while ready-0 is missing
  - FileNotFoundError for the primary readiness file
  - PermissionError EPERM in os.killpg replaces the startup failure
  - primary worker stderr disappears with the temporary fixture directory
tags:
  - worker
  - fixture
  - port-ownership
  - cleanup
  - evidence
sources:
  - PR #1299
  - commit ed339ffe4ca40f2cd5b173996791607921f3f381
  - agent backstop_evidence_review
repro: agents/tests/blackbox/worker.blackbox.py
status: open
---

## Problem

Agents coverage on `ed339ffe4` passed 99 of 100 domains. The worker domain passed
16 of 17 checks; its occupied-secondary-port fixture had `ready-1` but no
`ready-0`, then cleanup raised `PermissionError: [Errno 1] Operation not
permitted`. The temporary directory was removed, including primary stderr.
The original primary startup cause therefore remains an open capture gap. No
foreign listener or host-load event is claimed to have caused that live failure.
A subsequent read-only inventory found no worker or local-worker-supervisor
processes, but the missing original PID receipt prevents historical exact-PID
retirement proof. No unknown process was signalled.

## Diagnosis

Path: fixed-primary fixture socket reservation → launcher environment → fake
worker binds/readiness → supervisor lifecycle → fixture cleanup/reporting.
The fixture sampled both fixed primary ports with `bind(0)`, then closed them
before launching. It retained only the old derived secondary listener. The
readiness loop inspected a secondary bind error but did not diagnose primary
failure or supervisor exit. It then read the absent primary file. Finally it
unconditionally called `killpg` before `wait` and socket cleanup.

A retained replay executed the unchanged owning test function with the actual
launcher and fake workers. A real loopback listener took the released primary
port before launch. Primary stderr captured `Address already in use`, secondary
readiness existed, the supervisor exited 1, and its unreaped state was `Z`.
The original group TERM returned EPERM on macOS and masked the same missing
`ready-0` error. The normal control passed in 0.287 seconds; takeover failed in
10.037 seconds. Every exact test child was joined afterward. An earlier
instrumented replay called `poll` first, reaping the zombie and changing the
kernel result to ESRCH; it is supporting evidence, not the exact EPERM replay.
The controlled takeover proves this fixture mechanism, not the lost original
host listener's identity.

Archive searches were `worker ready-0 PermissionError killpg` and `local workers
occupied secondary port fixture readiness`. The September 10 worker port
arithmetic case is a relative: its production secondary allocation fix remains
intact, but its fixture had a separate fixed-primary ownership gap. The September
11 lost-inner-evidence and listener-fixture cases are related evidence/resource
contracts. Searches across completed plans for `worker.blackbox`,
`run_local_worker`, `secondary worker`, `observability ports`, and `worker metrics`
had no matches. All-branch history and inspection of the 50 most recent open
PRs found no in-flight fix for this owning test. PRs 1285 and 1286 touch the
older shell worker launcher; their exact patches do not repair this fixture's
primary handoff, error capture, or terminal-process-group cleanup.

## Solution

The fixture keeps both fixed primary sockets bound and transfers exactly two
socket descriptors to fake worker zero over a bounded private UNIX channel.
The worker compares the actual received endpoints against the launcher's fixed
primary environment. Worker one still performs real port-zero binds while the
old derived sibling port remains occupied. This preserves the original fixed
primary and distinct-secondary assertions without a reservation/rebind race.
No production launcher, worker, benchmark, provider, or task definition changes.

Readiness checks both workers and early supervisor exit under the existing
10-second cap. Launcher, primary and secondary logs remain under a private
retained fixture directory. Cleanup signals the directly owned unreaped Popen,
joins it, and verifies recorded exact child native identities. It does not
signal a stale group number. Independent cleanup failures are collected so bad
child metadata, socket teardown, or receipt publication cannot replace the
primary failure or skip unrelated cleanup steps. Unverified cleanup records a
failed retained state. A short private socket path preserves macOS portability;
the handoff thread and sockets have explicit retirement.

Permanent controls exercise primary-port takeover, injected primary startup
failure, and the actual cleanup finally with malformed metadata, failed socket
close/unlink/disk writes, and an unstarted handoff thread. The unchanged final
suite had one positive control and three failures on the original owning
function, then four passes in 0.841 seconds on the private candidate. The
original function was byte-identical to `ed339ffe4` in that failing replay.
A separate actual-finally control failed against the first candidate on
`socket close failed`, then passed without changing its assertion. All controls
are registered in the worker blackbox used by agents coverage and `/deploy`.
Evidence and independent review are under
`.context/acceptance/worker-fixture-port-rca/`.

At 10,000 agents this adds no production state or work. The offline fixture uses
two workers, a fixed socket set and one bounded handoff thread. It introduces no
shared allocator, lock, port-range guess, retry loop, or wider timeout.

The independently reviewed candidate was applied after the source freeze ended.
The canonical worker domain passed all 20 cases in 44.6 seconds; Ruff also passed.
The final source matches the private candidate exercised by the unchanged
regressions. Fresh full validation remains pending. This case remains open:
the original missing-primary-log attribution is not closed by a controlled
takeover. The canonical log is
`.context/acceptance/worker-fixture-port-rca/canonical-worker-after.log`.

## Human feedback

The user requires completion without repeated permission requests, normal
120-minute backstops and a temporary five-minute limit for the cloud validation.
Ten consecutive sequential slices of ten actual tasks must have no infrastructure
outcomes; ordinary PASSED or FAILED counts, SKIPPED does not. This fixture repair
adds no paid run or acceptance credit and changes none of those bounds.

## Reusable lesson

Keep fixture resources owned through handoff, and preserve the first failure
while independently retiring every exact resource the fixture launched.
