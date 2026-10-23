---
id: 2026-10-23-campaign-runner-lacked-fixed-total-infra-stop
date: 2026-10-23
title: run-bench-campaign kept running after its fixed-total infra stop was breached; the rule lived only in parent instructions
surface: infra
component: run-bench-campaign
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py main loop — controller exit handling recorded r004-j0007 as failed but never classified its INFRA_ERROR run record nor evaluated 20*infra_jobs >= scheduled_total (verdicts were read only under --retry-infra)
symptoms:
  - "cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers"
  - "❌ infra canary preflight FAILED (exit=1) — refusing capability fleet (INFRA)"
  - campaign summary.json retry_infra 0 with no infra stop after 1/10 infra jobs
  - campaign kept running all other jobs for 32 minutes until the parent TERMed the controller
  - "🛑 INFRA STOP: 1/10 scheduled jobs are confirmed infrastructure failures"
tags:
  - campaign
  - infra-stop
  - descend
  - run-bench
  - claude-code-agent
  - browser-auth-created-account-reused
sources:
  - benchmark run campaign-20261023-060651-2724157 (descend-full69-20261023 cluster K11, job r004-j0007)
  - fleet run 20261023-060710-2729424
  - task claude-code-agent
  - task browser-auth-created-account-reused
repro: scripts/tests/campaign-hub-grouping.test.ts ("one pre-allocation INFRA refusal in a 10-job campaign stops it with a breach receipt"; "the campaign infra stop counts scheduled jobs once against the frozen total")
status: fixed
---

## Problem

The /descend proof campaign `scripts/run-bench claude-code-agent
browser-auth-created-account-reused -k 5 --concurrency 10` (10 scheduled jobs)
had job r004-j0007 refused before allocation at 06:07:21Z
(`cleanup reserve admission failed: [Errno 28] insufficient physical cleanup
floors for pending controllers`, then `❌ infra canary preflight FAILED
(exit=1) — refusing capability fleet (INFRA)`). Its fleet record
`20261023-060710-2729424/_batch/run.json` holds `status: INFRA_ERROR,
passed: false, lifecycle_stage: released`. That is 1/10 confirmed infra jobs,
meeting the standing stop rule `scheduled_total > 0 && 20 * infra_failed_jobs
>= scheduled_total`. The campaign kept the other nine jobs running for 32
minutes until the parent TERMed the exact controller; summary.json shows
`retry_infra: 0`, `status: cancelled`, no stop and no infra classification for
j0007.

## Diagnosis

- Critical path: fleet controller writes `_batch/run.json` → campaign joins the
  controller exit → classifies the attempt → decides whether to continue.
- First bad: the campaign's exit handler read the run record only inside
  `if args.retry_infra:` (`released_attempt`), so a plain campaign never knew
  j0007 was INFRA. Even with `--retry-infra`, nothing evaluated the fixed-total
  threshold; the only implementations lived in the sharded operator
  (`cloudbench-shard-coordinator.py` coordinate, the original600 supervisor's
  `fold`) and in parent agent instructions (CLAUDE.md, descend.md), so every
  ordinary `run-bench -k` observer had to re-implement it.
- Why possible: `released_attempt` also dropped the verdict whenever the
  release seal was unverified, so even the operator's fold saw a confirmed
  INFRA_ERROR as unknown in that case.
- Local repro (red on 92f888022): the new 10-job fake campaign ran all nine
  other jobs to completion (~47s), status `failed`, `infra_stop` absent.

## Solution

- `cloudbench-shard-coordinator.py`: one predicate `infra_stop_reached(infra,
  total)` (`total > 0 and 20*infra >= total`), used by `coordinate()` and by
  the campaign.
- `run-bench-campaign.py`: split `terminal_task`/`task_verdict` out of
  `released_attempt` (the verdict survives an unverified release); record each
  plain attempt's verdict; freeze the denominator at startup (shard
  `group_total`, else scheduled jobs); `infra_stop_receipt` counts each job once
  when one of its own terminal non-cancelled attempts is confirmed INFRA
  (unknown/cancelled never count). On the first breach it writes
  `summary.json.infra_stop` (job_id, task, attempt, task_status, infra_jobs,
  scheduled_total, infra_job_ids, policy, observed_at, breached_at_epoch),
  prints a loud `🛑 INFRA STOP` stderr line, aborts the startup cohort and TERMs
  only its own controllers through the normal owned teardown; pending jobs are
  cancelled. The existing operator policy override
  `CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP=disabled` is honored; default on.
- Sibling failures prevented: every ordinary campaign (descend proof runs,
  `run-bench -k`) and shard campaigns (local count against the shared group
  total can never stop earlier than the global rule).
- 10k-agent behavior: O(jobs) scan per controller exit over in-memory rows; no
  new I/O beyond one small run.json read per exit.
- Golden reference: searched claude-code-src, openclaw, hermes-agent and codex
  for failure-threshold stops (max_failures/fail_fast/bail); no analog — this
  is benchmark-fleet infrastructure.

## Human feedback

None recorded.

## Reusable lesson

Enforce a run's stop rule inside the runner that owns the jobs, with a durable receipt; a rule that lives only in parent instructions is re-implemented, late, by every observer.
