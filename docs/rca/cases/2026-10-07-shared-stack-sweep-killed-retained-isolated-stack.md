---
id: 2026-10-07-shared-stack-sweep-killed-retained-isolated-stack
date: 2026-10-07
title: Stopping the shared stack swept away an isolated stack retained for payment recovery
surface: harness
component: kill-services
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/kill-services.sh protected isolated stacks only through a live benchmark-controller ancestor, so a stack retained after its controller exited matched the run.sh/cwd sweep
symptoms:
  - "🛑 Stopping all services... (triggered by: 1 main scripts/run.sh, DB_OWNED_BY_US=true)"
  - "local-stack-cleanup.status state=failed for a failed_retained run"
  - "retained victoria_bench_* database dropped"
tags:
  - kill-services
  - retained-stack
  - agentcard
  - deploy-step-5
  - rule-27
sources:
  - PR #1417
  - benchmark run 1791396285-2126832-43519
repro: scripts/tests/kill-services.test.sh
status: fixed
---

## Problem

In `/deploy` for PR #1417, the AgentCard lane's payment cleanup timed out on
the open release stall, so `benchmarks/local.py` recorded `failed_retained` for
stack `1791396285-2126832-43519` and kept its `run.sh` (PID 2127016), services
and `victoria_bench_1791396285_2126832_43519` database as exact-owner recovery
authority. At 19:31 the deploy's shared Step 5 stack (`run.sh --benchmark`,
port 4400) was stopped for a rebuild. At 19:31:15 the retained `run.sh` and its
workers received SIGTERM. Its EXIT trap reported cleanup `failed`, stopped all
services and dropped the retained database.

## Diagnosis

The shared stack is not an isolated run, so its EXIT trap runs
`scripts/kill-services.sh`. That sweep matches every `scripts/run.sh` and every
service-shaped process whose cwd is in the worktree. Isolated stacks were
protected only by `is_protected_benchmark_tree`, which walks up to a live
benchmark controller (`run-bench`, `local.py`, `run_deploy_stage.py`, …). A
retained stack outlives that controller by design. Once the controller exited,
the orphaned `run.sh` had no protected ancestor, and the sweep listed it and
its descendants as targets. This is a relative of
`2026-07-29-cleanup-ancestor-walk-kills-benchmark-controller`, whose fix
protected controller trees only while a controller lives. `local.py` already records the stack's exact
identity in `.context/benchmarks/<run>/local-stack-owner.json` and stops
isolated stacks only through that identity (`stop_services`). The sweep never
read it.

Reproduction: `kill-services.test.sh` starts a fixture isolated `run.sh`
(with a `worker.py` child) that has no controller ancestor and a matching owner
record. Before the fix, the sweep listed and killed
`bash scripts/run.sh --benchmark` and its `python3 worker.py`.

## Solution

`kill-services.sh` loads every `local-stack-owner.json` in the worktree. A PID
whose ancestor chain includes a live process matching a recorded
`native_identity` is protected, both at root discovery and in the final
descendant backstop. A record whose identity no longer matches its PID grants
nothing, so stale records from completed runs and recycled PIDs stay
reapable. Isolated stacks remain stoppable through their owner (`local.py`
`stop_services` / exact-owner recovery).

The kill-services suite, registered in the deploy command structural runner,
now covers both a matching retained stack (run.sh and worker survive) and a
stale owner record (both are reaped). The protection case failed before the fix
and passes after it. A dry run over this worktree's 14 historical owner records
took 61 seconds, against 58 seconds before the change.

The destroyed stack's local reconciler state cannot be restored. Its sandbox
transfer stays with AgentCard's release stall, tracked in the open
`2026-10-02-agentcard-abandonment-closed-card-transfer-never-released` case. No
production funds were involved.

## Human feedback

None recorded.

## Reusable lesson

Protection that depends on a controller ancestor ends when the controller
exits; anything retained beyond its owner's lifetime must be protected by its
own durable ownership record.
