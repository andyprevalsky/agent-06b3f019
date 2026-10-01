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
  - "AssertionError: (11, 3, 0) after integration with upstream backlog classification"
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

### October 1 integration: stale backlog errno expectation

The final Linux Step 4cb command sequence on `28232da29` stopped in its first
command, `cloudbench-env.test.sh`, after 27.573 seconds with
`AssertionError: (11, 3, 0)`. All later commands remained unstarted. The exact
source, owner identities, failed aggregate and raw command output were retained
under `.context/acceptance/proof85-native-scenario3-rca/native282-stage1-failure/`.

This follow-up is a test-contract mismatch, rather than recurrence of the
original free-port bug. Upstream `c6ad9772b` deliberately classifies
EAGAIN/EWOULDBLOCK as occupied (`0`) because a full accept backlog still owns
the port. Integration retained that production behavior and the branch's older
expectation of probe error (`3`). Both policies reserve free (`1`) exclusively
for ECONNREFUSED. Other timeout, network, permission and socket failures still
report `3`; bad arguments still report `2`.

Archive searches were `AssertionError 11 3 0 TCP errno` and
`EAGAIN EWOULDBLOCK occupied accept backlog`. They found this case and the
related saturated-listener fixture case. The actual unchanged embedded test
block reproduced the stale expectation on Mac in 0.081 seconds with
`AssertionError: (35, 3, 0)`. Only the fixture now expects occupied for both errno
names; they alias to `11` on Linux. An adjacent control executes the actual hub
selector and requires a foreign occupied preferred port to be skipped before
choosing the next free port. The existing probe-error rejection, all exception
and argument checks, and every timeout remain intact.

The final permanent block passed against unchanged production on Mac in 0.076
seconds and Linux in 0.114 seconds. The same final block failed against the
actual historical runtime preceding `8fec27c4d` with
`AssertionError: (35, 0, 1)`, retaining protection against declaring a backlog
errno free. Production file hashes are identical before and after this fixture
repair; it adds no runtime work, model call or provider allocation. Exact
receipts and the focused runner are in
`.context/acceptance/proof85-tcp-errno-fixture-rca/`. The existing owning command
remains registered in `/deploy` Step 4cb and `scripts/test.sh`.

### Final native verification

The unchanged complete `cloudbench-env.test.sh` command passed on `0bf943c9`
in 27.131 seconds. The combined 13-command native verification subsequently
passed: eight original passes retain their actual source identity and an
independent unchanged-input audit, while the remaining five commands executed
on `58b56241`. The later changes affected only the separate fake IPv6 fixture
and its RCA; the TCP runtime and owning command stayed unchanged.

The full multi-workstream command passed in 1294.719 seconds, and the final
focused pytest command reported 288 passed cases. Original bounds were
preserved, source hashes matched before and after execution, and all recorded
native owners and sessions were absent. The combined receipt and independent
reviews are private under
`.context/acceptance/proof85-native-multi-final-rca/`. This closes the TCP
regression without granting live fleet acceptance credit.

## Human feedback

The user required completion without weakening validation. The parent required
proof before changing production behavior, explicit refusal as the only free
result, and unchanged timeout bounds.

For the October 1 integration, the parent required preserving the upstream
occupied-backlog policy, retaining all failure and identity assertions, and a
small focused fixture repair without another broad coverage rerun.

## Reusable lesson

Distinguish explicit connection refusal from timeout and other probe errors before declaring a port free.
