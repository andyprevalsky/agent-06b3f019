---
id: 2026-10-27-dev-bench-stacks-shared-prod-temporal-namespace-and-pooler
date: 2026-10-27
title: Dev and benchmark stacks ran in production's Temporal namespace and production budgeted the whole pooler cap for itself
surface: infra
component: stack-isolation
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/run.sh started backend and worker with agents/.env's production TEMPORAL_NAMESPACE on a per-stack queue; back-end/src/providers/database.ts derived production's pool as if production owned all 1,000 Supavisor client slots"
symptoms:
  - 4,094 Running AgentWorkflows in rose-labs-us-east-1.tch2n on 1,636 dev/bench queues, 2 with pollers (2026-10-27)
  - a dev worker on navi-agent-tasks-<workspace> polled in the production namespace
  - production's derived pool budgeted 2 x (330 + 150) + 40 = 1000 of 1000 pooler clients during a deploy overlap
  - EMAXCONN during wide fleets plus dev stacks (2026-10-10, 2026-10-11)
tags:
  - temporal
  - supavisor
  - emaxconn
  - benchmark-isolation
  - 10k-agents
sources:
  - memory:scalability-audit-100-seats-20261024
  - memory:mass-agent-smoke-pooler-saturation
  - memory:bench-guest-temporal-override-host-local
  - PR #1558
repro: scripts/tests/temporal-namespace-isolation.test.py and back-end/src/tests/structural/db-pool-invariant.test.ts (testProdLeavesNonProdSliceAtLiveSettings)
status: fixed
---

## Problem

Every local dev stack and every `run-bench --local` stack runs through `scripts/run.sh`. Each one polled a private queue in production's Temporal namespace. When a stack stopped, its Running workflows stayed Running for good. On 2026-10-27 the namespace held 4,094 of them on 1,636 queues. Only 2 queues had pollers, and none was a production queue. They share production's action and Visibility API budgets.

Separately, `computeProdConnectionLimit` let production budget the whole Supavisor cap during a rolling deploy: Render runs `POOLER_MAX_CLIENT_CONN=1000` and `FAST_CACHE_DB_POOL=150`. Dev stacks (20 clients) and DEMO fleet guests (4 each) connect to the same pooler as the same `postgres` user, so any of them during a deploy overlap could cause EMAXCONN.

## Diagnosis

- **Temporal.** Cloud guests already move to `rose-labs-bench.tch2n` through `agents/.env.benchmark-temporal` (PR #1558), but only for staged guest secrets. `run.sh` never applied that override, and neither the worker nor the backend checked which namespace a queue belonged to.
  - Live repro on main: `TEMPORAL_TASK_QUEUE=navi-agent-tasks-s18-repro-before python agents/worker.py` logged `namespace=rose-labs-us-east-1.tch2n` and registered 1 workflow poller there.
- **Pooler.** `db-pool-invariant.test.ts` modelled only production. The new live-settings case failed on main: `Production budgets 1000 of 1000 pooler clients during a deploy overlap, leaving 0 for the 300-client non-production worst case`.
- **Prod tables.** About 11.6k Agent rows were created in 7 days. They are intended rows, not leaked benchmark agents:
  - Benchmark Hub's soft-deleted breadcrumb skeletons under the sentinel user `benchmark-hub-ancestors` (`benchmarkHubAncestors.ts`).
  - Prod semantic-CI probes (`chat-lifecycle-latency.spec.ts`).
  - Neither is a benchmark stack writing agents to production.

## Solution

- `stack_bench_temporal_exports` (`scripts/lib/cloudbench-env.sh`) moves a stack that would use production's namespace onto the namespace in the private guest override. It fails with an actionable message when the override is missing, is not 0600, or names production. `run.sh` and the local benchmark runner (`apply_stack_temporal_namespace`) apply it.
- The worker (`production_namespace_refusal`) and backend bootstrap (`assertTemporalNamespaceIsolation`) refuse any queue other than `navi-agent-tasks[@gen]` or a worker-pool queue in production's namespace.
  - After the fix, the same worker command exits with `Temporal namespace isolation refused worker start` and 0 pollers.
  - With the routed env, the worker polls in `rose-labs-bench.tch2n`.
- `computeProdConnectionLimit` now reserves `POOLER_NONPROD_CLIENT_BUDGET` (default 300: a 50-guest DEMO fleet at 4 plus five stacks at 20). Production's main pool goes from 330 to 180 at live settings. Supavisor serves it through 60 server connections, so 180 clients remain far above real concurrency. The code-default cap is now 1000, which matches Render.
- `scripts/temporal-orphan-sweep.py` selects a queue only when all three hold: it is not a production queue, two observations 120 s apart see zero workflow and zero activity pollers, and its newest Running workflow started more than 48 h ago. It runs dry by default and writes a receipt; `--execute` terminates.

At 10,000 agents: no per-agent cost. Routing is one env resolution per stack. The guard is one string check at boot. The pooler slice is static arithmetic. The sweep is O(running workflows), run by hand.

## Human feedback

None yet.

## Reusable lesson

A capacity budget that one tenant derives must name every other client of the same resource. An isolation override that only one launch path applies is not isolation: enforce it where the process connects.
