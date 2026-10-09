---
id: 2026-10-06-benchmark-group-label-used-preview-page-size
date: 2026-10-06
title: Grouped benchmark task labels used preview and page size instead of full totals
surface: front-end
component: benchmark-hub-group-counts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RunsPane and BenchmarkRunView projected their bounded tasks array lengths as whole-group counts
symptoms:
  - 150 task group displayed 100 tasks in the run row
  - 130 completed of 150 tasks displayed 130/100 done
  - detail completion denominator varied with task page size
tags:
  - benchmarks
  - campaign
  - pagination
  - task-counts
sources:
  - commit 5233c125258139b2c71a7d35a8a39d7f30d02984
  - PR #1424 review
  - agent /root/fresh_claude_grouped50_cli
  - plan:.context/fresh-claude-grouped50-20261006/frontend-counts-packet/review.safe.json
repro: front-end/src/tests/blackbox/benchmarks-live-results.blackbox.tsx
status: open
---

## Problem

A 150-task group with a 100-task catalog preview rendered “100 tasks.” Its
130 completed tasks rendered “130/100 done” on the first detail page. The two
new owning blackbox assertions reproduced these exact visible behaviors on
unchanged source: two failed, one existing legacy case passed. This is local
DOM proof, not a claim about the deployed production browser or native fleet.

## Diagnosis

The backend catalog intentionally caps its preview at 100 and carries the full
count in task_total. Detail intentionally pages tasks, carries pagination.total,
and computes totals before slicing. Both frontend owners instead read local
array length as a whole-run count. The first bad boundary is that render
projection; changing backend page size or raising a cap would preserve the
wrong semantics. The general cause is inconsistent aggregate and page scope.

Archive searches were “130/100 done grouped task total RunsPane” and “campaign
preview page full count denominator.” The existing campaign-schedule publication
case is a relative: its first bad boundary was missing published membership.
This case has valid published full-count metadata that the renderer ignores;
no recurrence is established. The process-feedback guide was reread.

## Solution

Read task_total with the existing array-length compatibility fallback in the
run row, including pluralization. Read pagination.total with the same legacy
fallback for the Tasks tile denominator. Keep the whole-run numerator, bounded
rows, API, status aggregates, dispatch and layout unchanged. Delete/unify
assessment: reuse authoritative API fields at their two render boundaries;
no new count store, endpoint, catch, page-cap change or special group branch.

The existing frontend family executes the real components with fetch-boundary
fixtures. Unchanged-source RED uses Vitest on benchmarks-live-results.blackbox.tsx:
2 failed, 1 passed in 5.982 seconds outer. GREEN runs that family plus
benchmarks-hub.blackbox.tsx: 18 passed in 5.485 seconds. The owning case navigates
100/50/100 rows and request offsets 0/100/0 while 130/150 done remains stable.
Legacy task_total/pagination absence and whole-group status aggregation also
pass. Exact pinned Node commands, environment and hashes are in review.safe.json;
RED and GREEN JSON/log originals remain private in the packet. Root independently
verified the same frozen 18 tests in 11.236 seconds and cleared the source.
Source-relative ESLint, Prettier and patch application checks pass.

The existing Vitest include pattern discovers this blackbox family, and deploy
Step4b invokes the full frontend test:coverage runner on frontend changes.
Root integration, checked-in case/index and the next full deployment remain
pending, so status stays open. No native timing or acceptance credit is claimed.

## Human feedback

None recorded for these count findings. Root technical review required private
fixes, full-versus-preview API semantics, existing owning controls and no layout
redesign; independent review confirmed both API fields and real DOM navigation.

## Reusable lesson

Render whole-group metrics from authoritative full totals while reserving bounded arrays for previews and pages.
