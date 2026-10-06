---
id: 2026-09-11-tcp-listener-fixture-never-drained-accept-queue
date: 2026-09-11
title: Native TCP fixture filled its accept queue during readiness and failed the next probe
surface: harness
component: cloudbench-env-controller-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the listen(1) fixture never accepted the connection created by its readiness probe
symptoms:
  - occupied port probe must exit 0
  - TCP listener probe exit-code contract broken
  - second TCP probe times out while the fixture listener is alive
tags:
  - cloudbench
  - macos
  - tcp
  - accept-queue
  - fixture
sources:
  - PR #1299
  - commit 8fec27c4d80e54f44d25e930ebdbd3dff1999fd7
repro: scripts/tests/cloudbench-env.test.sh
status: fixed
---

## Problem

The native controller command `bash scripts/tests/cloudbench-env.test.sh`
failed at `occupied port probe must exit 0`. The prior free-port and malformed
argument assertions had passed. The full failing log is
`.context/deploy-runs/20260911-012746-73886/logs/cloudbench-controller-20260911-180139-95461.log`.

## Diagnosis

Critical path: bind/listen fixture → readiness TCP connection → second required
TCP connection → occupied-port assertion. The fixture called `listen(1)` and
slept for two seconds without accepting connections. The readiness probe itself
filled the available queue on macOS. The following probe therefore timed out
against a live listener. This was not a slow lsof operation: the production
helper uses Python `connect_ex`.

The isolated reproduction uses the actual helper and the same listener backlog
and two-second lifetime. Readiness returned `0` in 32 ms; the second probe
returned `1` after 233 ms. The exact child PID and native birth were captured,
and the child remained alive only 296 ms after listen. Thus the fixture had not
expired. Adding only a daemon accept/close loop made the same two probe
assertions return `0` in 33 ms and `0` in 32 ms. Every owned child was terminated
and waited in the reproduction's finally block. The erroneous production
mapping of this timeout to free is a separate case,
`2026-09-11-tcp-connect-probe-treated-errors-as-free-ports`.

Archive searches used `occupied port probe must exit 0` and `TCP listener fixture
sleep readiness lifetime lsof`. The September 8 Bash status case is a relative,
not a recurrence: the failure here precedes selection. The July 14 guessed
fixture-lifetime class was considered and excluded by the live-child timing.
The fixture was a listening socket but did not provide the repeated connection
behavior expected by its own readiness and assertion sequence.

Private evidence is in `.context/acceptance/cloudbench-listener-rca/`:
`replay.py`, `original.json`, `connect-ex-errno.json`, and the accepted and
saturated after-repair receipts. The initial isolated commands were
`python3 .context/acceptance/cloudbench-listener-rca/replay.py original` (failure)
and the same reproduction with the accepting fixture (pass). The real owning
suite already contains the repeated production probe assertion; it remains
unchanged in the repair.

## Solution

Accept and immediately close fixture connections in a daemon thread while
retaining `listen(1)`, the original two-second lifetime, readiness attempts,
200 ms probe timeout and both occupied-port checks. This repairs the fixture's
service behavior without adding wait time or changing production acceptance.
The fixture thread exists only for this local test and adds no production cost
at 10,000 agents.

The unchanged full native command `bash scripts/tests/cloudbench-env.test.sh`
passes with exit 0; `cloudbench-env-native-green.log` retains its complete output.
The independent adversarial review approved the source and causal evidence in
`independent-review.json`. The owning test runs through `scripts/test.sh` and
`/deploy` Step 4cb. The parent still owns the next committed full validation
loop and live fleet acceptance.

## Human feedback

The user required the fleet validation criteria to remain unchanged. The parent
required an isolated reproduction with the real production probe and explicitly
prohibited increasing the fixture lifetime or any timeout.

## Reusable lesson

A listener fixture probed more than once must consume its accepted connections rather than exhaust its own backlog during readiness.
