---
id: 2026-09-09-pending-hub-cleanup-used-port-as-process-identity
date: 2026-09-09
title: Pending Hub cleanup treated a verified replacement listener as the retired process
surface: harness
component: cloudbench-multi-workstream-cleanup
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh terminate_test_pending_hubs asserted shared port absence after exact PID-birth teardown
symptoms:
  - "❌ pending test Hub listener survived exact teardown"
  - "FAIL: refusing to reset"
  - unreconciled live replacement Hub PID after final cleanup
tags:
  - cloudbench
  - hub
  - teardown
  - process-identity
  - stale-pending
sources:
  - commit cb7b2e555b5db9f1ac9b5eee603b4b2c57f5f71b
  - commit 6c1bd8bfaa9ba6677e10f3f438b878c1d88f6e00
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

The deterministic stale-Hub replacement self-test exited 1 in 18.994 seconds
with `❌ pending test Hub listener survived exact teardown on :51136` and
`FAIL: refusing to reset /tmp/tmp.GkiOLE5CRS/ws-a before exact Hub teardown`.
Final cleanup retained the fixture and reported replacement PID 3760015 as
unreconciled.

The unchanged pre-fix command was
`CLOUDBENCH_TEST_RESET_HUB_SELF_TEST=1 CLOUDBENCH_TEST_ORIGINAL_HUB_TOKEN=00000000000000000000000000000001 CLOUDBENCH_TEST_REPLACEMENT_HUB_TOKEN=ffffffffffffffffffffffffffffffff bash scripts/tests/cloudbench-multi-workstream.test.sh`.
The fixed code ran that same command successfully in 13.810 and 14.430 seconds.

## Diagnosis

Critical path: publish original pending/owner records → retire its exact PID
birth → publish a distinct replacement on the same port → provider audit
terminalizes the retired birth → EXIT cleanup scans pending records in
deterministic token order → stale pending teardown probes the shared port.

What: cleanup rejected a live replacement and stopped before reconciling its
own pending/owner records. Where: `terminate_test_pending_hubs` checked only
`cloudbench_tcp_listener_present` after proving the recorded PID birth and
process group absent. Why: token `000...` sorted before `fff...`, so the old
record observed the replacement's listener and treated port liveness as proof
that the retired process survived. Proof: pre-fix debug entries recorded
PID 3759891 with `exact_live=0` and `listener_present=1`; the retained endpoint
reported PID 3760015, token `fff...`, and a different birth. Both provider
audits were `provider-teardown-verified`, with zero claims.

The post-fix trace resolves that same listener to the immutable
`agent-link-server.40576.ffffffffffffffffffffffffffffffff.owner`, then processes
the replacement's own pending record with `exact_live=1`; the command exits 0.
This confirms the provider-finalization, malformed-publication, and PID-birth
comparison hypotheses were false.

Problem: the cleanup contract mixed identity-scoped termination with
port-scoped survival, even though a port may be transferred to a separately
owned process before stale records are swept. This is a sibling of
`2026-09-09-provider-teardown-coupled-to-retired-hub-owner`, not a recurrence:
the production finalizer was correct, but its permanent test's cleanup still
made the same port-as-identity assumption.

## Solution

When a listener remains after exact pending PID-birth teardown, cleanup now
requires `cloudbench_central_hub_owner_for` to resolve it to a valid, live,
immutable owner that is distinct from the stale pending record. Only that
verified replacement is deferred to the existing owner-record pass. An
unowned listener or the same owner still fails with the original assertion;
the final owner pass still proves every exact PID/group and every recorded
port absent.

The permanent regression keeps deterministic original/replacement tokens, the
replacement identity assertions, and the unchanged focused command. The fix
also covers arbitrary stale-record ordering without signaling a replacement.
At 10,000 agents this changes no production path; the test cleanup remains
bounded by its small exact-owned Hub record set.

## Human feedback

The user required complete What/Where/Why/Proof/Problem fields, the smallest
general fix at the owning boundary, the exact unchanged reproduction to pass,
no weakened listener or identity assertions, no timeout or benchmark-definition
changes, removal of debug-only logs after proof, focused tests, and no commit
or push.

## Reusable lesson

Resolve a surviving listener to immutable process ownership before deciding whether exact teardown failed; a shared port is never process identity.
