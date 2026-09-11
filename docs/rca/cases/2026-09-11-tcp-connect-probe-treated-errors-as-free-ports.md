---
id: 2026-09-11-tcp-connect-probe-treated-errors-as-free-ports
date: 2026-09-11
title: TCP hub probe classified connect timeouts and other errno results as free ports
surface: infra
component: cloudbench-tcp-listener-probe
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_tcp_listener_present mapped every nonzero connect_ex result to absence
symptoms:
  - connect_ex returns EAGAIN while an owned listener remains open
  - TCP probe returns 1 for a timed out connection instead of error 3
  - occupied port probe must exit 0
tags:
  - cloudbench
  - tcp
  - errno
  - fail-closed
sources:
  - PR #1299
  - commit 8fec27c4d80e54f44d25e930ebdbd3dff1999fd7
repro: scripts/tests/cloudbench-env.test.sh; scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

While reducing a native controller fixture failure, the real production TCP
probe returned `1` (free) for a socket that was still listening. A controlled
macOS listener with backlog one and no accept loop admitted the readiness
connection, then the second connection timed out. The separate fixture defect
is recorded in `2026-09-11-tcp-listener-fixture-never-drained-accept-queue`.
No live cloud port-allocation incident is claimed from this controlled test.

## Diagnosis

Critical path: caller → `cloudbench_tcp_listener_present` → Python
`socket.connect_ex` → exit status → central hub port selection. The helper
promised `3` for timeout or unexpected probe failure, but mapped every nonzero
integer returned by `connect_ex` to `1`. Unlike a raised exception, a returned
errno bypassed the exception handler. The selector correctly distinguished
`0`, `1` and errors; incorrect information entered at the probe result mapping.

The real backlog replay recorded first connection `0`, then `EAGAIN` (`35` on
macOS) after 226 ms, while the listener descriptor remained open. The production
helper returned `1`. The owning permanent test executes the helper's actual
embedded Python program with captured errno results: its EAGAIN assertion
failed with `(35, 3, 1)` before repair and passed unchanged afterward. Cases also
cover success, refusal, ETIMEDOUT, unreachable networks/hosts, permission errors,
and raised timeout/OSError. A companion selector assertion requires no selected
port when the probe reports `3`.

An additional argument-contract check failed for `-1` with expected `2`, actual
`3`. Numeric ports outside 1–65535 reached the socket operation instead of the
bad-argument boundary. Validation now rejects them before creating a socket;
noninteger arguments retain their existing behavior.

Archive searches were `occupied port probe must exit 0` and `TCP listener fixture
sleep readiness lifetime lsof`. The September 8 central-hub exit-status case is
a relative: that bug lost a correct probe result in Bash, whereas this one
created the wrong result in Python. The fixed-sleep and client-socket cases do
not explain the returned errno boundary.

Evidence under `.context/acceptance/cloudbench-listener-rca/` includes
`connect-ex-errno.json`, `permanent-errno-red.log`, `permanent-range-red.log`,
`permanent-range-green.log` and `real-backlog-after.log`. A first diagnostic
attempt used an unsupported macOS SO_ACCEPTCONN query and is excluded; the
successful replay checked the still-open, bound socket directly.

## Solution

Only an explicit ECONNREFUSED result means free; success means occupied; all
other errno results mean probe error. Keep the existing 200 ms socket timeout
and existing selector fail-closed behavior. This corrects one status boundary
without retrying, changing port allocation criteria, or adding another probe.
At 10,000 runs it adds constant local integer comparisons, no network calls,
shared state, storage, or fan-in.

The permanent controller test retains success/free/bad-argument and real
listener checks, adds errno/exception/range coverage, and asserts that probe
errors prevent selection. The real saturated listener now produces `3`, while
a listener that accepts connections produces `0` twice.

Independent review found a separate test-consumer defect in
`cloudbench-multi-workstream.test.sh`: generic nonzero checks accepted error
codes as absence, and owned-Hub records were deleted before the final port
check. Six absence predicates now require explicit `1`; pending-Hub cleanup
separately handles present, absent and error results. A present listener with a
verified different owner retains its existing handoff behavior. Owned-Hub
records and PID tracking are finalized only after every final port probe is
conclusive. These are fixture consumers, not production callers.

The permanent `listener_probe_status_contract` executes the actual extracted
allocation and cleanup functions with terminal process/group state and injected
probe codes. It failed on the original consumers for `3`, `2` and `127`, and
passed unchanged after repair. It verifies zero untracking and retained records
on failed checks, successful `1` cleanup, the distinct-owner `0` control, and
retention of both records and all tracking when two owner probes return `1`
then `3`. The contract runs unconditionally in the existing full suite; its
focused command is `CLOUDBENCH_TEST_LISTENER_STATUS_SELF_TEST=1 bash
scripts/tests/cloudbench-multi-workstream.test.sh`. Evidence is in
`.context/acceptance/listener-consumer-rca/proof.json` and
`permanent-{red,green}-final.log`. An earlier synthetic fixture shadowed its
injected status variable; the final unchanged fixture was rerun against the
original consumer snapshot for the recorded red, so that diagnostic mistake
is excluded. Independent review approved the final consumer repair. The
parent's full multi-workstream controller rerun is still required.

The full native `bash scripts/tests/cloudbench-env.test.sh` passes with exit 0;
its complete output is `cloudbench-env-native-green.log`. Independent
adversarial review approved the two-file repair and causal evidence in
`independent-review.json`. This owning suite runs in `scripts/test.sh` and
`/deploy` Step 4cb. The parent owns the next committed full validation loop and
live fleet acceptance; these local results do not claim that the fleet gate
has completed.

## Human feedback

The user required completion without weakening validation. The parent required
proof before changing production behavior, explicit refusal as the only free
result, and unchanged timeout bounds.

## Reusable lesson

Distinguish explicit connection refusal from timeout and other probe errors before declaring a port free.
