---
id: 2026-10-21-stuck-report-retry-current-daily-cap
date: 2026-10-21
title: Successful retries of old stuck-report claims escaped the current daily budget
surface: back-end
component: repoAgentBugReports
classification: our-bug
problem_class: other
first_bad_boundary: countStuckAgentBugReportsBetween counted immutable claim creation instead of current admission
symptoms:
  - "a successful retry must exhaust the current daily cap"
  - "stuck-agent reports count a successful old-claim retry against the current daily cap"
tags:
  - stuck-agent
  - report-bug
  - daily-cap
  - retry
sources:
  - PR #1562
  - commit ebe268215f366199ee0df4d753b149951f437298
repro: back-end/src/tests/blackbox/agents-stuck-bug-report.cases.ts
status: fixed
---

## Problem

The rolling 24-hour admission count used the original claim creation time.
A failed claim created two days ago could be successfully retried today, yet
not count against today's budget. With 19 current successes plus that retry,
the next cron tick incorrectly launched another report.

## Diagnosis

The path is persisted FAILED claim -> due retry claim -> launch success -> next
cron's repository budget count -> launch admission. Claim reclamation preserves
createdAt intentionally, while updating updatedAt at admission. Filtering
createdAt was the first incorrect boundary: the successful retry disappeared
from the current count even though its launch happened inside the window.

The isolated fixture seeds a due old FAILED claim and 19 current successes,
reclaims through the real repository, records success with an explicit clock,
then executes the next cron tick against the real isolated database and a fake
external launcher. No production launch or paid session is necessary.
The final fixture does not mutate timestamps after recording success.
An earlier fixture incorrectly assumed the service's option clock replaced its
wall clock; its failing diagnostic logs are retained but excluded from proof.
The corrected fixture tests the repository's explicit clock contract directly.
Parent independent review confirmed the real claim/mark API boundary and found
no new blocking issue, contingent on final repeated and affected-gate receipts.

Archive searches `stuck report retry daily cap createdAt updatedAt` and
`retry launch admission timestamp daily window` found no exact prior case.
This is a new time-window accounting defect. Golden-reference exact equivalent
is N/A. Related mechanisms examined: OpenClaw
`extensions/a2a/src/http.ts:160` records current request admission timestamps;
Hermes `apps/desktop/electron/window-renderer-lifecycle.ts:146` records current
reload attempts, and `tools/process_registry.py:930` uses current window time.
These support counting the current attempt rather than original object age,
without prescribing this repository's claim schema.

## Solution

Count STARTED/SUCCEEDED automatic claims using updatedAt within the same window.
Explicitly set updatedAt to the successful launch time in the ownership-guarded
success update. Preserve createdAt, source filtering, owner checks, failure
backoff, candidate age, and launch cap. Existing daily-cap fixture now assigns
both creation and update timestamps to its intended historical window.

Verification receipts are retained in `.context/stuck-report/review-fixes/`.
The unchanged command is `bash .context/stuck-report/qualify-final-sync-agents.sh`.
The baseline exits 1 with 265 passed / 1 failed / 266 total at the exact
extra-launch assertion; measured stage wall clock is 41.6 seconds. Five
unchanged final runs each pass all 266 cases (exit 0), in 42.006, 42.054,
42.718, 41.904, and 42.269 seconds. Receipts: `cap-baseline-frozen.log`,
`cap-frozen-pass-1.log` through `cap-frozen-pass-5.log`,
`cap-causal-proof.json`, and `cap-frozen-five.json`. The latter records the
same runtime and test SHA256 in every run. Final Prettier, affected ESLint,
TypeScript, report-bug unit test and full backend structural gates pass.
Broader backend coverage is rerun on the committed candidate; its receipt
will preserve the previously authorized Steel-only funding waiver if needed.
Registration is the existing agents blackbox domain, included in backend
coverage. No new suite or skip is introduced.

At 10k agents the query is still one existing database count per cron tick,
with the same predicates plus a different timestamp column. This does not add
per-agent queries or launch calls. No strict cross-replica global budget is
claimed: concurrent cron invocations and the existing 14-day candidate lookback
remain existing limits. Production retries crossing a day boundary still need
live observation after release. No index or migration is introduced.

## Human feedback

The parent required consistent clock use and unchanged causal regressions,
preserved the narrow Steel-only waiver, and prohibited review-ledger resets.
No new prompt change or generic runtime approval gate was requested.

## Reusable lesson

Rate-limit retry admission by the current attempt timestamp, not the immutable
creation time of the reused idempotency record.
