---
id: 2026-09-11-hub-fixture-wait-after-birth-rejection
date: 2026-09-11
title: Hub fixture cleanup waited on a live child after rejecting its birth identity
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh terminate_test_pending_hubs and terminate_test_owned_hubs conditional signal followed by unconditional wait
symptoms:
  - cloudbench multi-workstream suite stops after scenario 4 before scenario 5
  - pending cleanup waited for its still-live drift Hub
  - owned cleanup waited for its still-live unknown Hub
  - ps lstart differs from recorded pid_start after suspended Docker VM resumes
tags:
  - cloudbench
  - teardown
  - process-identity
  - wait
  - host-sleep
sources:
  - PR #1299
  - commit 49af4b09888b5ee8a348b1667a17b41a3b9d44d7
repro: scripts/tests/cloudbench-hub-reaping.test.py
status: fixed
---

## Problem

The Linux controller gate on 49af4b0 stopped between scenarios 4 and 5.
Its Bash parent PID 27660 was sleeping in `do_wait`, with syscall `wait4(-1)`
and script descriptor offset 187959 at `reset_test_workspace_fleet_roots`.
Live Hub children 71443 and 71478 retained the same PID, command digest,
paths, and endpoint token, while their recorded birth was September 11
22:34:42 UTC and the current `ps lstart` was September 12 01:12:09 UTC.
The Docker VM had been suspended during Mac sleep. The third Hub, 74070,
also had divergent recorded/current wall-clock birth; its endpoint computes
that birth dynamically, so endpoint equality alone was not treated as proof.

Evidence is preserved in
`.context/acceptance/suspended-vm-hub-wait-rca/suspended-runtime.json` and
`suspended-controller-fixture.tgz` (4,404,965 bytes; SHA256
`41271d80b81dd9f68cbafa0b3edc62b0e00a68643bebe50ac466d1cf334cdad4`).
The exact owned Linux container was stopped only after capture and ownership
verification; its entire process namespace is terminal. No benchmark fleet
or provider resource was active during this fixture failure.

## Diagnosis

Archive searches used `pid_start lstart clock sleep wait Hub` and
`cleanup hangs live process birth mismatch`. The
[clamshell suspension](2026-08-03-clamshell-sleep-invalidated-live-benchmark-timeout.md)
and [pending Hub identity](2026-09-09-pending-hub-cleanup-used-port-as-process-identity.md) cases are
relatives: host suspension explains the triggering identity observation,
while the prior pending-Hub case concerned treating a port as PID authority.
Neither addressed the unconditional join after a rejected identity.

- What: cleanup remained blocked on a still-running child.
- Where: both fixture cleanup consumers rejected the observed birth, skipped
  signals, then called `wait` on that same numeric PID.
- Why: permission to signal and permission to join were conflated. Rejection
  of ownership does not make a child terminal, and a rejected PID may still
  identify a live Bash child.
- Proof: the actual fixture functions, with a real Hub child, fail unchanged
  when only the `ps` observation drifts or becomes unavailable. Normal
  identity controls pass on both revisions.
- Problem: conditional cleanup followed by unconditional blocking join.
  The deeper invariant is independent terminal proof before every blocking
  join. Removing ownership checks or adopting a PID on port evidence would
  violate that invariant's separate signal-authority requirement.

The replay changes only Bash's process observation, preserving the real
Hub, owner records, signal code, listener checks, and cleanup functions.
On the baseline worktree at 140bb417c, the exercised source files are byte
identical to 49af4b0. The same command on baseline and fixed trees is:
`BASH=/opt/homebrew/bin/bash python3 scripts/tests/cloudbench-hub-reaping.test.py`.
Baseline records four bounded failures plus two normal passes; the fixed
tree passes all six. Rejected identities must return nonzero within two
seconds, leave the Hub alive, preserve record hashes and tracked PIDs, and
then clean normally once the valid observation is restored.

## Solution

`reap_test_terminal_hub` now requires a zombie or confirmed absent numeric
process before `wait`. A live, stopped, empty, conflicting, or unavailable
probe fails promptly and preserves the cleanup authority. Both consumers use
this one helper. Existing birth, group, listener, and terminal cleanup checks
remain intact. No production identity protocol or benchmark bound changes.

The permanent real-Hub regression is invoked by the existing controller
suite in `/deploy`. Test failure cleanup uses the repository's native
`process-identity.py` capture, which survives wall-clock birth drift; uncertain
or malformed authority retains the fixture evidence and still joins its
owned Bash parent. Independent review found and corrected the test's first
wall-clock-based failure cleanup and missing-key exception handling.

Independent actual-code controls also verify zero waits/signals for both
rejected owners, refusal for five nonterminal/unknown states, and reaping for
zombie/confirmed absent states. Native failure-cleanup controls cover drift,
missing/malformed records, unknown identity, and already-absent Hub. Receipts
are under `.context/acceptance/suspended-vm-hub-wait-rca/`; final real-Hub logs
are `reaping-final-before.log` and `reaping-final-after.log`. Surrounding
listener-status, pending-Hub, and reset-Hub self-tests passed.

This fixes the reproduced fixture join defect. Full fresh deployment gates
and the separate 10-by-10 cloud outcome proof remain required; these causal
tests give no cloud acceptance credit. At 10,000 production agents this
fixture-only change adds no queries, polling, subscriptions, or runtime
state. The six bounded local test cases add no paid workload.

## Human feedback

The user directed continued execution without repeated permission requests,
called out a delay exceeding five hours, reported storage unlocked, and
required ten consecutive sequential ten-task cloud slices. The user also
required retaining a normal 120-minute backstop while temporarily limiting
the acceptance run to five minutes. No timeout was increased for this fix.

## Reusable lesson

Never block on a child after refusing to signal it unless an independent
terminal-state check proves that numeric process has already exited.
