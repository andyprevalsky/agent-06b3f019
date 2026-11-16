---
id: 2026-11-07-plain-campaign-recorded-release-seal-only-under-retry-infra
date: 2026-11-07
title: A plain campaign recorded fleet release seals only under --retry-infra, so verified teardowns rendered 0/16 released
surface: infra
component: run-bench-campaign
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py controller-exit handler — released_attempt (run_id, fleet_dir, resources_released, lifecycle_verified) ran only inside `if args.retry_infra:`; plain campaigns recorded only attempt_verdict, and cloudbench-scorecard.py load_campaign read release solely from those summary fields
symptoms:
  - "🟠 Guests released · 0/16 terminal jobs · no native audit"
  - "🟠 Lifecycle verified · 0/16 terminal jobs"
  - "Lifecycle verified: 0/16 terminal jobs. Owner parent → reconcile from the recorded receipts before the next launch"
  - "4 AGENT FAIL: reason UNRECORDED"
  - "campaign summary.json retry_infra 0, jobs without resources_released / lifecycle_verified / fleet_dir"
tags:
  - scorecard
  - campaign
  - stale-data
  - lifecycle
  - teardown
  - descend-i-29
sources:
  - commit 268e9550b0 (base; fix on branch rca/i-29-20261107)
  - benchmark run campaign-20261107-211039-3331466 (descend-launch-e20, run descend-failed-neverrun-20261106)
  - fleet run 20261107-212636-3543850 (first of 16 copies; last 20261107-221203-488132)
repro: scripts/tests/cloudbench-scorecard.test.py (test_plain_campaign_counts_verified_fleet_teardown_receipts, test_campaign_with_malformed_release_receipts_renders_them_unverified); scripts/tests/campaign-hub-grouping.test.ts ("a plain campaign records each exited attempt's verified fleet release seal", "a looping release receipt is unverified and never stops a healthy peer")
status: fixed
---

## Problem

`scripts/run-bench scorecard` for the finished epoch20 campaign
`campaign-20261107-211039-3331466` (16 jobs, `retry_infra: 0`) rendered
`🟠 Guests released · 0/16 terminal jobs · no native audit` and
`🟠 Lifecycle verified · 0/16 terminal jobs`, plus `reason UNRECORDED`,
`Cost UNMETERED` and `Cache UNMEASURED`. Every one of the 16 fleet runs had a
`provider-teardown-verified` ownership audit (meta + epoch mirrored in the run's
`teardown-ownership/`), `_batch/lifecycle.json status: verified` and a
`lifecycle_stage: released` task; all 18 owned Machines/volumes were ABSENT on
the provider list at 22:46:23Z. Each teardown epoch preceded its controller
exit by 14–31 s, so the receipts were present when the campaign recorded the job.

## Diagnosis

- Critical path: fleet controller writes teardown audit + lifecycle.json →
  campaign joins controller exit → records job disposition in summary.json →
  `cloudbench-scorecard.py load_campaign` → `compact_rows` reads
  `job.resources_released` / `job.lifecycle_verified` / `job.fleet_dir` →
  `_job_lifecycle` counts rows with `released is True`.
- Data correct at the fleet: the campaign's own verifier
  `released_attempt(<workspace>, job)`, run read-only against the 16 recorded
  jobs, returned `resources_released: True, lifecycle_verified: True` for all 16.
- First bad: `summary.json` jobs carry only `task_status/infra_failure/
  terminal_task`. In the exit handler, `released_attempt` (release seal and the
  physical `fleet_dir`/`run_id` handle) ran only under `if args.retry_infra:`;
  the plain path called `attempt_verdict`, which never read the seal. Relative
  of `2026-10-23-campaign-runner-lacked-fixed-total-infra-stop`: that fix moved
  only the verdict out of the same `if args.retry_infra:` gate.
- Why the scorecard could not recover: `load_campaign` trusted the exit-time
  summary snapshot alone; it never re-read the fleet receipts, so the card stays
  stale for every already-written plain campaign. Without `fleet_dir` it also
  never loaded the fleet report cards (siblings: UNRECORDED reasons, UNMETERED
  cost, UNMEASURED cache). "no native audit" is only the fallback suffix when
  per-job release is incomplete; the native audit is a sharded-export producer.
- Local repros (red on 268e9550b0):
  `python3 scripts/tests/cloudbench-scorecard.test.py Scorecard.test_plain_campaign_counts_verified_fleet_teardown_receipts`
  → `🟠 Guests released · 0/3 terminal jobs · no native audit`;
  `campaign-hub-grouping.test.ts --test-name-pattern="release seal"` → summary
  job carried only `task_status: PASSED`, no release fields.

## Solution

- `run-bench-campaign.py`: every exited attempt records `released_attempt`'s
  disposition (verdict + release seal + fleet handle), with or without
  `--retry-infra`; retry bookkeeping stays gated. `attempt_verdict` is deleted
  (one verifier, one path).
- `released_attempt` now runs on every exit, so it must never raise: any
  exception while reading the run record or seal (symlink-loop `RuntimeError`
  from `Path.resolve()`, `RecursionError` from deeply nested JSON,
  `AttributeError` from non-dict JSON) returns an unverified release with the
  error type in `retry_blocked`. Adversarial review of 9580f1c9e4 reproduced the
  crash: one looping receipt raised out of the exit handler, the `finally` block
  TERMed the healthy peer at 0.9 s and summary.json stayed `running`.
- `cloudbench-scorecard.py`: `refresh_release` re-reads fleet receipts at
  render time through that same `released_attempt`, in memory only, bound to
  the workspace derived from `<root>/.context/benchmarks/campaigns/<id>`, and
  only for finished jobs whose summary has no `resources_released` key (plain
  summaries written before this fix; the runner's exit-time check covers the
  rest, keeping render cost flat). Only a verifier-confirmed release is added;
  an unverifiable or raising receipt leaves the job unverified. Legacy epoch20
  renders in ~1.7 s because each check parses its full `_batch/run.json`.
- Real card after the fix (summary.json byte-identical): `✅ Guests released ·
  16/16`, `✅ Lifecycle verified · 16/16`, four distinct failure reasons,
  `Cost $1.30 metered (16/16)`, cache 47% (16/16).
- 10k-agent behavior: per finished job, a handful of small file reads at exit
  and at render time; O(jobs), no provider calls, no shared state.
- Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded. (The parent agent's adversarial code review requested the
exception hardening and the render-cost bound described in Solution.)

## Reusable lesson

Record a job's release seal and physical handle on every exit path, not only the retry path, and have the scorecard re-derive release from the same verifier at render time so a stale exit snapshot never hides a verified teardown.
