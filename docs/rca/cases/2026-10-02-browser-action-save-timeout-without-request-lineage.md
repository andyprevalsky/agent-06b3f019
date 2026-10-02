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

## Human feedback

The user accepts genuine benchmark FAILURE but requires zero infrastructure
errors, complete durable evidence and correct teardown. Infrastructure timeout
headroom of about 20% is authorized; harness limits are unchanged. Keep permanent
verification compact and avoid unnecessary campaign resets or repeated runs.

## Reusable lesson

Give each persistence call a shared worker/backend identity before attributing
an acknowledgment timeout, and distinguish repaired observability from a
proven latency fix.
