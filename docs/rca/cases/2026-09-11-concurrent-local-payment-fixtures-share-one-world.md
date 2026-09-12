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
  - agent bf0e8691-4258-4725-8806-89be0552cdf0
  - agent 67b11906-333d-4cfb-bbd7-40c13ca671ba
repro: agents/benchmarks/local_worlds_test.py
status: open
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

Status remains open until the complete unchanged local smoke group passes on
the fixed source. The 10-by-10 cloud stability acceptance is separate and remains
unfulfilled; no causal fixture pass counts toward it.

## Human feedback

The user directed the work to continue autonomously, requested ten consecutive
cloud slices of ten outcomes with no infrastructure failures, and required a
temporary five-minute cloud proof backstop while retaining the normal 120-minute
backstop. No task or evaluator weakening was requested.

## Reusable lesson

Give concurrently mutated benchmark fixtures separate owned worlds and bind every result to its actual run identity.
