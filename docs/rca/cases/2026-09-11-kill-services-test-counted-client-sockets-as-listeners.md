---
id: 2026-09-11-kill-services-test-counted-client-sockets-as-listeners
date: 2026-09-11
title: Service cleanup test counted a foreign client socket as a surviving listener
surface: harness
component: kill-services-structural-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the final test port assertion queried every socket endpoint instead of TCP listeners
symptoms:
  - worktree service port 62000 is still occupied
  - owned service PIDs are dead but a foreign CLOSE_WAIT client still matches lsof
tags:
  - lsof
  - tcp
  - close-wait
  - kill-services
  - structural-test
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: scripts/tests/kill-services.test.sh
status: fixed
---

## Problem

The parallel structural gate reported four service PIDs killed, then failed
with `worktree service port 62000 is still occupied`. Its exact owned-listener
and cwd-only PID death assertions had already passed, as had the foreign
listener survival assertion. The old EXIT trap deleted the fixture directory
without retaining the socket that matched the final check.

## Diagnosis

The test used `lsof -ti :PORT` for allocation, readiness and its final check.
That query matches both local and remote socket endpoints, including clients
that are not listening. Production service discovery already restricts the
query to TCP LISTEN sockets. Killing a foreign client to satisfy the broader
test would violate the service ownership contract.

A new deterministic fixture connects a foreign client to the owned HTTP
listener and keeps the client socket open. After real service cleanup, both
owned PID assertions pass and the client remains alive. The unchanged final
port assertion fails; retained lsof evidence identifies only that client's
remote endpoint on port 62000, in CLOSE_WAIT. Changing readiness and shutdown
queries to TCP LISTEN makes the same fixture pass, preserving every original service and
foreign-process assertion. This proves the test contract defect. It does not
identify the unretained socket in the original concurrent failure.

The original unmodified test also passed in an isolated native snapshot. A
separate semantic-deploy failure, `evaluated agent lifecycle states were
classified as infrastructure`, could not be reproduced by its enclosing native
fleet proof fixture, which passed all 14 cleanup cases. That fixture uses
PASSED/FAILED evaluator outcomes with separate ACTIVE/PAUSED agent states; it
does not use SKIPPED. Its original inner log was deleted, so its causal boundary
remains open. No canonical classifier, timeout or SKIPPED criterion changed.

Archive searches used `worktree service port still occupied lsof kill-services`
and `evaluated agent lifecycle states classified infrastructure semantic deploy
fixture`. The September 4 pipefail case concerns an earlier list-output assertion,
which already passed here. It does not explain this socket boundary.

Private evidence is under
`.context/acceptance/static-gate-followup-rca/`: `kill-services-client-red.log`,
the accompanying retained `port-sockets.txt`, `kill-services-client-green.log`,
`kill-services-unchanged-snapshot.log` and
`fleet-proof-unchanged-native.log`. An earlier diagnostic attempt edited a shell
file while it was still being read and produced a syntax failure; it is
explicitly excluded in `excluded-diagnostic-attempts.json`.

## Solution

Use `lsof -tiTCP:PORT -sTCP:LISTEN` for readiness and shutdown assertions. Keep
the conservative allocation query unchanged: a client bound locally to a port
can still prevent a new server from binding it. Keep the new foreign client
alive through the final assertion and retain the owned PID death checks.
The full native kill-services suite passes with the new socket fixture.

Both the kill-services and fleet-proof fixtures now retain failing temporary
directories beneath `BLACKBOX_TEST_ARTIFACT_DIR`, falling back to
`.context/test-runs`, with suite, timestamp and PID in the directory name.
Capture is private and best effort, preserves the original exit status, and
does not prevent normal cleanup. The kill-services capture includes socket
state. The next enclosing parallel gate remains necessary to observe any
recurrence of the original semantic failure.

## Human feedback

The user required owned services to be removed without killing unrelated
processes, and prohibited weakening SKIPPED handling, timeouts or benchmark
criteria. The repair changes only the fixture's socket classification and
failure observability.

## Reusable lesson

Assert service shutdown using listener state and exact owned PID identity while preserving unrelated clients.
