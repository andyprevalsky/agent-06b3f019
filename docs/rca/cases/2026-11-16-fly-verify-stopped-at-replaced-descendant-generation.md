---
id: 2026-11-16-fly-verify-stopped-at-replaced-descendant-generation
date: 2026-11-16
title: Production Fly verification stopped at a descendant cutover whose generation a later cutover had already replaced
surface: harness
component: deploy-production-fly-lane
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run_deploy_pipeline.py cutover_verify ran monitor-cooperative-cutover --verify only on the merge's job or its first SUCCEEDED supersededBy descendant; once a later cutover moved the live pointer, that monitor can never pass (pointerMatchesExpected false)
symptoms:
  - "A managed predecessor requires its durable qualified retirement certificate."
  - "durable job ea1b1f4c5befb11379822de0dd417a9973b7c719ff92b7ba58c431af3e2de3cc is SUPERSEDED, not SUCCEEDED; resume the SAME job"
  - "monitor-cooperative-cutover.ts --verify failed (exit 1) for job --verify"
tags:
  - deploy
  - production-lanes
  - fly
  - cutover
  - verified-by-descendant
sources:
  - PR #2065
  - commit 6a8237ec7a008ff53df4ee0c427cb3d8269d150e
repro: scripts/tests/run-deploy-pipeline.test.py::check_production_fly_wait (case 7b)
status: open
---

## Problem

PR #2065 merged as 6a8237ec7a on 2026-11-15. Its own Fly cutover (job ea1b1f4c5bef) failed in retire, during the systemic Fly API retire failures, and was coalesced into descendant job 7e8af6d15710 (#2133, source 5156d47533), which SUCCEEDED. Later cutovers (#2127, #2134, then job a556f348781f, source 31641a6709) moved the live pointer to generation 8f3f82ebea01.

`scripts/deploy production` then failed the Fly lane on every rerun with "A managed predecessor requires its durable qualified retirement certificate." This blocked workflow-migration and production semantics, even though the live generation contains the merge: `git merge-base --is-ancestor 6a8237ec7a 31641a6709` succeeds, and `monitor-cooperative-cutover --job-id a556f348… --verify` exits 0 (`cooperative_drain_complete`).

## Diagnosis

Path: `deploy_prod.lane_fly` → `run_deploy_pipeline production` → `cutover_verify` → `_descendant_cutover`, which follows `supersededBy` only while a job is SUPERSEDED → `monitor --job-id 7e8af… --verify`.

The monitor's `verifyOk` requires `pointerMatchesExpected`, meaning the target job's own queue must still be the live pointer. After any later cutover that is false forever, so a merge whose first succeeding descendant has itself been replaced can never be verified.

The same gap applies to a merge's own SUCCEEDED job when another cutover lands before the gate runs. Under parallel merges this is now routine (11-15: no serialization).

The live pointer's `updatedBy` is the live job id; `agentQueuePointer` enforces `job.jobId === updatedBy` for managed queues. That is the authoritative link to follow.

The `--verify` failure message printed `command[6]`, which is the `--verify` flag for the descendant command shape, not the job id. That is a separate small defect, fixed in the same change.

Repro: `check_production_fly_wait` case 7b. A descendant SUCCEEDED, its monitor `--verify` fails, and `--json` reports `pointerMatchesExpected: false` with `updatedBy` set to a live SUCCEEDED job descended from the merge. On the unfixed verifier the case fails (exit 1, "monitor-cooperative-cutover.ts --verify failed (exit 1) for job --verify"). With the fix it passes. Negative controls: a live job that does not descend from the merge, or one that is not SUCCEEDED, still blocks with no live verify.

Archive searches: `managed predecessor retirement certificate`, `verified by descendant cutover superseded`. Relatives:
- 2026-11-14 Render descendant verification, whose Render lane already accepts a live descendant.
- The PR #2127 retire retry. Its retire failures caused the supersede chain, but its fix does not touch verification.

Novel.

## Solution

When the target job's `--verify` fails, `cutover_verify` asks the monitor (`--json`, read-only) whether the pointer has moved. If it has, it reads the live pointer's owning job (`updatedBy`) and requires:
- stage SUCCEEDED,
- the same app,
- the merged SHA as a real git ancestor of its source commit.

It then runs `--verify` on that live job and records `verified_by: live-successor-cutover` with the replaced job id. Any other failure is reported unchanged, now naming the correct job id (`command[5]`). The lane message says "verified by live successor cutover … which replaced it", never "its own".

10k behaviour: deploy tooling only; one extra read-only monitor call happens only after a failed verify.

## Human feedback

None recorded.

## Reusable lesson

When a production verifier proves a merge live through successors, follow the live pointer's own job and prove ancestry, rather than stopping at the first succeeded successor.
