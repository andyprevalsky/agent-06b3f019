---
id: 2026-10-01-worker-drain-required-birth-after-owned-child-exit
date: 2026-10-01
title: Worker drain required a birth identity after its owned child had exited
surface: infra
component: local-stack-worker-drain
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_wait_owned_agent_shutdown rejected missing birth before checking whether the recorded child was absent
symptoms:
  - "FAIL: an already-reaped worker with no captured birth needs no drain"
  - "AGENTS_DRAINED"
tags:
  - worker
  - shutdown
  - cleanup
  - process-identity
sources:
  - PR #1299, CodeRabbit comment 4152321206
  - commit 393ebef7cddfdf624d57bb5f0525ad8dca236418
repro: scripts/tests/run-process-cleanup.test.sh
status: fixed
---

## Problem

The actual process helper rejected a launched and reaped child with no captured
birth identity. Its caller captures birth after launch, so an immediate child
exit can create this state. Static caller inspection shows that the rejection
keeps `AGENTS_DRAINED` false and returns before sibling teardown. No earlier live
stack failure is attributed to this race without supporting runtime evidence.

## Diagnosis

Archive searches covered `worker supervisor missing birth cleanup stopped process`
and `run drain owned agents early exit process identity`. Worker-port fixture and
worker shutdown cases provide ownership guidance, but do not establish this
already-absent child boundary. The original helper tested nonempty PID and birth
together before observing the process.

The existing native cleanup owner test launches a child, waits for its exit, and
invokes the actual helper with that exact PID and an empty birth. The original
source failed the new assertion in 8.537 seconds. The fixture retains its own
process-tree cleanup and does not signal unrelated processes.

## Solution

Validate the PID, observe its current birth, and return success for an absent
process before requiring a captured birth. An empty `ps` result is cross-checked
with `kill -0`; a still-live process remains rejected. A live process without a
birth remains fail-closed and receives no signal. Existing exact-birth matching,
single graceful signal, deadline, wait, and nonzero child-exit handling remain.

The identical owner test passed in 7.218 seconds. It additionally verifies that
a live fixture with unknown birth is rejected and remains alive, retaining the
existing same-worktree, foreign-worktree, database-owner, and exit-code controls.
Bash syntax and affected Python lint passed; no shutdown limit was changed.

## Independent review and archive

Private original source, RED/GREEN logs, and hash-bound receipts are retained in
`.context/acceptance/proof85-terminal-owner-rca/`. Independent root review passed
the source, unchanged RED/GREEN fixture, and live-unknown/no-signal control.
These native fixture processes make no provider or model calls and earn zero
benchmark credit. The original failed reproduction remains unchanged. Final
deploy gates and the consecutive live fleet proof remain pending.

## Human feedback

The user requires correct process teardown and compact owning regressions;
missing identity must never authorize signalling a live process.

## Reusable lesson

Prove whether an owned child still exists before demanding the identity needed
to signal it, while treating uncertain live ownership as unresolved.
