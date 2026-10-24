---
id: 2026-10-24-shared-cpu-2x-fleet-primary-throttled-by-cpu-steal
date: 2026-10-24
title: shared-cpu-2x cloudbench primaries throttled to 81-93% CPU steal expired Prisma interactive transactions (agent-write 500s)
surface: infra
component: cloudbench-fleet-primary-vm-shape
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet FLEET_PRIMARY_VM_SIZE default shared-cpu-2x — the guest running backend + Postgres + worker was throttled by the hypervisor (steal 81-93%, own user CPU ~5%), so wall-clock-bounded Prisma interactive transactions (10s) and the worker's 30s HTTP read expired
symptoms:
  - "[Agents] Failed to post message agent_id=<id> error="
  - "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 10000 ms"
  - "[Agents] Failed to update agent status agent_id=<id> error="
  - "P1001 Can't reach database server at `localhost:5432`"
  - cloudbench guest-diagnostics steal 80-93% on a shared-cpu-2x primary
tags:
  - cloudbench
  - fly
  - shared-cpu
  - cpu-steal
  - prisma-interactive-transaction
  - logging
sources:
  - agent bcb407af-535a-4bd2-849b-8bd7e137e64b (descend-full69 proof 2, source 7eb275b1b, r001-j0013)
  - agent 54e2da9e-93a7-4a65-9521-d85a4794df6b (r003-j0042)
  - agent 4eca07d8 (r005-j0068, claude-code-agent)
  - commit 8d9598dbd (branch rca/TD-backend-500-agent-writes, fleet primary shape)
repro: scripts/tests/cloudbench-env.test.sh (default primary shape) and back-end/src/tests/blackbox/logger.blackbox.ts testMultilineRouteErrorStaysOnOneLine
status: mitigated
---

## Problem

In descend-full69 proof 2 (source 7eb275b1b, 70 fresh cloudbench clones started
together) three jobs hit backend failures on agent writes, all recovered by
Temporal retry:

- r001-j0013 (grep-agent-trajectories-code-tool-status): `POST /messages` 500
  after 28.9s; the backend line read `Failed to post message ... error=` with
  the cause on the following lines (`Transaction already closed ... 10000 ms,
  however 11302 ms passed`). Later `mark_finished` failed with
  `httpx.ReadTimeout('')` (logged as `error: ""`) because the terminal
  `PATCH /status` ran trace-archive finalization inline for >30s.
- r003-j0042 (agent-display-revenue-chart): `PATCH /status` 500, the same
  expired interactive transaction in `repoWorkflowMutations.ts`.
- r005-j0068 (claude-code-agent): Prisma `P1001 Can't reach database server at
  localhost:5432` and an unavailable archive start fixture.

## Diagnosis

- Guest diagnostics (`runtime-evidence/guest-diagnostics.jsonl`): exactly 3 of
  70 guests show CPU steal, and they are these three jobs: 85.3%, 80.8% and
  92.6%. While stolen, their own user CPU stayed about 5-7% and Postgres had no
  active or lock-waiting sessions (`by_state` idle, `by_wait` empty).
- All three are `cpus: 2` (shared-cpu-2x, the default primary shape). 3 of 15
  2x primaries were throttled; 0 of 55 shared-cpu-4x primaries in the same run
  exceeded 9% steal. All 70 were `mode=fresh` clones, so pool reuse is not a
  confound.
- The backend log shows the starvation signature: multi-second gaps followed
  by many queries completing in the same millisecond, e.g. 19 fixture reads all
  reporting `duration_ms=3467` at 23:16:03.349. An uncontended advisory-lock
  `$queryRaw` inside the message transaction reported 17279 ms.
- Chain: hypervisor throttling on a shared-cpu-2x guest leads to a wall-clock
  stall of the whole stack. That expires Prisma's 10s interactive-transaction
  timeout (`runTransactionWithRetry` default), producing 500s on message/status
  writes. It also pushes the inline-finalizing terminal `PATCH /status` past the
  worker's 30s read and times out the localhost PG connect (P1001).
- Observability rung: the "empty" `error=` is the dev pretty-printer
  (`providers/logger.ts formatValue`) emitting a value that starts with `\n`, so
  line-based readers see an empty field. Production single-line JSON keeps it.
- Relative of docs/rca/cases/2026-10-23-mass-agent-guest-backend-db-latency-floor.md (P3). That
  case recorded "steal vs user/system not yet recorded". This run records it:
  the starvation is hypervisor steal, not the stack's own CPU use.

## Solution

- Default fleet primary is now `shared-cpu-4x` (memory unchanged 4096 MB):
  `scripts/run-bench-fleet FLEET_PRIMARY_VM_SIZE`. The campaign planner
  (`run-bench-campaign.py stress_default_requirements`) executes the fleet's own
  shape function, so planned shared-CPU units and the derived governor follow:
  a 70-wide proof now plans 280 instead of 250 shared units.
  Regression: `cloudbench-env.test.sh` asserts the default resolves to
  shared-cpu-4x. The planner tests in `cloudbench_campaign_inventory_test.py`
  were updated to the derived unit counts.
- Dev log lines stay single-line: multi-line string/stack values are JSON-quoted
  and escaped rather than split, so `error=` carries the cause. Regression:
  `logger.blackbox.ts testMultilineRouteErrorStaysOnOneLine` drives
  `handleRouteError` with the verbatim j0013 Prisma message.
- Idempotency held: the expired transaction rolled back before `Message.create`,
  and the retry created exactly one row (messageId 4d174785, 201 at
  23:16:30.957Z).
- Not fixed here: 4x guests still burst above a shared baseline (mean 0.35
  active cores), so the shape fix is evidence-backed but not a hard guarantee.
  Performance cores are the only unthrottled class and are reservation-limited.
  The steal drop must be confirmed by the next proof's guest diagnostics. 42
  worker sites log `error=str(e)`, which is empty for `httpx.ReadTimeout`.
- 10k-agent behavior: no runtime path change. Per-agent cost is unchanged; the
  fleet doubles shared-CPU units for default-shape benchmark guests only.

## Human feedback

Parent coordinator (descend-full69) re-scoped this RCA to fix the infra cause
(guest machine class or sizing rule) as well as the one-line error
observability, without approval, and to show evidence that steal drops.

## Reusable lesson

When cloud-guest backend writes 500 on expired Prisma transactions with idle Postgres, read the guest's CPU steal before touching transaction code; a throttled shared-cpu guest stalls everything at once.
