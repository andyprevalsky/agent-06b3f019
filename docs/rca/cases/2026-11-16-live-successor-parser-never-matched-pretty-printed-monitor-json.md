---
id: 2026-11-16-live-successor-parser-never-matched-pretty-printed-monitor-json
date: 2026-11-16
title: Fly verify's live-successor path never fired because it parsed the monitor's multi-line JSON one line at a time
surface: harness
component: deploy-production-fly-lane
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run_deploy_pipeline.py _live_successor — json.loads on single stdout lines starting with "{", while back-end/scripts/monitor-cooperative-cutover.ts:279 prints JSON.stringify(report, null, 2)
symptoms:
  - "managed_deployment_pending"
  - "A managed predecessor requires its durable qualified retirement certificate."
  - "monitor-cooperative-cutover.ts --verify failed (exit 1) for job"
tags:
  - fly-cutover
  - deploy-production
sources:
  - commit 765eb3abe5 (#2328 merge; job d345a37c overtaken by live dc4b75d6 at 20f67b1ca9)
  - commit 74aef084ee (#2330 added the live-successor path)
repro: scripts/tests/run-deploy-pipeline.test.py check_production_fly_wait scenarios 7b and 7c (monitor fixture now emits Prisma log lines plus indented JSON)
status: mitigated
---

## Problem

`scripts/deploy production --sha 765eb3abe570 --lanes fly` (#2328) failed even on main
12b77e3e7a, which contains #2330's live-successor fallback. The merge's durable job
d345a37c had SUCCEEDED. A later cutover (dc4b75d6, source 20f67b1ca9, which contains
765eb3abe5) then moved the pointer, so the job's own monitor verify can never pass.

## Diagnosis

`_live_successor` probes `monitor-cooperative-cutover.ts --json`, then walks stdout lines
backwards and `json.loads`es the first one that starts with `{`. The monitor has printed
`JSON.stringify(report, null, 2)` since it was created (191aaa3e12, 2026-09-01), so the
only such line is a bare `{`. The parse fails, the report stays None, and the fallback
returns None.

The test fixture wrote single-line JSON with no log noise, so the scenario passed in CI.
Proof against the real read-only prod output for d345a37c: the old parser returns None;
the new one returns `pointerMatchesExpected=false` and `updatedBy=dc4b75d6`.

Relative: [[2026-11-16-fly-verify-stopped-at-replaced-descendant-generation]] (#2330
added the path; this case is why it never fired).

## Solution

`_live_successor` decodes a JSON object starting at each line-initial `{` with
`JSONDecoder.raw_decode` and keeps the last dict. The run-deploy-pipeline fixture now
emits what the monitor really prints: Prisma INFO lines plus indented JSON. That made
7b red on the old code. A new 7c covers a SUCCEEDED (not superseded) job overtaken by
its live successor. 10k: no runtime effect; this is a deploy-tooling parser.

## Human feedback

None recorded.

## Reusable lesson

A test fixture for a subprocess's output must reproduce that process's real format,
including pretty-printing and log noise. Otherwise the parser it guards can be dead in
production while green in CI.
