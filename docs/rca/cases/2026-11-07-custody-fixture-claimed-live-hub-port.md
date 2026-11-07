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
  - "test_historical_policy_drift_renews_without_changing_original_bindings ... AssertionError: False is not true"
  - "PermissionError: [Errno 13] Permission denied: '/proc/<pid>/fd'"
tags:
  - deploy-test-cycle
  - interrupted-custody
  - fixture-environment
  - port-collision
  - agent-link-server
sources:
  - PR #1745
  - PR #1729 (test-repair /goal, recurrence)
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

## Recurrence: released probe port re-entered the ephemeral range (2026-11-07)

The test-repair `/goal` for PR #1729 reran the original gate on main
(`python3 scripts/run-deploy-structural-gates.py --max-workers 5`, 8765
held). The assigned test passed, but
`test_historical_policy_drift_renews_without_changing_original_bindings`
failed: `_reconciled` returned False because `still_bound` swallowed
`original Hub listener/socket consumer remains`.

`unused_loopback_port()` closed its probe before returning, so the port went
back into the kernel's ephemeral range (32768-60999). Any concurrent client
connection could then take it as its local port. Parallel suites in the gate
open many localhost connections, which tripped the host-wide socket check
between two validations of the same test.

Repro: with a churn process holding thousands of short-lived localhost
client connections, the unchanged test failed in 1 of 3 runs with the exact
error (the swallowed exception was surfaced with a `still_bound` wrapper).
After the fix: 0 of 5 under the same churn, and 5 of 5 with 8765 held.

Fix: `reserved_loopback_port(test)` holds a bound, non-listening socket
until test cleanup. A bound-only socket is absent from `/proc/net/tcp`, so
the validator still sees a quiet namespace. Linux `connect()` autobind and
other `bind()` calls cannot take that port. The reservation is a dual-stack `::`
socket (IPv4 fallback on hosts without IPv6); an IPv4-only hold still let an
explicit `::1` or v6-only `::` bind take the port (PR review finding). The validator and its assertions
are unchanged. Regression:
`InterruptedCustody.test_cloud_fixture_hub_port_stays_reserved_for_the_test`
fails on the old helper (`OSError not raised`) and passes on the fix.

### Second boundary: unreadable same-user process during the scan

With the port reserved, one stress run still failed in `namespace_quiet`:
`PermissionError: [Errno 13] Permission denied: '/proc/1007390/fd'`. The scan
skips other users' processes by `/proc/<pid>` owner, but a same-user process
that is non-dumpable (or exec'ing a setuid binary such as `sudo`, which
concurrent gates run) keeps that owner while `fd`/`cwd` become unreadable.
The raw error escaped the validator.

Repro: a child calling `prctl(PR_SET_DUMPABLE, 0)` makes the unchanged
`namespace_quiet` raise `PermissionError`.

Fix: bounded re-observation (2 s). After a process turns unreadable, it is
skipped only once it exits or its real uid (`/proc/<pid>/status`) is another
user's. The `/proc/<pid>` owner alone is not enough: a setuid exec such as
`sudo` turns the owner to root while the real uid stays ours (PR review
finding). One that becomes readable again is inspected normally, and one that
stays unreadable is refused as `original namespace process <pid> is
unverifiable`: custody stays fail-closed. Regression:
`InterruptedCustody.test_namespace_scan_reobserves_unreadable_same_user_process`
covers transient, persistent and setuid-shaped cases (red on both earlier
validators, green now). The full suite passed 5/5 under 8765 plus connection
churn.

The sibling scanner `deploy_test_local_cleanup.quiet()` hit the same
`PermissionError: /proc/<pid>/cwd` in `deploy-test-cycle` (three
`InterruptedLocalRecovery` tests) during the PR #1752 gate. Both scanners now
use one helper, `deploy_test_process.scan_same_user_processes`, with the same
bounded, real-uid re-observation. Regression:
`LocalCleanupQuietScan.test_unreadable_same_user_process_is_reobserved_then_refused`
(red on the old scanner with the raw `PermissionError`, 5/5 green now).

Known pre-existing limit (unchanged): the upfront filter still skips a process
already owned by another uid when the scan reaches it, including a setuid
child that keeps our real uid. Tightening that would refuse custody for every
live same-user `sudo`.

## Human feedback

None recorded.

## Reusable lesson

When code under test inspects real host state (sockets, processes, ports), its fixture must allocate identities the host cannot already be using instead of hard-coding production values, and hold them reserved for the test's lifetime; a probed-then-released port is free for anyone.
