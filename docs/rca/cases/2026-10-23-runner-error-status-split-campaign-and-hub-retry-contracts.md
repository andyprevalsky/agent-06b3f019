---
id: 2026-10-23-runner-error-status-split-campaign-and-hub-retry-contracts
date: 2026-10-23
title: A first-run agent failure was recorded as runner ERROR, retried as infra by the campaign, and 409'd by the Hub, which reads runner ERROR as a graded failure
surface: cross
component: benchmark-campaign-hub-retry
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py::_run_auth_test_site_first_run raised a generic AuthTestSiteFixtureError for the task's own first-run agent failure, which run_single_task records as benchmark_status ERROR; the Hub taskSummary then projected that uppercase ERROR as graded failed while the campaign and fleet card treat it as infrastructure
symptoms:
  - "Benchmark Hub retry requires a contiguous released infrastructure-error attempt with unchanged membership"
  - "HubVisibilityError: benchmark Hub upload failed: HTTP Error 409"
  - "no current run artifact produced"
  - "first run did not complete (status=ACTIVE, reason=Tool 'spawn_browser_agent' exceeded its exact root call limit"
tags:
  - benchmark-campaign
  - hub-publication
  - retry-classification
  - auth-test-site
  - two-run-task
  - status-vocabulary
sources:
  - fleet run original600-1792722242636117810 (shard-00 job r001-j0028, attempts 20261023-024011-28244 and 20261023-030159-9594)
  - agent bcd9d7a7-dfbd-4f3f-84e1-0ad32f3340fd
  - commit 3cf4aed97 (campaign retry predicate) and 57b2298a3 (Hub retry admission)
  - fleet run descend-full69-20261023 cluster K7 (Render request 069827777bd3 POST /api/benchmarks/runs -> 409)
repro: scripts/tests/campaign-hub-grouping.test.ts "a released runner ERROR attempt is the infrastructure attempt its campaign retry registers" and the 409 response_error assertion in "an unpublished final operator group fails fast with its Hub receipt"; agents/tests/blackbox/auth_test_site_benchmark.blackbox.py test_first_run_agent_failure_is_a_graded_task_failure
status: fixed
---

## Problem

Member task: `browser-auth-created-account-reused` (descend-full69-20261023, cluster K7).
In the sharded `/benchmark full` run on cbbf3dd0c, job `r001-j0028` attempt 1
really ran: the task's first-run agent `bcd9d7a7` called `spawn_browser_agent`
twice against an exact limit of 1, and `run.json` recorded
`benchmark_status: ERROR, passed: false` with
`first run did not complete (status=ACTIVE, reason=Tool 'spawn_browser_agent' exceeded its exact root call limit ...)`.
`summary.json` recorded attempt 1 as `task_status ERROR, infra_failure true,
terminal_task false`, so `--retry-infra` launched attempt 2. Attempt 2's
`hub_upload.register_starting_run` got `HTTP Error 409` (non-retryable) and the
controller exited after 18 s with no run artifact; the job's final result became
`INFRA_ERROR "no current run artifact produced"` — the shard's only infra job.
The 409 body was not logged; Render logs for request `069827777bd3` show
`BenchmarkHubConflictError: Benchmark Hub retry requires a contiguous released
infrastructure-error attempt with unchanged membership`. The Hub stored attempt 1
as `passed: false, status: failed` (read back from the prod Hub).

## Diagnosis

Critical path: `_run_auth_test_site_first_run` → `run_single_task` except path →
`TaskResult(status/benchmark_status=ERROR, passed=False)` → fleet report card
(`error`, passed null) and terminal Hub upload (`ERROR`, passed false) →
campaign `released_attempt` → retry → Hub `validateGroupAttempt`.

1. First bad data: the first-run agent's own failure (an early-fail contract
   violation or non-COMPLETED status) raised the generic fixture exception, so the
   runner labelled a genuine agent outcome as an untrusted `ERROR`. The graded run
   scores the same agent result `FAILED` (early_fail → passed=False → FAILED).
   Repro: `run_single_task` with the real first-run path → `('ERROR','ERROR')`.
2. Why the retry 409'd: three consumers disagree on runner `ERROR`. The campaign
   (`status in {INFRA_ERROR, ERROR}`), `cloudbench-aggregate-runs.py` and the
   fleet card (`error`, passed null) treat it as infrastructure; the Hub
   `taskSummary` only recognised `INFRA_ERROR`/lowercase `error`, so the terminal
   `ERROR` + archived `false` sentinel became graded `failed`, and
   `validateGroupAttempt` (which requires `passed === null`) rejected the retry.
   Repro: real Hub store, runner `ERROR` attempt → `[false,'failed']`, then the
   retry rejects with the exact production message. So every runner-ERROR retry
   was doomed to replace a diagnosable attempt with an artifact-less INFRA_ERROR.
3. Why it was opaque: `_safe_http_error_metadata` deliberately never read the
   body, so receipts carried only status/correlation headers.

Deepest owned cause: two vocabularies for one outcome (runner `ERROR` vs card
`error`) with the Hub projection keyed on only one spelling, plus a fixture
exception class that conflated "the agent failed the task" with "the fixture
could not be prepared". Relative of 2026-10-19-sharded-operator-published-non-hub-group-status
(producer/Hub vocabulary drift), not a recurrence.

## Solution

- `auth_test_site.AuthTestSiteFirstRunFailed` (subclass of the fixture error);
  `_run_auth_test_site_first_run` raises it for the agent's own failure and
  `run_single_task` records it as a graded `FAILED` (passed false), matching the
  graded run. Fixture faults (foreign snapshot identity, preparation, cleanup
  failures) stay `ERROR`.
- Hub `taskSummary` treats runner `ERROR` as the same infrastructure terminal as
  `error`/`INFRA_ERROR` and stores it as `error`; the Python mirror
  `hub_upload.final_record_matches` changes identically. Live, final and
  campaign-retry views now agree, so a released runner-ERROR attempt admits its
  retry (sibling: every exception-path ERROR retry).
- `hub_upload` adds a bounded `response_error="<Hub reason>"` (4xx JSON `error`
  string only, ≤300 printable chars) to upload failures.
Golden reference: `claude-code-src/src/services/api/logging.ts:51` surfaces the
server's error-body message; converges.

## Human feedback

None recorded.

## Reusable lesson

Give each benchmark outcome one canonical status spelling across runner, fleet card, campaign and Hub, and never let an agent's own task failure travel through an exception path that every consumer reads as infrastructure.
