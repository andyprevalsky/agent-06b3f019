---
id: 2026-10-20-native-stop-fixture-request-count-intermittent
date: 2026-10-20
title: Bounded native-stop fixture intermittently sent two requests while asserting three
surface: agents
component: cloudbench native-stop regression fixture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[stop-always-fails] observed two fake stop calls before its unchanged six-second shared deadline; it asserted three"
symptoms:
  - "AssertionError: assert 2 == 3"
  - "benchmark-live-results structural gate failed with 1099 passed and one failed"
tags:
  - benchmark
  - deploy
  - fixture
  - deadline
  - native-stop
sources:
  - benchmark run 20261020-013350-3832649 resumed A3 deploy structural gate
  - commit 5bd3a3d44 merge of approved browser repair and main 33d096476
  - agent 915ab997-c174-4297-80ac-15347120342f investigation evidence .context/rca-915ab997/A3-native-stop-diagnosis.txt
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified
status: open
---

## Problem

The resumed browser deploy's Group 3 structural run failed the
`stop-always-fails` parameter. The selected benchmark-live-results gate reported
1 failed, 1099 passed and 4 skipped in 787.34 seconds. No runtime change was
made to the native-stop implementation or test. This is a local fake-provider
fixture failure, not a new production native-stop incident.

## Diagnosis

The original fixture's retained fake call log contains two exact
`machine stop deadbeef000001 -a bench-app` calls. Its receipt reports
`stop_requests=2`, `verified=false`, `verified_state=started`, requested epoch
1792531614 and verified epoch1792531619. The fixture's total phase budget is
six seconds, each provider call is bounded by two seconds, and the enclosing
wall bound is fourteen seconds. The failed assertion required three requests;
identity, failed outcome and retained ownership checks did not fail.

The implementation shares one absolute deadline across ownership preparation
and verification, then spaces bounded retry requests. The original run did not
capture per-operation scheduling/timing, so it does not prove whether process
startup, host scheduling, deadline granularity or another operation consumed
the missing attempt's interval. Host-load attribution remains a hypothesis.

Literal archive search used the exact test name and returned no prior case.
Behavior search used `native shutdown retry deadline request count`. The full
Solution and Human feedback of the related
`2026-10-12-group-term-killed-guest-shutdown-proxy-before-delivery` case were read.
That case repaired transport/cancellation ownership defects and established this
fixture; it does not establish the cause of this intermittent count mismatch.

## Reproduction and verification

Original command: `python3 scripts/run-deploy-structural-gates.py`, on the
merged source above with concurrent qualified Group 3 suites. Original complete
log is retained in the existing deploy run. The failed fixture's receipt and
fake call log are copied under `.context/rca-915ab997/A3-native-stop-failed-fixture`.

From the isolated deploy checkout's `agents` directory, the exact parameter:

```bash
./venv/bin/python -m pytest -q 'benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[stop-always-fails]'
```

passed unchanged in 5.88 seconds. This does not reproduce the original miss and
is not a causal fix proof. The unchanged full failed gate subsequently passed: 1100 passed, four skipped,
1242 deselected in 549.25 seconds. Its result remains separate from the
original failure. Sixty other original structural branches passed and were
retained without duplicate execution. `A3-structural-recheck-receipt.json`
binds the original and rerun log hashes and verifies only documentation
changed between these source snapshots. Existing permanent test
coverage is retained. No bounds, assertions, retries, source or schemas changed.

Independent read-only review subsequently ran four unchanged bounded parameter
trials: PASS 6.82s, 6.82s, 5.82s and 5.78s, all with three actual requests.
A private trace of the final passing trial showed first/second/third sends at
+0.146s/+1.285s/+2.384s and budget exhaustion at +5.507s. This confirms the
passing shared-budget path; it does not attribute the original missing send.
The original provider call log lacks per-call timestamps and the failed
assertion did not retain captured subprocess stderr. The independent report
`A3-native-stop-independent-RCA-result.txt` and compact
`A3-reviewer-native-stop-evidence.json` preserve these limits. No controller
correctness defect or causal repair was established.

## Solution

Unresolved. Retain the failure and exact ownership receipt; do not label a
passing isolated rerun as a repair. A future recurrence needs per-phase timings
and actual attempt instants before changing the implementation or fixture.
No native Fly resource, original browser or production agent was mutated by
these tests.

## Human feedback

The active assignment requires preserving original failed proof, narrowing
failed gates promptly, and keeping timeout bounds and assertions unchanged.
No human feedback establishing a cause or approving a native-stop change was
recorded.

## Reusable lesson

A maximum retry count inside a shared deadline is distinct from proof that all
attempts ran. Preserve both the actual request count and the original deadline
before attributing an intermittent fixture failure to scheduling.

## Recurrence during PR1562 qualification (2026-10-21 UTC)

The unchanged final runtime at `36fa3174f7887b04572671aad44545e97905c971`
reproduced the same assertion in the deployment structural gate: 1099 passed,
one failed, four skipped, 1242 deselected in 683.42 seconds. The original log
is retained at `.context/stuck-report/combined-static.log` (owning stage log
`.context/deploy-runs/20261020-215955-987042/logs/deploy-command-structural-20261021-004804-3829816.log`).
It records two exact fake stop calls against the unchanged six-second deadline.
The temporary fixture had already been removed by pytest retention before
collection; no original per-phase timing or stderr is available. Two superseded
structural runners overlapped the early part of this run and were stopped by
exact owned PID, but that observation does not establish causality.

The exact unchanged parameter passed in 5.83 seconds; its retained log is
`.context/stuck-report/native-stop-recheck.log`. The unchanged owning suite subsequently passed: 1100 passed, four skipped,
1242 deselected in 556.75 seconds (`.context/stuck-report/native-stop-owning-suite.log`). No runtime implementation, assertion, deadline, retry policy
or remote resource was changed. This recurrence remains unresolved, not fixed.

## October 27 causal observer reproduction and correction

Fresh deploy qualification on8b1c38ff reproduced two exact stop requests and
5.342553556 seconds of outer Python elapsed time, failing the assertion that
required three requests or at least six elapsed seconds. Native ownership
retention and false verification were preserved. This was not a violation of
the independent fourteen-second wall ceiling. Original per-call timings remain
unrecorded; no original scheduling-delay cause is inferred.

A controlled finite1.1-second local fake stop reproduced the same assertion
with each stop under its unchanged two-second call bound. The native phase's
Bash SECONDS clock reached six while outer continuous elapsed was5.64 seconds.
The fixture had compared different clocks. It now records the native phase's
own SECONDS delta around the call and uses that clock solely for deadline
exhaustion. The six-second phase, two-second call, fourteen-second wall and
thirty-second subprocess limits, three-attempt cap, exact identities and all
retention/no-destroy/verification assertions are unchanged. Runtime code is
unchanged.

Same-command controlled red became green with the corrected observer. Five
consecutive candidate runs passed with two stops, native_seconds6 and outer
elapsed5.618–5.643 seconds; all nine native scenarios plus counts-only-sent
passed. Adversarial wrong-ID and real20.622-second overrun controls still fail.
A premature two-request return plus six seconds of unrelated shell startup
passed the old observer but fails the corrected one with native_seconds4.
This distinguishes phase exhaustion from unrelated elapsed time.

Evidence and exact candidate diff are retained under
.context/deploy-fresh-20261027/rca-native-stop. All launched test commands were
joined;1330 traced PIDs had zero survivors. No live Fly resource was touched.
The correction is applied; this case remains open pending the parent-owned
complete canonical structural gate on the combined source.


## Full native owning-domain verification on October 27

The committed correction at46bfbfb5 passed the full benchmark-live-results suite in the canonical67-suite command gate. Two separate suites failed; this receipt establishes the corrected native-stop owning suite, not a green whole-deploy gate. The exact original per-call timing gap remains documented above.

The older October20/21 exact timing remains unresolved; its classification and open status are retained. The proven October27 clock-observer correction and current native owning-suite pass do not manufacture the older missing operation timings.
