---
id: 2026-10-27-sharded-operator-refused-polar-2h-window
date: 2026-10-27
title: Sharded operator refused the Polar 2-hour --timeout because the 2h-window fixes never merged to main
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-original600-runner.py campaign_timeouts — task_timeout capped at RUN_DEADLINE-STARTUP_ALLOWANCE (3300 s) on main 35ae7f4a7, while run-bench routes >32 simultaneous copies to the sharded operator and the Polar rule binds --timeout 7200
symptoms:
  - "ValueError: --task-timeout must be 60..3300 seconds"
  - "sharded operator check refused the run; nothing was launched"
  - wide Polar batch (-k 3 --concurrency 60 --timeout 7200) split into ordinary 30-copy campaigns as a workaround
tags:
  - sharded
  - original600
  - e2e-timeout
  - polar
  - descend
sources:
  - benchmark run descend-polar-k3-20261027 (cluster I1, launch owner devbox f8f1d5ab)
  - commit 0a2470cc6 (origin/fix/sharded-2h-task-timeout, unmerged)
  - commit 507da9dfc (origin/rca/sharded-e2e-covers-task-window, with a22e40431 and 3f53adbd2, unmerged)
repro: scripts/run-bench <20 polar-bu tasks> -k 3 --concurrency 60 --timeout 7200 --check; scripts/tests/original600-portable-operator.test.py; scripts/tests/descend-command.test.sh
status: fixed
---

## Problem

In /descend run `descend-polar-k3-20261027` (branch = main `35ae7f4a7`),
`scripts/run-bench <20 polar-bu> -k 3 --concurrency 60 --timeout 7200` routed
the 60 copies to the sharded operator (more than 32 per controller). Its
`--check` refused before any provider read: `ValueError: --task-timeout must be
60..3300 seconds`. The Polar standing rule is a 2-hour execution cap, and the
descent ramps to 70 tasks x K3 = 210 copies, so the 2-hour window must be
accepted by one sharded launch. Batch 1 ran as two ordinary 30-copy campaigns
instead.

## Diagnosis

Reproduced locally on the tip with the real CLI `--check`; it failed with the
error above. `campaign_timeouts` bounded the task window by the fixed 5400 s
operator deadline minus 2100 s startup. The root fix already existed on
2026-10-20 (0a2470cc6, then 507da9dfc for the barrier, copy tail and release
allowances, and 3f53adbd2 for dead-owner export recovery of a bound deadline).
It stayed on two unmerged branches whose later adoption-hardening commits
conflict with current main, so main kept the 3300 s cap.

## Solution

Ported the three commits onto the tip as `[descend-I1]` commits, resolving
conflicts with main's newer runner loop (controller-stopped and seal-recovery
paths). The changes:

- `MAX_TASK_TIMEOUT = 7200`. Each shard's host TERM fence, `caller.json` and
  `terminal.json` deadlines, transfers and gate watchdog bind
  `epoch + bound e2e`.
- The default e2e is `max(5400, task + 720+900+720+480)`, which is 10020 s at
  7200.
- Export recovery accepts that bound deadline.
- `run-bench` refuses `--timeout` above 7200 up front with an actionable
  message.

The run-bench pre-check does not enforce the operator's 60 s minimum: ordinary
fleets and campaigns accept short diagnostic windows, and
`descend-command.test.sh` exercises `--timeout 7`. Runs without `--timeout`
keep their defaults, for example 1200 s and 5400 s. An explicit e2e that cannot
hold a full window is refused up front.

The real `--check` passes for 60 copies: task 7200, e2e 10020, 2 controllers.
For 210 copies it passes the timeout gate but is refused by the separate
provider rate-limit preflight (Parallel Search+Extract limits it to 70
concurrent copies). That limit is a user decision and is not changed here.
The cost is constant arithmetic per shard; nothing scales with the number of
agents.

## Human feedback

None recorded.

## Reusable lesson

Before re-diagnosing an infra refusal, check `git log --all` for an unmerged fix. A fix that lives only on a branch is not shipped, so port and merge it promptly.
