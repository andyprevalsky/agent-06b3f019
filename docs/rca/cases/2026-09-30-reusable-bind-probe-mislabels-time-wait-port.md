---
id: 2026-09-30-reusable-bind-probe-mislabels-time-wait-port
date: 2026-09-30
title: Deploy port test called a TIME_WAIT port free for an ordinary socket
surface: harness
component: run-port-collision-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/run-port-collision.test.sh find_free_port used SO_REUSEADDR while its outbound socket did not
symptoms:
  - 'OSError: [Errno 48] Address already in use'
  - 'FAIL: outbound connection did not start from port 61004'
  - 'FAIL: TIME_WAIT port was reported free for an outbound socket'
tags:
  - deploy
  - port-collision
  - time-wait
  - socket
  - test-fixture
sources:
  - commit 06f714328b0a555e35fa55d356c07e1684c1a25e
repro: scripts/tests/run-port-collision.test.sh
status: fixed
---

## Problem

The `/deploy` `deploy-command-structural` stage failed its
`run-port-collision` suite. The outbound socket fixture raised
`OSError: [Errno 48] Address already in use`, then the test reported
`FAIL: outbound connection did not start from port 61004`. The stage log is
`.context/deploy-runs/20260930-235404-20524/logs/deploy-command-structural-20261001-001305-87023.log`.
No listener owned port 61004 after the test exited.
The original port's TCP state was not captured; the `TIME_WAIT` mechanism was
reproduced separately at the same bind boundary.

An isolated Python replay created a closed TCP listener with an accepted
connection. Its local port remained in `TIME_WAIT`: a socket with
`SO_REUSEADDR` could bind it, while an ordinary socket failed with Errno 48.
That matched the test's port probe and outbound consumer.
The same socket sequence on Linux also yielded `reuse=True bind=SUCCESS`
and `reuse=False bind=FAIL ([Errno 98] Address already in use)`.

## Diagnosis

Critical path: an HTTP fixture closes → its port enters `TIME_WAIT` →
`find_free_port` calls `bind` with `SO_REUSEADDR` → it returns that port → the
outbound fixture binds without reuse → `EADDRINUSE`. The first bad boundary is
the port probe's different socket option. The deeper owned problem is that the
test's availability check did not model the socket it was allocating for.

Archive searches: `outbound connection did not start from port Address already
in use run-port-collision`; `find_free_port socket SO_REUSEADDR bind probe
listener macOS port collision`. The nearest cases involved independently
derived ports or a shell status capture error, not the same socket-option
contract. This is a new cause.

The test also reaped every `python3 -m http.server` listener across its fixed
port range, regardless of workspace ownership. That cleanup could stop another
workspace's test process. It was unnecessary once occupied ports were skipped.

## Solution

Removed `SO_REUSEADDR` from `find_free_port`'s probe and deleted the broad
server reaper. `find_free_port` now returns a failure when no candidate is
usable, so callers can test that outcome without exiting the whole script.

The checked-in `run-port-collision.test.sh` creates a real `TIME_WAIT` port and
restricts the selector to it. With the old probe, the exact command
`bash scripts/tests/run-port-collision.test.sh` failed with
`FAIL: TIME_WAIT port was reported free for an outbound socket` (exit 1).
With the corrected probe, the identical command passed
`PASS: TIME_WAIT port is unavailable to an outbound socket` and
`All run.sh port collision tests passed.` (exit 0). This suite runs in every
`/deploy` structural batch.
The fixture also confirms that an ordinary bind is blocked before testing the
selector. The selector still has a check/use window if two independent tests
claim the same port at the same instant; this case proves the mismatched socket
options that caused the observed failure, rather than claiming to eliminate
every possible port race.

No production runtime or agent behavior changes. The regression creates one
short-lived local socket pair when the deploy test runs.

## Human feedback

None recorded.

## Reusable lesson

Probe a test port with the same socket options the fixture will use, and leave other workspaces' processes alone.
