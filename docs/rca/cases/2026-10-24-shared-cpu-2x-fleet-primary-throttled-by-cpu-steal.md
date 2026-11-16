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
  - "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 10000 ms"
  - "[Agents] Failed to post message agent_id=<id> error="
  - cloudbench guest-diagnostics steal 40-93% on a shared-cpu-2x or shared-cpu-4x primary
  - "loop.lag lag_s=17.518 cpu_pct=23.4 (event loop stalled) on a shared-cpu-4x browser primary"
  - browser.step.phases total_ms jumps from 4-7 s to 15-90 s mid-run (browser never finishes within budget)
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
  - agent b761b695-d243-4868-9c3e-f06e3af8756a (descend epoch 18, source 2556bdb2a4, instacart r1, fleet run 20261107-183106-905808)
  - agent 8f717909-a200-4a3c-8002-fca738dac136 (descend epoch 18, instacart r2, fleet run 20261107-184604-1228421)
  - fleet run 20261107-183106-905808
  - fleet run 20261107-184604-1228421
  - commit 61a2e95e25 (branch rca/h-60-20261107, loop.lag CPU-starvation attribution)
repro: scripts/tests/cloudbench-env.test.sh (default primary shape), back-end/src/tests/blackbox/logger.blackbox.ts testMultilineRouteErrorStaysOnOneLine, and agents/tests/blackbox/worker.blackbox.py test_loop_lag_attributes_stall_to_cpu_starvation_window
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

## Recurrence 2026-11-07 (descend H-60, shared-cpu-4x browser primaries)

The 4x shape did not hold for sustained browser workloads. In descend epoch 18
(source 2556bdb2a4), `browser-instacart-grocery-order` r1 and r2 both timed out
at 900 s while the browser was still checking SF stores for Cocojune 16 oz and
Essentia 12 x 1 L. Both primaries were `shared-cpu-4x`/8 GB, the
`FLEET_BUNDLED_FRONTEND_VM_SIZE` shape that every `requires_browser_agent` task
gets. Guest-diagnostics steal jumped from 0.1% to 40-77% at 19:02:08 (r1) and
19:12:14 (r2), 3.5-5 min into the run. From then on, guest user+sys stayed near
6% of 4 vCPUs, about 0.25 core. Browser steps grew from 4-7 s to 15-90 s at the
same moment: r1 took 27 steps in 14 min, and r2 slowed after 19:11:54. Before
the throttle, the worst loop lag was 1.6-2.0 s at 62-73% process CPU
(browser-use DOM serialization on large pages). Under throttle, the same work
became 5-17.5 s stalls at about 23% process CPU. Triage read the low
`cpu_pct` as an unknown blocker because `loop.lag` carried no starvation
attribution. Six of the 20 epoch-18 guests were throttled, all of them browser
tasks (instacart r1/r2, opentable r1, doordash-food-plan r1, blue-bottle r1,
anti-bot-doordash-store r1), and five of those six failed. The earlier fix only
moved the threshold: any workload that sustains well over the shared baseline
exhausts the burst balance within minutes, whatever the vCPU count.

Mechanism repro: `/tmp/h60/repro_quota.py` ran the unchanged
`worker.monitor_event_loop_lag` beside 1.5 CPU-s synchronous steps. Unconstrained,
the max lag was 1.50 s at 59.5% process CPU. Under `systemd-run -p CPUQuota=25%`,
the max lag was 5.99 s at 21.5% process CPU, the guest's signature.

Owned fix (commit 61a2e95e25, branch `rca/h-60-20261107`): each `loop.lag` warning now reports, for
the stalled tick window, `window_s`, `process_cpu_s`, `steal_pct` (hypervisor
share of guest vCPU time, from `/proc/stat`) and `cgroup_throttled_s` (cgroup v2
`throttled_usec`). After the fix, the same quota repro reports
`lag_s 5.822, process_cpu_s 1.49, cgroup_throttled_s 4.395`, and the
unconstrained run reports `lag_s 1.5, process_cpu_s 1.5`. The `worker`
blackbox domain went from 56 passed / 2 failed on the unfixed worker to 58
passed.

Not changed here: the browser primary still uses a shared CPU class. Dedicated
cores, as `FLEET_FANOUT_VM_SIZE=performance-2x` already gives wide trees, are
the only class that stays unthrottled. That change needs spend approval and
verified Fly performance-CPU headroom. A relaunch can use it without code via
`CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-2x` (8 GB). Outcome
proof is still pending: no unthrottled run of the instacart task exists. In
epoch 18 no browser observed a single SF store with both exact items. Store
results agreed across copies, so no tool returned misleading results. The
browser also reported its partial progress accurately when asked. The judge
counts a missing exact-brand item as a failure.

## Human feedback

Parent coordinator (descend-full69) re-scoped this RCA to fix the infra cause
(guest machine class or sizing rule) as well as the one-line error
observability, without approval, and to show evidence that steal drops.

## Reusable lesson

When cloud-guest work stalls with low process CPU, read the guest's CPU steal and the burst-exhaustion onset before blaming code; a throttled shared-cpu guest stalls everything at once, at any vCPU count.
