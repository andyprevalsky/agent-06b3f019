---
id: 2026-10-01-agent-store-fixture-required-linux-procfs-on-macos
date: 2026-10-01
title: The agent-store process fixture required Linux procfs on macOS
surface: harness
component: workspace-env-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/workspace-env.test.sh expected a live cloud agent-store id on a host without /proc
symptoms:
  - "a running store daemon's id is the agent id: got '', expected 'bc-live'"
  - "got '', expected 'bc-live'"
tags:
  - workspace-env
  - procfs
  - macos
  - fixture
  - process-cleanup
sources:
  - PR #1299
  - commit aa76b7bf7ecb4d49f33c426eee245b581dbaf0a8
repro: scripts/tests/workspace-env.test.sh
status: fixed
---

## Problem

The workspace-env entry failed in the local structural gate on macOS. Its new
live agent-store fixture expected `bc-live`, but `cloud_env_agent_id` returned
empty. The gate's source was unchanged; this was not a benchmark or fleet
failure. The existing helper intentionally verifies the daemon through
`/proc/<pid>/cmdline`, and this host has no `/proc`.

## Diagnosis

The fixture started a real owned process and wrote its PID into a synthetic
store, then unconditionally required the Linux-only identity lookup to succeed.
The suite already guarded its real-kernel-boot assertions by host capability;
the new daemon assertion lacked that boundary. Empty identity is the correct
fail-closed behavior when native daemon identity cannot be established.

The exact original assertion and daemon fixture reproduced the failure in
0.047 seconds against the unchanged helper. A private owner trap drained its
child after the assertion. The original test only removed its temporary files
on failure, so its own daemon fixture also needed an explicit EXIT drain.

Archive searches for the daemon assertion and workspace identity found
`2026-10-01-snapshot-cloned-cloud-vms-shared-one-workspace-identity`. Its cloud
identity repair remains intact; this case concerns the fixture's platform
assumption, not a recurrence of shared cloud workspace identity.

## Solution

The daemon fixture now owns its process inside a subshell with an EXIT drain.
On hosts with readable `/proc/self/cmdline`, the original positive live-daemon
assertion remains unchanged. Other hosts assert that the unverified store id
is ignored. The stale-daemon and reused-PID rejection assertions still run.

The complete existing workspace-env command passes 55 assertions on macOS in
2.487 seconds. One scoped native execution on the existing Linux controller
passes the original live/stale/reused-daemon checks, three of three, in 0.031
seconds. Both test owners were joined, and the Linux owner was absent afterward.
The runtime helper is byte-identical to the failing source. No production
behavior, environment secrets, timeout, benchmark or model call changed.
The enclosing structural lane still requires its normal integrated outcome.

## Human feedback

The user asked to avoid unnecessary resets and a large new verification suite.
Preserve the real platform-specific assertion and its negative controls rather
than weakening the production identity check or increasing a timeout.

## Reusable lesson

Gate native process fixtures on the capability their runtime owner actually uses, and drain their exact child even when an assertion fails.
