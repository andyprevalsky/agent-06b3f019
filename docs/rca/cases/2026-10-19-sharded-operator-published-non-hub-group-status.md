---
id: 2026-10-19-sharded-operator-published-non-hub-group-status
date: 2026-10-19
title: Sharded operator published final Hub group status "completed", which the Hub rejects as a retryable 500
surface: cross
component: benchmark-campaign-hub-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-original600-controller.py::sharded_run derived the final run_group.status "completed", outside the Hub schedule contract (passed|failed|cancelled)
symptoms:
  - "Hub group publication · final group NOT published"
  - "Invalid Benchmark Hub group schedule"
  - "POST /api/benchmarks/runs -> 500"
  - "HubVisibilityError: benchmark Hub upload failed: HTTP Error 500"
tags:
  - benchmark-campaign
  - sharded-operator
  - hub-publication
  - terminal-window
  - retry-classification
sources:
  - fleet run original600-1792433794419199295
  - commit 2e498b63f (introduced the sharded final publication)
repro: scripts/tests/campaign-hub-grouping.test.ts "a completed sharded run publishes its final operator group", "an unpublished final operator group fails fast with its Hub receipt", "a deterministic Hub record rejection fails fast instead of consuming the terminal window"
status: open
---

## Problem

A 36-copy, two-controller sharded run finished cleanly (both shard exit codes 0,
36/36 jobs observed, no abort or terminate), yet `result.json` recorded
`hub_group_final_published: false` with no reason, and the scorecard showed
"🟠 Hub group publication · final group NOT published".

`hub-group/hub-group-publication.private.log` shows 22 POST attempts from
19:02:19Z, each `HTTP Error 500`, with jittered backoff until the 900 s terminal
window expired. The final record `hub-group/hub-group.json` has
`run_group.status: "completed"`. Render logs for request `e839e4474d96` (Hub group `original600-1792433798106589994`) show the
Hub rejecting it in 2 ms:
`Error in request ... "Invalid Benchmark Hub group schedule" at runGroupSchedule
(benchmarkHubRunProjection.js:112)`, mapped to status 500 by the default
handler in `server.ts`.

## Diagnosis

Critical path: operator `sharded_run` → `publish_shard_group` →
`run-bench-campaign.campaign_group_state/campaign_group_record` →
`hub_upload.py --upload-final` (900 s patient window) → `POST /api/benchmarks/runs`
→ `hubStore.putRun` → `runGroupSchedule`.

1. First bad data: `sharded_run` passed
   `status='completed' if not merged['missing_jobs'] else 'failed'`. The Hub's
   schedule contract accepts only `running|passed|failed|cancelled`; the
   single-controller campaign uses `passed|failed|cancelled`. Replaying the exact
   evidence record through the real `runGroupSchedule` rejects it; changing only
   `status` to `passed` is accepted.
2. Why it consumed the window: `runGroupSchedule` throws a plain `Error`, so the
   permanent contract rejection became HTTP 500. The uploader correctly retries
   5xx (same as the Claude Code reference, below), so it replayed a request that
   could never succeed for the full 900 s.
3. Why there was no reason: `hub_upload.py` raised `HubVisibilityError` and
   exited nonzero; `publish_campaign_group` swallowed that as a False return with
   only a stdout "pending" warning; the operator then stored
   `hub_group_final_published=False` without the log path or failure line.
4. Why tests missed it: `original600-portable-operator.test.py` patched
   `publish_shard_group` with a fake and asserted `'completed'`, pinning the bug.
   `campaign-hub-grouping.test.ts` drove the real Hub routes and store but passed
   a hand-picked `status: "failed"` instead of the operator's own derivation.
   No producer-side check bound the record to the Hub vocabulary.

Sibling found at the same boundary: `publish_campaign_group(live=True)` never set
`completed`, so the operator's `hub_group_registered` was always false even when the
schedule registration was acknowledged.

Proof scope: Render logs were read for the first of the 22 attempts
(`e839e4474d96`); every attempt posted the identical gzip payload, so the same
deterministic rejection applies. Replaying the exact record through the
validator rejects only `run_group.status` (36 members, 36 `passed` outcomes,
valid times).

Archive searches: "Invalid Benchmark Hub group schedule",
"hub group final publication not published terminal window sharded",
"deterministic 500 retried retryable hub upload validation 400". Relative (not a
recurrence): 2026-10-06-campaign-cancellation-left-terminal-hub-status-stale.

## Solution

- Operator: `shard_group_status()` uses the single-campaign vocabulary
  (operator stop → `cancelled`; missing job, abort/terminate or nonzero shard
  exit → `failed`; otherwise `passed`). The final publication is extracted into
  `publish_final_shard_group()`. If the group is not published, the result always
  includes `hub_group_final_error` (the refusal, or the publisher's last log
  line with its request id) and `hub_group_final_log`. The scorecard shows the
  reason.
- Producer contract: `campaign_group_record` (used by every producer) refuses a
  status outside the Hub group/outcome vocabularies with a `ValueError` naming
  the value. This happens before any write or upload.
- Hub: schedule/membership validation and malformed bundles (`run_id`, `tasks`)
  throw `BenchmarkHubInvalidRecordError` (statusCode 400), so any client fails fast on a permanent rejection instead
  of replaying it for the full window. Golden reference:
  `claude-code-src/src/services/api/withRetry.ts:696-786` retries
  408/409/429/5xx, but never a plain 400. Our uploader's
  `_retryable_upload_error` already matches it, so the Hub's status code was
  the defect.
- Hub: upload conflicts with stored group/run state (`group ID collides`,
  `group schedule changed`, `membership changed`, `member differs`, retry
  ownership in `benchmarkHubGroupAttempts.ts`) throw
  `BenchmarkHubConflictError` (409). Internal index-integrity faults stay 500.
  `benchmarkHubStore.base.ts` is the hash-frozen PR1480 comparison copy and was
  not edited.
- The operator receipt reads only the log bytes appended by the final
  publication (the live registration shares that log), so a stale success line
  cannot become the "reason".
- Live registration success now uses the same publisher acknowledgement as the
  terminal record.
- Behaviour change: `run-bench-fleet start_central_hub` runs
  `--register-starting ... || return 1`, so a malformed starting record now
  stops fleet start immediately instead of logging "pending" after 500 retries.

Regression (owning gate `benchmark-campaign-grouping`,
`scripts/tests/campaign-hub-grouping.test.sh`): the operator's actual
`publish_final_shard_group` for an all-green two-shard run, through the real
routes, store and uploader, must publish with group status `passed`. A
`completed` record must fail in under 15 s with `HTTP Error 400` and no
transient retry, and the producer must refuse it by name. On the buggy variant,
the first case failed with `hub_group_final_published: false` after 22 s of 500
retries. The second retried for its 60 s window. After the fix, both pass in
2.8 s. A conflicting final schedule must return
`hub_group_final_published: false` within 15 s, with an `HTTP Error 409`
receipt and the log path. On the buggy store it got a 500 that was retried for
the full window. The buggy variant used for case 1 was this branch with three
reversions: `'completed' if not missing_jobs else 'failed'`, the main
`benchmarkHubRunProjection.ts`, and no producer guard. Unchanged `main` has no
`publish_final_shard_group` to call. A table test
(`original600-portable-operator.test.py`) covers every `shard_group_status`
branch. The backend blackbox covers the deployed 400; the scorecard test covers
the rendered reason.

Still open:
- Outcome proof: there is no post-fix sharded cloud run with
  `hub_group_final_published: true` yet.
- The incident's own prod group `original600-1792433798106589994` was
  registered live at 18:16Z. Its final record was never accepted, so it most
  likely still shows `running`. Republishing the evidence record with the
  correct `passed` status would repair it; that is a prod Hub write left to
  the parent.
- If `coordinate()` raises (or export/merge fails), `sharded_run` never
  reaches the final publication and the group stays `running`. This predates
  the change and belongs to the same class; it is not fixed here.
- Under `--retry-infra`, group outcomes mean infrastructure health. The group
  shows `passed` even when task verdicts fail, matching single-campaign
  semantics.

10k-agent behaviour: constant per campaign publication (one status derivation,
one record validation and one request). A rejected record no longer costs about
22 requests during a 15-minute window.

## Human feedback

None recorded.

## Reusable lesson

Build a cross-service status enum from the consumer's contract at the producer,
and return permanent validation rejections as 4xx; a 500 makes patient clients
spend their whole retry window replaying an unfixable request.
