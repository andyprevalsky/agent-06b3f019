---
id: 2026-11-07-deploy-test-plan-fixture-hub-port-collided-with-host-hub-and-proc-scan-eacces
date: 2026-11-07
title: The interrupted-custody deploy test pinned the default Hub port and its /proc scan failed on a briefly unreadable process
surface: harness
component: deploy-interrupted-cleanup
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-plan.test.py InterruptedCustody.fixture wrote port 8765 into the Hub owner file, and scripts/deploy_test_interrupted_cleanup.py namespace_quiet scanned the host socket table and every same-user /proc/<pid>/fd without re-observing a transient EACCES
symptoms:
  - "interrupted custody: original Hub listener/socket consumer remains"
  - "interrupted custody proof refused: original Hub listener/socket consumer remains"
  - "Permission denied: '/proc/832418/fd'"
  - "worker ownership remains; reconcile exact cleanup before recovery: smoke"
  - "failed deploy structural gates: deploy-test-plan"
tags:
  - deploy
  - structural
  - interrupted
  - custody
  - proc-scan
  - flaky
sources:
  - PR #1723 staged deploy sweep 3, deploy-command-structural, source 0d7de94dcece9ffd58482e9e7bc8ceddba89e2ea
  - task .context/deploy-pipeline/attempts/2/initial/deploy-command-structural/output.log
  - commit ec1b265e79 (introduced the module and test on main, 2026-11-06)
repro: python3 -B scripts/tests/deploy-test-plan.test.py InterruptedCustody
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. Sweep 3 of the PR #1723 deploy ran `deploy-command-structural`
(`python3 scripts/run-deploy-structural-gates.py`). One suite, `deploy-test-plan`, failed:
`InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history (cloud=True)` raised
`ValueError: interrupted custody proof refused: interrupted custody: original Hub listener/socket consumer remains`.
The file, the module under test and this test all arrived from main with commit ec1b265e79 (2026-11-06 23:16);
the PR's own diff does not touch them, and the previous sweep (before the merge of that commit) passed this gate.

## Diagnosis

Two independent defects in the same new custody check, both pre-existing on main:

1. **Fixed port.** The cloud fixture builds a Hub owner file for the default Hub port `8765`, and
   `namespace_quiet` fails closed when any non-TIME_WAIT/CLOSE socket on the host has that local or remote port. The
   devbox still ran a leaked `agent_link_server.py` listening on `127.0.0.1:8765` (pid 1752902, inside the
   `rose-deploy-gates-096709cae.scope` of an earlier deploy). Local repro, source 0d7de94dc in a scratch clone with
   that listener present: the test failed in 1.5 s with the same error. The identical test passes only on a host
   with nothing on 8765, so its result depended on the host, not on the code under test.
2. **Transient EACCES.** After fixing the port, a 40-run loop of the same two tests failed 7 times on a loaded
   devbox with `PermissionError: [Errno 13] Permission denied: '/proc/<pid>/fd'` (and, through `still_bound`, which
   swallows it and returns False, `worker ownership remains ... smoke`). `namespace_quiet` iterates every
   same-user `/proc/<pid>`; a process in the middle of `exec` is briefly unreadable even to its owner, and the code
   caught only `FileNotFoundError`/`ProcessLookupError`. This is the class recorded for the controller-export writer
   scan (memory `export-helper-proc-scan-permission-flake`, fixed in `cloudbench-controller-export.py` by bounded
   re-observation) arriving again in a new copy of the same loop.

A first attempt at the port fix (a random port from the kernel's ephemeral range) was itself flaky for a third
reason: an ephemeral port can be held by any live outbound connection. The final fixture picks a free port above
`ip_local_port_range`.

Archive search: `original Hub listener/socket consumer remains 8765 interrupted custody` found the parent case
`2026-11-06-interrupted-preallocation-reconciliation-required-missing-adapter` (where this check came from) and
`fixture listener port` found `2026-10-28-deploy-worktree-ports-inside-kernel-ephemeral-range`. A recurrence of the
latter's lesson, not of its cause.

## Solution

- `scripts/tests/deploy-test-plan.test.py`: the cloud fixture takes a free random port above `ip_local_port_range`
  (not in the live socket table) instead of `8765`. A new test binds a listener on that port and asserts the check still
  refuses, so the fixture change cannot silently make the check vacuous.
- `scripts/deploy_test_interrupted_cleanup.py`: the per-process observation moved into `consumer_quiet`;
  `namespace_quiet` re-observes an unreadable process up to `OBSERVATION_ATTEMPTS` (5) times, 0.2 s apart, skips a
  process that has exited, and still fails closed while it stays unreadable and alive. A new test pins both
  branches.
- Verification: the same failing test passes unchanged with the foreign listener still bound; 40 consecutive runs of
  the three affected tests passed after the change (7 of 40 failed before the EACCES fix), and the full file passes
  (40 tests, twice). It runs in the `deploy-command-structural` gate.

10k agents: test-only fixture plus a bounded 5 x 0.2 s retry per unreadable process in a launch-time safety check.
Nothing scales with agent count.

The leaked Hubs (about a dozen `agent_link_server.py` processes on ports 8765 to 8776, 5 to 17 hours old when
measured, left by earlier deploys' smoke campaigns) are not touched by this fix; they belong to other runs and are
reported to the user as foreign state.

## Human feedback

None recorded.

## Reusable lesson

A deploy fixture must not hard-code a default service port or an ephemeral port when the code under test scans the
host socket table, and every `/proc/<pid>` loop must re-observe a briefly unreadable process instead of failing on
the first EACCES.
