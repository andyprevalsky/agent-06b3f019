---
id: 2026-11-07-custody-fixture-claimed-live-hub-port
date: 2026-11-07
title: Interrupted-custody fixture hard-coded Hub port 8765, so a real campaign Hub on the host failed the namespace-quiet check
surface: harness
component: deploy-test-interrupted-cleanup-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-plan.test.py InterruptedCustody cloud fixture wrote a Hub owner record with port=8765, and deploy_test_interrupted_cleanup.namespace_quiet scans the host's live /proc/net/tcp for that port
symptoms:
  - "interrupted custody: original Hub listener/socket consumer remains"
  - "ERROR: test_static_and_cloud_reconcile_preserve_originals_and_history (__main__.InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history) (cloud=True)"
  - "deploy-test-plan exit=1"
tags:
  - deploy-test-cycle
  - interrupted-custody
  - fixture-environment
  - port-collision
  - agent-link-server
sources:
  - PR #1745
repro: python3 scripts/tests/deploy-test-plan.test.py InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history (with a listener on 127.0.0.1:8765)
status: fixed
---

## Problem

During the PR #1745 `/deploy` staged cycle (2026-11-07), the
`deploy-command-structural` gate failed `deploy-test-plan` with
`ValueError: interrupted custody proof refused: interrupted custody: original
Hub listener/socket consumer remains`. The same cycle was running the cloud
smoke campaign on this host, whose Hub (`agent_link_server.py`) listens on
127.0.0.1:8765; a cancelled campaign also leaked that server (ppid 1).

## Diagnosis

The cloud branch of the `InterruptedCustody` fixture writes a Hub owner
record named `agent-link-server.8765.<token>.owner` with `port=8765`. The
validator under test (`namespace_quiet`) correctly requires that no live,
non-closing socket on the host uses an original Hub port; it reads the real
`/proc/net/tcp`. Any genuine Hub on 8765 — a concurrent smoke campaign or a
leaked link server — therefore fails the fixture.

Local repro: with a listener bound to 127.0.0.1:8765, the unchanged test
fails with the exact custody error; without it, or after the fix, it passes.
Gate: NOT_INTRODUCED (the PR changed no deploy tooling; the failure depends on
host socket state).

Why possible: the fixture claimed a well-known production port while the
code under test validates global host state.

Golden reference: not applicable (no approval-gated hunk).

## Solution

The fixture asks the kernel for an unused loopback port (`bind(('127.0.0.1',
0))`) and uses it for the owner file name, record and retirement row. The
validator and its assertions are unchanged. The repro now passes with a live
8765 listener; the full `deploy-test-plan.test.py` passes.

## Human feedback

None recorded.

## Reusable lesson

When code under test inspects real host state (sockets, processes, ports), its fixture must allocate identities the host cannot already be using instead of hard-coding production values.
