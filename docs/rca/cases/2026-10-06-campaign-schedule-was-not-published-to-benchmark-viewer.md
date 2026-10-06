---
id: 2026-10-06-campaign-schedule-was-not-published-to-benchmark-viewer
date: 2026-10-06
title: Independent campaign children appeared as separate benchmark runs
surface: cross
component: benchmark-campaign-hub
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run-bench-campaign retained its schedule locally without publishing campaign membership
symptoms:
  - one fifty-copy CLI campaign appeared as separate frontend run rows
  - missing child publications hid scheduled copies
  - repeated identical task names had no campaign member identity
tags:
  - benchmarks
  - campaign
  - frontend-status
  - publication
sources:
  - PR #1422 follow-up
  - fleet run 20261006-180139-2969
repro: scripts/tests/campaign-hub-grouping.test.sh
status: mitigated
---

## Problem

The fifty-copy CLI campaign created fifty independent fleet run IDs with no
shared published group identity. Authenticated runtime catalog observation
found five published terminal rows, each a separate one-task run. Missing
publications were not represented by the local scheduler's full task list.
This did not prove task execution or successful publication for all fifty.

## Diagnosis

Runtime evidence was collected before archive searches for campaign parent
registration and benchmark viewer grouping. The
[unregistered-parent case](2026-09-09-campaign-synthesized-unregistered-hub-parent.md)
forbids inventing a parent ID that disables child-owned publication. Here the
local scheduler had a valid complete schedule, but did not publish it or
immutable child membership. Grouping by task name or timing would also merge
unrelated campaigns and lose repeated copies.

The unchanged supported scheduler/upload/Express API controls produced five
behavioral failures and one passing history inverse on the original source,
then six passes after repair. Unchanged frontend controls failed twice before
repair and passed twice afterward. These were behavioral assertions, not
missing imports or unavailable new test functions.

## Solution

The scheduler publishes a real Hub schedule and assigns each child a stable
campaign/member identity. Child starting, live and final publication and exact
guest ACK ownership stay independent. The viewer projects compact child
summaries into one group, preserving distinct repeated rows and child links.
Early evaluator PASS/FAIL remains visible before teardown. Missing terminal
controller results use genuine controller facts and never imply resource release.

Immutable membership, final-state absorption, original elapsed time and bounded
paging protect recovery and live updates. Raw internal catalog and legacy API
contracts stay intact, so task-selection history beyond one hundred rows is not
lost. Group polls read no archived child bundles. Ten-thousand-member metadata
is covered without adding a live workload.

The six compact scheduler/API controls run in `scripts/test.sh`; the two viewer
controls run in ordinary frontend blackboxes. Existing fifteen Hub ownership
and three cancellation/reaping controls also passed. Root integration exposed
a test dependency-resolution difference hidden by the private candidate's
module link; dependencies now resolve through the backend package owner.
Native fifty-copy execution, frontend deployment and release proof remain
outstanding, so this case is mitigated.

## Human feedback

The user required every CLI batch to remain together in the frontend viewer,
correct live states, immediate PASS/FAIL before cleanup, compact permanent
deploy tests and parallel optimization. Avoid invented completion and
unnecessary acceptance resets.

## Reusable lesson

Publish immutable campaign membership while preserving each child's independent result and cleanup owner.
