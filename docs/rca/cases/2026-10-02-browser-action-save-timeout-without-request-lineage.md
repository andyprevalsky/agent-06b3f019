---
id: 2026-10-02-browser-action-save-timeout-without-request-lineage
date: 2026-10-02
title: Browser-action save timeout lacked per-request HTTP attribution
surface: agents
component: browser-action-message-persistence
classification: undetermined
problem_class: other
first_bad_boundary: A browser-action message ReadTimeout had no matching per-call HTTP trace identity
symptoms:
  - "Failed to save browser action message"
  - "ReadTimeout"
  - "message POST parent_span_id undefined"
tags:
  - browser
  - message-persistence
  - tracing
  - cloud-fleet
sources:
  - PR #1299
  - fleet run 20261002-065535-28594
  - fleet run 20261002-072906-22822
  - fleet run 20261002-083414-9201
  - fleet run 20261002-091933-1152
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

One benchmark in the ten-task fleet slice logged a browser-action message save
ReadTimeout during execution. Its 81 completed LIVE model queries and evaluated
task result did not make the infrastructure failure acceptable. Native cleanup
was verified separately. The failure was an expired five-second acknowledgment
wait, not a teardown timeout.

The worker recorded a successful first navigation immediately before the failed
save. Exactly one later durable FINISHED row matched its title, task, tool call,
step and workflow generation. Its message and metadata form a private 536-byte
semantic replay candidate; the original HTTP wire bytes were not captured.

## Diagnosis

The latency cause remains open. The saved row and neighboring backend request
timings do not establish which operation delayed the failed acknowledgment.
The worker error belonged to the entire browser activity. Other backend calls
carried that activity's parent span, but none of its message POSTs did:
`save_browser_action_message` constructed headers without the existing tracing
helper. Adding the activity parent alone would still leave multiple saves
under one identity when no request ID was bound.

A subsequent unchanged diagnostic completed 68 correlated LIVE queries, genuine
evaluation, durable evidence and cleanup without this error. Its slowest message
POST took 5.477 seconds and correlated with a lifecycle producer using a
30-second timeout, not the browser-action saver. Its smaller cache-write count,
different message traffic and measured profiler overhead prevent treating it
as a reproduced failure or a causal fix. It earns zero campaign credit.

Archive searches used the literal save-error text and the HTTP-parent-span /
persistence-attribution symptom. The recording ConnectTimeout case is related
but concerns a failure before sending the request; its retry cannot be applied
to an ambiguous ReadTimeout. No completed cause for this latency was established
by those archive hits.

## Solution

The attribution gap is corrected using the existing `@traced` decorator and
`tracing_headers()`. Each save has a child span shared by the worker error and
the backend request's parent. Message content, titles and browser URLs are not
added to logs. Timeout, retry, payload, generation and return-value behavior
remain unchanged.

The registered browser-agent blackbox
`test_browser_action_save_correlates_each_http_call_and_failure_without_payload_logs`
failed before the correction because the outgoing parent header was absent.
The identical test passes afterward. It covers two calls under one activity
with no request ID, a failed acknowledgment, a successful acknowledgment,
distinct per-call identities, error attribution, restored context and no
payload logging. Existing connection-retry and ambiguous-timeout controls also
pass. This is causal proof for the attribution defect only.

The full agents gate exposed a structural-test gap: the generation-header
checker rejected the tracing spread as unknown, despite the generation header
remaining present. Its focused reproduction failed before the checker recognized
the canonical helper. The correction verifies that helper's disjoint tracing
keys, rejects local shadowing and untrusted helpers, and preserves every existing
unknown-spread and case-insensitive overwrite rejection. This changes test
recognition only; production header and timeout behavior remain unchanged.

The remaining latency investigation must recover the concurrent condition that
caused the stall. A fast payload-only replay or another clean live run cannot
close that gap. Original and diagnostic logs, payload candidates, profiles and
archive receipts remain private.

The recovered two-envelope HTTP probe subsequently passed on unchanged source:
the real saver acknowledged IN_PROGRESS in 148.2 ms and FINISHED in 109.7 ms.
Both persisted envelopes matched; broadcasts reached only the owned loopback
fixture. This rules out those semantic inputs and the isolated persistence path
as a sufficient reproduction. It does not recreate the original concurrent
traffic or explain the multi-second delay. The probe's temporary database and
processes are separately owned and cleaned, with zero benchmark credit.

The next ten-task fleet slice reproduced two save ReadTimeouts in one task.
The new per-call spans identify the exact backend requests: their traced starts
occurred 9.735 and 11.637 seconds after the corresponding worker save starts.
Message creation then completed within 217 and 919 ms. Both processes ran on
the same guest and used localhost; 38 matched saves had a median apparent
pre-tracing delay of 51 ms. A fixed clock offset cannot explain the two outliers.
Tracing begins after the JSON parser, so these measurements do not separate
socket admission, parsing, event-loop scheduling or other synchronous work.

The backend continued servicing other requests during the affected interval,
with several gaps of one to 3.4 seconds. Concurrent browser cache recording
completed 450 writes containing 14.8 MB of response bytes across 226 keys.
Those totals alone do not prove cache contention. The archive deliberately
omits browser HTTP cache bodies, and the retained logs lack original write-start
times. Current last-write values cannot reconstruct all historical versions or
the original arrival schedule. Do not substitute an invented load profile for
the missing causal reproduction. The slice remains rejected despite 483
completed LIVE queries, at least four per task, and verified native cleanup.
A separate durable publication returned HTTP 403; it is not evidence about the
message-save latency cause.

### Exact diagnostic and browser target initialization

The next unchanged task diagnostic reproduced the execution failure. Its exact
save span started at 09:26:04.159933 UTC and raised ReadTimeout at
09:26:09.249880, after 5.089947 seconds. A metadata-only observer before Express
first received that span's request at 09:26:09.457, 5.297067 seconds after the
worker start and 207 ms after its timeout. The 614-byte request body finished
0.401 ms later; its response closed without finishing. This is callback timing,
not a measurement of kernel socket arrival.

CPU profiles sampled the actual backend during this failure. The two critical
segments attributed 9.671 of 20.776 seconds and 7.654 of 21.421 seconds to
Playwright's new-target initialization and init-script send ancestry. The
synchronous work included WebSocket serialization, byte-length calculation,
framing and writes. Measured event-loop delays reached 7.025 and 5.385 seconds.
Archive encryption was absent from those critical ancestor sets; sampled cache
clones accounted for only about 30 and 24 ms. The earlier cache totals therefore
do not support a cache-path repair.

The same backend had transferred 41,255,356 raw IndexedDB bytes through 50
acknowledged bounded scripts. Playwright retains context init scripts and
submits them again when initializing attached targets. The diagnostic did not
record exact target counts or every replayed byte, and its observer added
nonzero overhead. A real Chromium/CDP regression is required to prove that
transport mechanism and preserve storage restoration before changing it.

The diagnostic evaluated a genuine task FAILURE with 17 completed LIVE queries,
published durable evidence and retired its owners. Whole-run E2E was 571.1
seconds; allocation through durable verification and teardown was 516.2 seconds.
The execution ReadTimeout still makes it INFRA, with zero campaign credit.
Private correlation, profiler, origin-transfer and retirement receipts are
retained under `.context/acceptance/proof110-*`. Archive searches were
`ReadTimeout browser.save_action_message` and
`Playwright init scripts new frame replay retained storage`; the September 30
origin-memory case and July 2 connection-scoped injection case are related
owning boundaries, not substitutes for the new reproduction.

The subsequent actual Chromium/CDP reproduction and storage repair are recorded
in the September 30 browser-origin-injection case. The same frozen test observes
2.10 MB replayed to an unrelated page before the repair and zero bulk replay to
unrelated pages or frames afterward, while preserving storage and page ownership.
This proves the retained-payload transport defect. A fresh cloud run is still
needed to establish its effect on the execution save timeout; neither that test
nor the earlier sampled profile proves the complete original delay by itself.

## Human feedback

The user accepts genuine benchmark FAILURE but requires zero infrastructure
errors, complete durable evidence and correct teardown. Infrastructure timeout
headroom of about 20% is authorized; harness limits are unchanged. Keep permanent
verification compact and avoid unnecessary campaign resets or repeated runs.

## Reusable lesson

Give each persistence call a shared worker/backend identity before attributing
an acknowledgment timeout, and distinguish repaired observability from a
proven latency fix.
