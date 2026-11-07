---
id: 2026-11-07-interrupted-recovery-fixture-fixed-port-footprint-collides-with-sibling-gate
date: 2026-11-07
title: InterruptedLocalRecovery used a fixed CONDUCTOR_PORT whose listener footprint a concurrent deploy gate's fixture occupied, so every case failed "interrupted root listener remains"
surface: infra
component: deploy-test-cycle-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery.setUp hard-coded CONDUCTOR_PORT 15000; deploy_test_local_cleanup.py rejects any host-wide LISTEN socket on base + LISTENER_OFFSETS, which includes the Hub search range 20764-21264
symptoms:
  - "ValueError: local cleanup: interrupted root listener remains"
  - "failed deploy structural gates: deploy-test-cycle"
  - "ERROR: test_backend_inventory_growth_keeps_old_cleanup_and_new_full_request (__main__.InterruptedLocalRecovery"
tags:
  - deploy-structural
  - port-collision
  - fixture
  - concurrent-gates
  - staged-deploy-cycle
sources:
  - PR #1760
  - commit 8cc6df20b (failed source in the staged deploy cycle)
repro: scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery (run in a fresh network namespace with and without a listener on 21136)
status: fixed
---

## Problem

During the PR #1760 staged deploy cycle, `deploy-command-structural`
(`python3 scripts/run-deploy-structural-gates.py --max-workers 5`) ended
`failed deploy structural gates: deploy-test-cycle`. All five
`InterruptedLocalRecovery` cases raised
`ValueError: local cleanup: interrupted root listener remains`. At the same
time the `cloudbench-controller` gate, running in another isolated worker on
the same host, had held 127.0.0.1:21136 and :21137 for 12 minutes (python
pids 542359 / 541105, cwd /var/tmp/rdw/cloudbench-controller, the
cloudbench-local-multi-workstream fixture).

## Diagnosis

`interrupted_local_cleanup` (scripts/deploy_test_local_cleanup.py) reads
/proc/net/tcp and /proc/net/tcp6 and refuses while any LISTEN socket sits on
the gate's footprint: `CONDUCTOR_PORT + LISTENER_OFFSETS`, which includes
the 500-port Hub search range at +5764. The fixture fixed the port at 15000,
so its footprint included 20764-21264, and the sibling fixture's 21136
listener tripped the host-wide check in every case.

Repro, in a fresh network namespace (`sudo unshare -n`) on the unchanged
source: the empty namespace gives `OK`; one listener on 127.0.0.1:21136 gives
`FAILED (errors=5)` with the same error. The PR #1760 diff touches only
back-end/ and docs/, so it did not introduce this (Gate: NOT_INTRODUCED). The
gate is an aggregate with a nonzero exit, so the result is UNVERIFIED and
cannot be waived before merge. It was fixed in the same PR.

Why possible: the fixture claimed a fixed port window while the code under
test checks the whole host. This is the same class as
2026-11-07-custody-fixture-claimed-live-hub-port. That fix covered only the
deploy-test-plan custody fixture's single Hub port.

## Solution

`reserved_listener_footprint(test)` scans upward from 15000 for a base whose
entire listener footprint can be bound. It holds a bound, non-listening
dual-stack socket on each footprint port for the test's lifetime, so no
sibling process can listen there and the held sockets never appear as
listeners. It raises the test process's soft fd limit when needed (the
staged cycle's service runs with 1024). The case that deliberately proves the
refusal now calls `listen()` on the base-port reservation instead of binding
15000. The validator and every assertion are unchanged. Post-fix, the same
namespace A/B passes both ways. The full `deploy-test-cycle.test.py` passes
on the live host (179 tests), and `deploy-command-structural` passes in the
next full staged cycle.

Golden reference: not applicable (no approval-gated hunk). 10k-agent
behavior: test-only.

## Human feedback

None recorded.

## Reusable lesson

A test whose code under test checks a host-wide resource must reserve the exact resource window it names, never assume a fixed port range is free while sibling gates run on the same host.
