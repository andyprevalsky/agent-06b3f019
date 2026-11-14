---
id: 2026-09-11-concurrent-local-payment-fixtures-share-one-world
date: 2026-09-11
title: Concurrent local payment fixtures overwrite setup state before agent creation
surface: harness
component: local-benchmark-world-ownership
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/local.py main allocates one ServiceStack for concurrent mutable fixtures
symptoms:
  - Expected agentcard_user_cardholder_onboarding_required attention request was not observed
  - AgentCard setup attention sequence mismatch
  - expected payment_approval and agentcard_user_cardholder_onboarding_required but got only payment_approval
tags:
  - agentcard
  - benchmark-fixture
  - concurrency
  - local-stack
  - ownership
sources:
  - PR #1299
  - commit 30deba8a4fdc0e45d8be50844a510795cf5c4a02
  - commit 8c8e19bb65759ca0683d36177a19f77d7c42fd45
  - agent bf0e8691-4258-4725-8806-89be0552cdf0
  - agent 67b11906-333d-4cfb-bbd7-40c13ca671ba
  - agent 67c299dc-62a9-4a0c-9eda-5e54a76c1fe4
repro: agents/benchmarks/local_worlds_test.py
status: fixed
---

## Problem

The unchanged local predeploy smoke invocation on 2026-09-12 UTC passed seven
of eight first-batch tasks. `agent-payment-setup-resume` failed after 227.5s:
its checkout completed, but the required onboarding attention request never
appeared. Its sibling `agent-payment-abandonment` passed. The separate canonical
AgentCard lane passed all four tasks, including setup-resume in 187s.
The cached mass-agent smoke was not reached after the failed first batch.

Failed task: https://www.roselabs.ai/?agent-id=bf0e8691-4258-4725-8806-89be0552cdf0
Passing comparison: https://www.roselabs.ai/?agent-id=67b11906-333d-4cfb-bbd7-40c13ca671ba

All twelve roots have verified durable FE/LLM bundles. Both owned local stacks,
55 captured native processes, their exact Docker databases/volumes, and nine
Kernel browser sessions were independently confirmed retired. Payment snapshots
show sealed/deleted roots and terminal cleanup. No foreign resources or shared
provider cardholders were modified during diagnosis.

## Diagnosis

The smoke backend recorded fixture reset HTTP 200 at 05:28:18.033Z and created
the failed root at 05:28:18.260Z. A competing complete request began at
05:28:18.026Z, completed at 05:28:22.901Z, and wrote the same user's AgentCard
Integration row. The failed root's first mint returned 200 at 05:30:06.981Z.
The passing comparison instead received mint 409, raised the onboarding
attention request, completed setup, and then minted successfully.

`local.main` created one ServiceStack for the cohort. Its real parallel scheduler
ran reset and complete fixtures on the same backend/user. Both backend repo
paths upsert the unique `(userId, name, accountId)` Integration row; complete
awaits provider resolution before overwriting reset. The first bad boundary is
the launcher's shared world, before model execution. Attribution of the
competing complete request to the abandonment task is a source/log correlation;
the requests lacked an explicit task tag. The same-user writes and direct mint
are independently observed. All three canonical diagnostics were run on both
failed and passing roots; only the passing root contains onboarding attention.

Archive searches used the exact missing-onboarding error and the behavioral
query `parallel payment setup resume fixture user cardholder isolation`.
The closest case, `2026-09-03-shared-agentcard-cardholder-contention-closes-card-mid-checkout`,
is a relative with a distinct external shared-cardholder boundary. Local database
isolation does not solve that external contention, and this case does not claim it.

The permanent owning-launcher probe was executed before implementation:
`agents/venv/bin/python agents/benchmarks/local_worlds_test.py replay <artifact-dir>`.
It drives actual local.main, argument parsing, stack identity, native child
processes, LocalBenchmarkOwner, task scheduling, and setup HTTP transport. Only
external services/database/provider work and agent creation are modeled; the
probe stops at create_agent. Both actual tasks overlap in the RED replay, but
share one backend and lose reset state. The single-task control passes.
Cancellation also reproduces the state collision while preserving cleanup order.

Baseline receipt: `.context/acceptance/private-source-group4-diagnostics/local-worlds-permanent-before/result.json`.
The unchanged assertions pass after the fix in `local-worlds-permanent-after-3/result.json`:
single, pair, and cancelled pair all green; event spans were 0.436s, 0.479s, and
0.514s respectively. Every fixture process was verified absent afterward. The final strengthened
replay also verifies distinct backend/database/queue identities and original
cohort settings for every child; all eight assertions pass for all three cases.
Ten additional controls cover task/post-run failure propagation, malformed or
foreign results/cleanup, duplicate occurrences, scheduling/SMS, queued
cancellation, options/cohort configuration, identity/journal admission failures,
the actual child admission boundary, startup interruption receipts, and broken
console consumers during child retirement. The latest native launcher replay,
`local-worlds-after-relay/result.json`, passes all 24 assertions with all three
fixture cleanup receipts verified.
These are causal boundary results, not a replacement for live benchmark outcomes.

## Solution

`local_worlds.py` retains the existing scheduler and delegates each task in a
conflicting cohort to a canonical local.py child with its own backend/database,
queue, context directory, and cleanup authority. It derives conflicts from the
existing fixture actions rather than a new task-name list. Serial payment lanes
and non-conflicting selections retain their existing path. Every child receives
the original cohort's environment/service settings; benchmark definitions,
concurrency, evaluators, and timeouts are unchanged.

The coordinator journals native child identity before allowing service
allocation through a pipe handshake. Cancellation stops admission, signals only
owned children, and joins the canonical agent-then-stack drain. A result is
accepted only with matching task occurrence, file hash, root cleanup receipt,
and exact stack cleanup receipt plus process retirement. Early cancellation
can prove the benchmark never started, but still requires stack cleanup.
Shutdown uses the existing child owner deadlines; unverified cleanup remains
failed with retained recovery metadata.

Removing the shared mutable world prevents sibling fixture overwrites.
Deleting the fixture would remove the assertion under test, and merely adding a
setup HTTP lock would release before the task's onboarding flow. Serializing
payment tasks would change the required concurrent workload. Independent
canonical child stacks preserve the tested contract and reuse established
cleanup instead of inventing resource-specific teardown. At large selection
sizes, only the existing concurrency width is active; queued occurrences have
no services. Per-task stacks increase local resource use, which the real smoke
rerun must validate.

Review also reproduced identical task runs overwriting the same second-based
result filename. `BenchmarkRun.save` now includes its stable run ID in the
bounded filename. `results_identity_test.py` records actual fixed-clock RED to
GREEN with history and Hub side effects disabled, including long and UTF-8 names.

The complete unchanged local predeploy invocation passed all nine tasks on
`8c8e19bb65759ca0683d36177a19f77d7c42fd45`, with concurrency two and the original
cohort settings. Run `20260912-063339-5919` finished at 07:02:47Z on September 12.
Setup-resume passed in 224.7s:
https://www.roselabs.ai/?agent-id=67c299dc-62a9-4a0c-9eda-5e54a76c1fe4.
The separate AgentCard lane passed all four tasks, including setup-resume in
198.4s. The mass-agent smoke passed with all 51 archived agents completed and
sealed/deleted; its workload and evaluators were unchanged.

All thirteen benchmark roots have verified durable FE/LLM bundles. Independent
checks confirmed all ten owned benchmark stacks retired, 763 captured native
process identities absent, and all nine exact Kernel sessions absent. One
evidence publication encountered an SSL transport error; one canonical
idempotent publication retry succeeded without rerunning a benchmark. The
original failed publication receipt remains preserved. The full validation
receipt is `.context/acceptance/local-worlds-group4-final-verification.json`.

The separate 10-by-10 cloud stability acceptance remains unfulfilled; no local
fixture or smoke pass counts toward it.

## Human feedback

### September 30 fixture maintenance

The deploy-owned offline fixture still required setup/resume to overlap another
payment task after production scheduling made setup/resume exclusive. Its writer
barrier therefore timed out; duplicate-occurrence coverage also incorrectly
expected input order to equal execution order. Scheduling and task sources were
byte-identical to e7ad0782. The isolated ordinary-pair control reproduced the
actual same-user collision when independent-world admission was absent.

Keep the existing serial setup control and add an exclusive pair with an exact
setup-before-ordinary event assertion. The mixed cohort then verifies setup
finishes before two ordinary payment tasks overlap in separate worlds, with
opposing fixture writes through the actual setup HTTP helper. Cancellation waits
only in that ordinary phase, preserving the all-task observation barrier and
exact child cleanup. Duplicate reports retain input order and unique occurrence
identities; their execution follows the existing exclusive phase. No production
task, fixture, evaluator, scheduler or timeout changed.

`cd agents && source venv/bin/activate && python -m pytest
benchmarks/local_worlds_test.py benchmarks/local_worlds_controls_test.py -q`
passes all 12 controls in 12.93 seconds. Earlier unchanged gates that launched
bare subprocess `python3` failed against an unconfigured asdf shim. Activating
the venv makes the original private-source, runtime-evidence and dependency
gates pass in 14.1, 48.4 and 33.0 seconds with their watchdogs unchanged.
These offline maintenance results earn zero cloud-slice credit.

The user directed the work to continue autonomously, requested ten consecutive
cloud slices of ten outcomes with no infrastructure failures, and required a
temporary five-minute cloud proof backstop while retaining the normal 120-minute
backstop. No task or evaluator weakening was requested.

### October 1 external-resource admission fixture maintenance

Main integration introduced serialization for tasks tagged
`agentcard-lifecycle-sandbox`, including the ordinary pair used by this offline
fixture. The real scheduler correctly waited for the first payment task to finish,
while that task's fixture writer waited for its sibling. The private HTTP servers
share no external cardholder, so retaining that catalog resource claim misrepresented
the fixture. This is a recurrence of fixture admission drifting from the modeled
resource boundary, not evidence that the production payment lock is wrong.

The merged coverage run passed 103 of 104 agent domains; the benchmark domain
exhausted its unchanged 300-second budget after reporting this fixture failure.
The single and exclusive controls passed in the focused reproduction; the ordinary
pair failed and cancellation never reached its observation barrier. Searches for
`Local fixture world isolation failed` and `parallel fixture worlds benchmark
controller scheduling` led back to this case and the September 30 judge-scheduling
case. The original private results and exact process-cleanup receipts are retained.

Fixture-local dataclass copies now remove only the shared external sandbox tag at
both the coordinator and benchmark-child task lookup. Every other task field and
the production catalog stay unchanged. All eight original lifecycle assertions
are AST-identical, including overlapping task lifetimes, independent backend/
database/queue identities, cohort configuration, and cleanup before stack stop.
A small control also runs the actual scheduler with the original production tags
and requires peak concurrency one, preventing a removed payment semaphore from
silently satisfying the offline fixture.

The identical focused command, from `agents/` with its venv activated,
`python -c "from benchmarks.local_worlds_test import test_local_parallel_fixture_worlds; test_local_parallel_fixture_worlds()"`,
failed before the fixture correction in 33.550 seconds and passed afterward in
21.380 seconds. This corrects the fixture's resource metadata; it is not an
unchanged-artifact proof of a production behavior change. The unchanged lifecycle
assertions remain the acceptance predicate. No timeout, task, evaluator, provider
behavior, or cloud acceptance requirement changed. These results grant zero
cloud-slice credit. Only the failed benchmark domain and unfinished coverage tails
need rerunning; the 103 successful domain receipts remain intact.

## Reusable lesson

Give concurrently mutated benchmark fixtures separate owned worlds and bind every result to its actual run identity.


## 2026-11-09 child fixture and cleanup boundaries

An independent new-user child still inherited its full cohort when deciding
whether to seed regular payment billing. That could bind the configured v2
provider user to the admin fixture before the synthetic new user attempted its
exclusive binding. A native `local.main` regression consumes the coordinator
handshake and intercepts the actual seeder subprocess: the old mixed child
attempted one admin seed, while the selected-task decision attempts none.
Cohort-wide service configuration remains intact.

The first v2 browser cohort also stopped after its setup failure because the
world coordinator's receipt reader accepted only version 1, while the native
stack producer wrote a clean version-2 receipt. The supported version-2 read and
canonical native-identity validator prove the actual receipt valid. Keep all
ownership, live-process and result-hash checks; never infer cleanup from process
absence alone. Canonical reconciliation confirmed the exact original resources
clean. Preserve the original infrastructure failure and three tasks cancelled
before start; reconciliation does not turn that failed experiment into PASS.
