---
id: 2026-10-17-projection-fixture-executed-persistent-publisher-driver
date: 2026-10-17
title: One-tick publication fixture executed the persistent fleet publisher driver
surface: harness
component: benchmark-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: test_fleet_publishes_evaluation_before_teardown executes the complete persistent Python heredoc with subprocess.run while asserting one-tick terminal exit zero
symptoms:
  - evaluated_fleet_outcomes_publish_before_teardown failed in the fresh agents coverage gate
  - subprocess.TimeoutExpired after 30 seconds in test_fleet_publishes_evaluation_before_teardown
  - Hub upload and in-app registration succeeded before the projection fixture timed out
  - 111 blackbox domains returned 110 passes and one benchmark failure
tags:
  - cloudbench
  - fixture-lifecycle
  - persistent-publisher
  - source-extraction
sources:
  - commit 2a798afc5f2d3147e27af5ea488baa5d600cc48d
  - commit 201226d3cfee46b7ad6abea2397e2332676d3c74
  - plan:.context/auth-deploy/repair-next-primary/aggregate-tick-fixture-2a798-rca
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_publishes_evaluation_before_teardown
status: open
---

## Problem

The fresh immutable `2a798af` full agents gate returned 110 passing blackbox domains and one failed `benchmark` domain in 302.5 seconds. The enclosing run joined with exit one after 506.318 seconds. Its later cache, unit, and coverage-report phases were unentered because the canonical coverage shell stops on the blackbox failure. Browser and auth-handoff domains passed separately; those passes do not repair the benchmark failure.

The retained owning failure is `test_fleet_publishes_evaluation_before_teardown`, reached by the existing registered `evaluated_fleet_outcomes_publish_before_teardown` wrapper. Its first projection calls `subprocess.run(..., timeout=30)` on the entire real fleet aggregation heredoc. That subprocess does not terminate. The failure includes successful Hub upload and registration before `TimeoutExpired`; a generic timeout or failed payment message elsewhere in the same domain is not the first bad boundary.

## Diagnosis

The immutable producer moved the recurring owner from a Bash loop around one-shot Python into one persistent Python process. The real heredoc now defines `aggregate_tick()` and ends with `while True`, a guarded tick, and the same one-second post-tick delay. Its source matches the integrated upstream bytes; this investigation does not classify that deliberate persistent owner as a runtime defect.

The projection fixture retained the old assumption that extracting the whole heredoc yields exactly one projection followed by exit zero. It therefore accidentally executes lifecycle supervision when it only owns per-tick outcome projection. Every finite timeout would reject that correctly persistent driver. Increasing the 30-second bound, adding a product one-shot flag, or stopping the production publisher would repair the wrong layer.

The path is real fleet source -> heredoc extraction -> projection fixture subprocess -> real loopback Hub projection -> expected terminal subprocess result. The Hub handoff is positive counterevidence to a publication failure. The earliest wrong contract is using the persistent driver as a one-tick fixture entrypoint. The deeper owned gap is an extraction fixture coupled to a mutable enclosing lifecycle rather than the existing pure tick boundary. Removing that extraneous lifecycle from this test is smaller than adding a runtime mode or alternate projection implementation.

Two exact-source archive searches used `aggregate_tick|persistent.*publisher|one.shot.*fixture|fixture.*one.shot` and `evaluated_fleet_outcomes|fleet_publishes_evaluation|heredoc.*loop|loop.*heredoc`. Earlier working-tree archive searches were explicitly qualified as the older 857-case archive. Relevant Solution and Human feedback sections were read. The October 5 `outcome-blackbox-repeated-whole-deploy-control-suite` case concerned the same outer test but a different first boundary: duplicate execution of an unrelated growing suite. Its direct two-owner registration remains intact. The September 9 terminal projection case guards preserved stages and is unchanged. This is a distinct lifecycle-extraction incident, not evidence that either prior correction was undone. The large-catalog host-guard case is a counterexample to treating every timeout as slow finite work: this driver is intentionally unbounded.

AST test techniques were checked in `hermes-agent/tests/test_no_shadowed_test_definitions.py` and `codex/sdk/python/tests/test_artifact_workflow_and_binaries.py`. No exact persistent fleet fixture analogue was found in the bounded Python-test search of `claude-code-src` and `openclaw`; no reference repositories were cloned or changed.

## Solution

The proposed private patch adds nine lines only inside the existing projection test. It parses the real heredoc, checks that its final driver is `while True`, its first guarded action is the actual `aggregate_tick()` call, and its final delay is `time.sleep(1)`. Only in this fixture's execution module, it replaces that final driver node with one explicit `aggregate_tick()` call. All actual imports and the complete production tick-function AST remain identical. Unexpected driver shapes fail the fixture instead of silently selecting another path.

Every original assertion, the real Hub HTTP handler, initial running/evaluated values, deduplication, changed failure publication, teardown/released transitions, and the original 30-second bound are preserved. All 3,042 assertion AST multiplicities in the permanent test file remain; three guard assertions are added. The existing permanent blackbox already discovers this exact pytest node and its cleanup companion. Neither the wrapper nor `benchmark.run_all_tests` was invoked privately; that registrar starts unrelated native helpers before recording its controls.

The exact unchanged owning pytest command failed on the baseline with the reported `TimeoutExpired` and passed after the fixture-only correction:

`/home/boxes/rose-auth-control-deploy-verification/agents/venv/bin/python -m pytest -q <private-physical-overlay>/agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_publishes_evaluation_before_teardown -p no:cacheprovider --basetemp <private-artifact-root>/fixture-current`

Baseline: normal join, exit one, 34.570 seconds, original inner timeout 30. Candidate: normal join, exit zero, 4.924 seconds. Both use identical argv and real source under the same private physical overlay. Exact source/module hashes and logs are retained. The fixture's temporary directory from each side is retained separately. Eight pure controls additionally verify unchanged imports/tick AST, rejection of a nonpersistent driver, wrong invoked owner, or changed delay, and three persistent-driver iterations after success, `ValueError`, `SystemExit(0)`, and `SystemExit(2)`. Those driver controls substitute a fixture tick only to test scheduling; they are not a second claimed real Hub or cloud outcome.

A private socket guard propagated into subprocesses permits only the current fixture's declared loopback Hub host and exact port. Both selected pytest runs had zero denied-address rows. They performed real owned loopback HTTP; this is not a claim of zero network activity. There were no model/provider/backend APIs, cloud resources, native benchmark tasks, or current-run interventions. One private-driver `SyntaxError` occurred before any subprocess creation, was retained, and was corrected only in driver result serialization; it is not counted as the causal RED.

The production fleet, all other source files, current checkouts, Git refs/index, task definitions, evaluator/fixtures, prompt/model/caps, and native/controller lifecycle are unchanged. This adds no per-agent or 10,000-agent runtime work. Test work adds one local AST parse of the existing heredoc; no service, polling loop, global state, or funding call is introduced.

This case remains open because the patch is private and unapplied, and the full owning benchmark domain and subsequent canonical agents gate have not run on the future integrated source. The original full agents gate remains failed. The current unchanged native original30 run is separate and receives no semantic credit from these fixture checks. Future root source review, canonical archive regeneration/validation, normal affected gates, and unchanged full30 outcome requirements remain mandatory.

## Human feedback

No new incident-specific human feedback was recorded. Standing process feedback requires preserving acceptance criteria and forbids relaxing a timeout to make a failure pass. Parent-agent scope limited this work to private test-only reproduction/correction, preserving all original assertions and the healthy frozen native/G3 consumers; that execution scope is not represented as a new human instruction or deployment grant.

## Reusable lesson

Exercise an existing tick function when testing one projection, and validate the enclosing driver shape instead of waiting for an intentionally persistent publisher to exit.


## 2026-10-17 recurrence: complete projection-consumer class

The first nine-line private correction above was too narrow. It repaired only the publication-before-teardown projection test. The actual whole command registry later remained inside `test_live_response_preserves_phase_and_startup_label_with_stable_fleet_timestamp[aggregate]`: that fixture also executes the entire persistent Python heredoc, through Bash, but its `subprocess.run` has no timeout. Source audit identified a third affected consumer, the six parameterized terminal-startup projection cases in `hub_upload_test.py`, whose direct Python subprocess likewise had no timeout. These are the same extraction/lifecycle boundary, not a new financial, timer, or production-publisher defect. The separate direct `cloudbench-aggregate-runs.py` callers are one-shot owners and are not part of this correction.

A superseding private test-only candidate uses one shared `fleet_aggregate_fixture.py` helper in all three projection consumers. It validates the actual final persistent while/try/exception-handler/tick/delay shape, derives one actual tick, and verifies that every preceding import and function AST survives serialization unchanged. Both previously unbounded Hub subprocess calls receive a finite 30-second fixture bound. The original 3,042 dependency-test and 112 Hub-test assertion AST multiplicities remain identical. Eight shared helper guards are added. Production `run-bench-fleet`, its persistent driver, the separate persistent-aggregator lifecycle regression, native tasks, model inputs and caps remain unchanged. The lifecycle regression continues to own multiple ticks, retry and exact-owner stop; it is not converted to a projection test.

The same eight selected permanent projection cases were executed against exact immutable `2a798af` physical source and the superseding candidate with a secretless fixture boundary and inherited deny-by-default network guard allowing only the declared loopback Hub port. The corrected original baseline produced eight genuine 30-second persistent-driver timeout failures and normal joined exit one in 246.360 seconds. The candidate passed all eight, normal joined exit zero in 15.309 seconds. A private reproduction observer uses regular files instead of inherited capture pipes and, only after its 30-second observation expires, sends one SIGTERM to the exact newly recorded persistent Python identity and joins its parent. All eight corrected baseline owner stops are recorded. The candidate needs no such signal. This is test-fixture custody, not a native deadline change or permission to stop an unrelated process.

The first class baseline attempt is retained separately: one real dependency timeout and seven invalid private-observer setup failures because the observer initially required text output while the Hub fixtures correctly requested bytes. The observer was corrected to preserve both modes; no production or permanent test source was changed to repair that setup. A later private proof-writing attempt encountered an incidental private `__pycache__` directory; the corrected manifest selects source files only. Neither setup failure counts as the causal RED.

Actual logs, module hashes, selected argv, source/assertion proofs, guard records and exact recorded-identity cleanup are retained under the private `aggregate-projection-class-2a798-rca` packet. Five additional pure adapter controls verify actual imports/tick preservation and rejection of finite, wrong-call or changed-delay drivers. Independent source review accepted the three-consumer correction. No full benchmark registrar, funded/provider/model/DB/native calls or current-run interventions occurred. No denied external connection rows were observed; actual loopback HTTP did occur. The original canonical 110/111 agents result and incomplete cache/unit stages remain failed/unentered. This recurrence adds no canonical case or changes the OPEN status. Complete future-source gates and the unchanged native original30 requirement remain pending; there is no production-lifetime or native-cure claim.
