---
id: 2026-11-11-declared-judge-unpersisted-agent-identity
date: 2026-11-11
title: Declared benchmark judge passed an unpersisted Agent identity into code-session Message creation
surface: harness
component: declared-agentic-judge
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py::_call_declared_agentic_llm_judge minted a UUID without persisting its Agent before spawning the code session
symptoms:
  - Message_agentId_fkey
  - Declared evaluator t7-schema-task-complete execution failed
  - Failed to create code session
tags:
  - benchmark
  - judge
  - identity
  - foreign-key
sources:
  - commit b6188d39fd0e12bffc7a4466a2266959888e9a33
  - commit c12fb5ccea67f5bfa474a0817e0df0b75a848973
  - agent 93348ad6-b579-4f44-920b-14f2b2ed261c
  - agent ec651523-b5fb-4c89-8f4d-17ac306fc1d0
repro: agents/tests/blackbox/benchmark.blackbox.py::test_declared_judge_persists_its_isolated_identity_before_session_creation
status: open
---

## Problem

The original fleet task test-mass-agent-run-0 ended native ERROR, passed=false,
in 518.2 seconds. Its T7 judge attempted Codex code-session creation and Prisma
rejected Message creation at messages.ts:74 with Message_agentId_fkey. Original
native SHA256 is 806c4dec44d2be3cb54cb68d801427e85ab721127d15800e043c65255807d8f2.
The encrypted seven-file original archive was independently restored and all
members authenticated on the repair box before benchmarking. The authoritative
adapter receipt records deploy_test_cloud.py with request token
8807fdf9944644e89fdb01dd22118baf; the supplied fleet shell command was illustrative.
No exact historical judge UUID/request body is asserted from the task-level row.

On current main 06edeba6cbba2389bc11eb48f8ff7bb2f4204aab, the unchanged command
`scripts/run-bench --local test-mass-agent-run-0` reproduced the same T7/Prisma
boundary in 315 seconds. Normal credential selection chose Claude in this local
run; the original chose Codex. Root ec651523-b5fb-4c89-8f4d-17ac306fc1d0 has durable
viewer https://www.roselabs.ai/?agent-id=ec651523-b5fb-4c89-8f4d-17ac306fc1d0.
Both native errors remain errors independently of quarantine projections.
No report_bug tool invocation was present in the authenticated original native
artifact. The old credential-GET/TREE STALL quarantine owner confirmed that its
work did not implement a judge identity repair. Prior ph7dk attribution controls
left real Prisma and benchmark outcome proof open; they are not repair credit.

## Diagnosis

Gate: NOT_INTRODUCED relative to PR1918's baseline/failed source comparison.
That attribution does not waive this assigned repair. Current main contains the
exact PR1918 merge 3d3b9a2de7c600d0b9665f8b312bc99cbae02de1.

Path: declared evaluator -> shared agentic judge -> fresh judge UUID -> code
spawn service -> code-session creation -> Message.agentId -> Agent foreign key.
The first bad data is an unpersisted identity at the harness producer, rather
than the FK enforcement. The permanent owning blackbox test actually failed
before the fix with Message_agentId_fkey. A separate controlled invocation of
the real shared helper ran the actual messages.ts createMessage through Prisma
on the owned local database and reproduced the exact native FK error. Its
post-fix fresh-stack run persisted the same session-init Message successfully
and verified identity archive and task cleanup. Provider/attachment transport
was isolated in that small causal control; it is not a benchmark pass.

Archive searches used the literal Message_agentId_fkey (no exact case) and
'declared judge code session identity' (related evidence/credential cases).
This is a distinct persisted-identity defect, not evidence of another completed
repair recurring. Missing historical UUID remains explicitly unknown.

## Solution

Persist a detached judge identity on the same backend before token/session
operations. Existing Agent creation gains an internal-only external-execution
mode: the normal transaction/defaults/ownership checks remain, and no chat or
Temporal loop launches. Public/unknown/incompatible mode requests are rejected.
Do not reuse the graded root or relax the database FK. Judge prompt, output
schema, credential selection, evaluator assertions and task budgets stay intact.

Capture judge trace and cleanup receipts, terminalize the wrapper separately
from its verdict, then use canonical exact-ID archive. Verify task closure and
persistent-session retirement; do not treat HTTP204 alone as provider cleanup.
Keep judge audit bookkeeping outside subsequent evaluator evidence.

At 10k simultaneous judges, each has its own Agent/transaction and indexed
exact-ID lifecycle operations. There is no user-wide scan, shared identity,
shared counter or added polling loop. Existing per-root archival cost remains.
Permanent regression is registered in the benchmark blackbox domain; API/FK,
state and denied-auth cases are registered in the backend agents blackbox suite.

A development task run 9acd0ed8-caca-4886-b2d7-6ea44663e6af created real
judge b66bd6db-58b7-4cd2-8447-16ea2adcc83d and code task
0270100a-d934-4688-923e-e261257eb9f4, beyond the original FK boundary. It
remained native ERROR (581.6s): archive closed the task but left persistent
session d419d643-6a07-43df-9b0d-440ec2f80422 PAUSED. Exact-owner canonical
retirement was then independently verified RETIRED. The helper now performs
that retirement and re-reads its state; the permanent paused-session control
failed on the prior helper and passes after this correction. The ERROR is not
rewritten or counted as a task pass. This developmental run used evolving
helper code and is not final committed-source outcome acceptance.

An introduced structural violation (Express imported by a framework-independent
module) was reproduced independently: 2229 passed / 1 failed. Moving the HTTP
adapter to routes.externalExecution.ts made the unchanged permanent layer test
pass 2233 / 0. Both original native failure and adapter UNVERIFIED are retained.
Full backend Agents blackbox passed, and the benchmark blackbox domain passed
in 442 seconds on its execution snapshot; final-source deploy gates still own
complete coverage.

Full original-task green, full owning suites, committed final-source fleet
acceptance and completed deploy/production/closeout remain required. The case
stays OPEN until those results are verified; development passes are not release
or outcome credit.

## Human feedback

The repair assignment explicitly requires preserving evaluator intent,
assertions, timeouts, permissions, Freedom, original native ERROR evidence,
and autonomous deployment through merge and deletion readiness. Attribution,
quarantine adaptation, mocks, draft PRs and investigation-only results do not
complete it. No additional feedback recorded.

## Reusable lesson

Persist an external executor's isolated identity on the owning backend before any foreign-keyed session operation, and verify its exact-owned cleanup independently of the archive HTTP response.


## PR1920 integration provenance

Reused exact published runtime and owning tests from PR1923 head `a6f2dde921666e614e2d0331b3599e75eecc26aa`, with owner confirmation. Original PR1920 source `67b90ec7d969870cd8f1d933fb90b616af1337e5` independently reached the same detached Claude judge / Message_agentId_fkey boundary after all 51 task agents completed. Three owning identity tests pass locally after integration; this does not claim whole-task acceptance or originating repair completion. Fresh native final-source validation remains required. No task definition, judge prompt, assertion or timeout changes are included.
