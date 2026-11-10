---
id: 2026-11-10-main-sync-fixtures-violated-sleep-ratchet
date: 2026-11-10
title: Main-sync test fixtures exceeded the newly enforced fixed-sleep baseline
surface: cross
component: scripts/check_test_sleeps.py and ten existing test fixtures
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Synthesizing main985's unchanged fixed-sleep checker and baseline with branch1c47's ten older or newly added timing fixtures
symptoms:
  - "FAIL: test files added fixed literal sleeps used as synchronization:"
  - "agents/benchmarks/wall_clock_backstop_test.py: 7 fixed literal sleeps, baseline 5"
  - "agents/tests/blackbox/browser_tilion.blackbox.py: 38 fixed literal sleeps, baseline 34"
  - "agents/tests/blackbox/jev_progress.blackbox.py: 2 fixed literal sleeps, baseline 0"
tags:
  - main-sync
  - fixture-contract
  - fixed-sleep
  - structural-gate
sources:
  - PR #1865
  - PR #1854
  - commit 1c47a9131d750ab72c2a756adc5ba12aa5c3667e
  - commit 985345c25d0e303f8f4a665451965d10de7af927
repro: python3 scripts/check_test_sleeps.py --root . --baseline scripts/test-sleep-baseline.json --base 985345c25d0e303f8f4a665451965d10de7af927
status: fixed
---

## Problem

Gate: INTRODUCED. Integrating main985345c25d0e303f8f4a665451965d10de7af927
into source1c47a9131d750ab72c2a756adc5ba12aa5c3667e exposed ten branch fixture
files above the new main's fixed-sleep baseline. The actual unchanged checker
returned1; this is an integration fixture defect, not a provider failure or a
reason to weaken the checker. No production agent self-report is involved.

The affected fixtures are wall_clock_backstop_test.py; blackbox browser_tilion,
jev_progress, spawn_browser_agent_v3 and worker; backend agent-tools-render,
browser-challenge-recovery-tilion-transport and browser-challenge-recovery-settle;
and scripts cloudbench-runtime-evidence-collector and run-bench-durable-service.
One shared contract change explains these ten files; their original behavioral
assertions are still required.

## Diagnosis

The first bad boundary is the merged test source against the newly enforced
count baseline. Main's checker correctly detects new nonzero literal delays;
the branch fixtures still encoded readiness as sleeps or expressed deliberate
slow work without naming its purpose. Archive searches for the exact emitted
failure and for merge/fixture/condition-wait symptoms found no case with this
first-bad boundary. The controller-clone admission-fixture case and the campaign
pidfile-read case are relatives, not recurrences of this sleep-policy failure.

A sparse scratch guard initially saw only controller and Tilion. Completing the
tracked test inventory exposed the other eight files. A separate broad candidate
directory overlay mistakenly included stale dependency copies and was rejected;
its logs remain diagnostic failures, not proof about the final candidate. The
final reproduction used every one of the2029 tracked test files from exact
1c47 Git blobs plus the103 upstream changed paths and three explicit conflict
resolutions, then an explicit ten-file candidate allowlist. Neither the primary
checker nor its baseline changed. The baseline SHA-256 is
01e1d607da501d98e210bae971ba154c6ac905ceb39c2cce3f89f51724c764fe.

## Solution

The external candidate replaces synchronization sleeps with canonical condition
waits or observable Events. Tilion retains its complete5s reconnect observation
window and50ms sampling. The worker still induces the same0.6s non-CPU stall,
with Events for a real monitor sample and its real lag warning. JEV retains its
2ms heartbeat measurement cadence and subtraction under a purpose-named constant;
a started Event replaces its startup nap. Renderer recovery waits for an exact
fixture console marker emitted immediately before the unchanged infinite renderer
loop, within the original0.25s bound, then runs the unchanged1.5s classifier.
Removing that marker still freezes the renderer but makes readiness reject with
TimeoutError, proving the wait observes the intended producer boundary.

Backend fixtures observe actual image/beacon/release state while retaining the
complete1500ms negative image observation and the separate1500ms document-positive
bound. An earlier one-frame candidate shortened that negative window and was
rejected; finalv2 catches a real illegal beacon arriving at1s and the original
image assertion rejects it. Script fixtures use the canonical wait and retain
their deliberate6.5s transfer stall. Their final scope predicate accepts only
recognized native inactive/failed/unknown state and exit-code pairs; eight controls
reject permission, transport and inconsistent responses. An earlier generic
nonzero-return predicate was rejected, not accepted as absence. The controller
fixture names deliberate0.05s slow-finalizer work and uses a next-tick yield for
repeated cancellation. Original assertions, acceptance bounds, production code,
benchmark task definitions and task inventories remain unchanged.

External verification: all4380 Python-agent assertion ASTs,460 Tilion assertions,
59 backend assertion ASTs and both script assertion AST sets are unchanged.
The exact three Python-agent owning tests pass; the two Tilion owning tests pass;
the controller's original28 plus both new finalizer tests pass30/30 and still
fail both regression phases on buggy controls. Backend settle3/3, registered
transport3/3 and the existing SVG helper's image/document controls pass. The
runtime collector full script and fake-systemd DurableLaunchContract3/3 pass;
real systemd unit-scope kill cases were not run in this preparation.

The actual whole-inventory checker then returns0:861 literal sleeps in274 files.
Its final receipt binds backend finalv2 and the scripts recognized-state
amendment; the earlier PASS belongs to superseded candidate bytes and is retained
separately under guard-versions/.
The scratch tree intentionally has no Git metadata, so its CLI reports skipping
the Git baseline check; independently, the unchanged native base_baseline helper
against the actual repository's985 object exactly equals the candidate baseline.
There is no increase, update, suppression or omitted tracked test scope.

Evidence and exact candidate hashes are in
/var/tmp/deploy-mf1108/rca-tilion-sleep985/whole-guard-final.json,
agents-final-proof.json, freeze-marker-negative.log, and ROOT-APPLY-ALL985.md;
the separate controller, backend and script proof.json receipts are linked there.
The fixture patch bundle is preparatory only. Keep status open until the parent
runs the original checker on the actual applied quiescent merged tree and records
that result; then it can mark this fixture repair fixed before freezing. All17
future full gates, including the new five-loaded-runs stability gate, remain
pending for the future source. Historical native FAIL/SKIP/UNVERIFIED observations,
cleanup debts and no-credit obligations remain unchanged.

### Exact target refresh before actual main integration

The required merge target advanced to f8c8255003d70ac639facf623b30397d62baf38a.
Its delta from985 contains47 changed paths, including real phone setup feedback,
sidebar actions/layout, signed-in desktop geometry and historical cleanup renewal
changes; it is not a history-ledger-only update. The external three-way merge
against unchanged1c47 has the same three conflict triples. All prior ordered
fixture/document patches apply textually; only the three exact conflict resolutions
are copied. In particular, use the Python-agent patch rather than its old complete
Spawn fixture: the new target adds two phone-feedback tests and registrations,
which the synthesized merge retains unchanged along with the old freeze test fix.

The new exact target's full tracked-test inventory (2030 files) also passes the
unchanged native checker:861 literal sleeps in274 files. The primary checker and
baseline are byte-identical to985, and the native repository Git-baseline check
is equal. This target-bound proof supersedes old985 applicability for integration;
it does not import ordinary native test or production acceptance credit. The new
upstream cleanup inventory-extension branch and three regression methods are
retained, along with all six original branch custody/debt AST pins and the typed
partial-admission blob. All215 original executable task rows remain exact and
both catalogs' quarantine metadata pass the native validator. Geometry runtime
and acceptance-test blobs match the actual target main, but no new browser or
full-DTC tests were run for this refresh. Future frozen-source gates remain pending.


### Actual quiescent integration verification, 2026-11-10

After native round36 terminated and every one of its17 executed smoke jobs
reported PASSED with resources_released and lifecycle_verified true, the deploy
owner applied the exact f8c825 main merge and all eleven hash-verified inputs
on the actual deploy checkout. The unchanged primary command was:

```text
python3 scripts/check_test_sleeps.py --root . --baseline scripts/test-sleep-baseline.json --base f8c8255003d70ac639facf623b30397d62baf38a
```

It exited0 and printed `test sleep ratchet OK: 861 literal sleeps in 274 files`.
The actual repository Git baseline check ran and accepted the unchanged baseline;
no scratch/no-Git exception was used. The exact apply and checker receipts are
main-sync-f8c825/actual-apply.json and actual-merged-guard.log in the retained
deploy evidence. This closes the introduced fixture-policy repair only.
The new frozen-source17-gate native cycle, five-loaded-run stability and
production verification still require their own actual receipts. Original
FAIL/SKIP/UNVERIFIED and cleanup/financial debts retain their native values.

## Human feedback

The user requested completion of /deploy. No incident-specific human correction
was recorded; the standing rules preserve assertions, timeouts and acceptance
criteria. Coordinator review required observable readiness rather than a renamed
synchronization timer and an unchanged primary baseline.

## Reusable lesson

Prevalidate every tracked test against a newly merged test policy using exact source bindings and an explicit fixture overlay allowlist before admitting the merged source to native gates.
