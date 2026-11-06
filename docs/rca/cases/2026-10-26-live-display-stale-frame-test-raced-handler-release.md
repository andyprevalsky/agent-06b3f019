---
id: 2026-10-26-live-display-stale-frame-test-raced-handler-release
date: 2026-10-26
title: Live display stale-frame test issued its next request before the previous handler released its lock
surface: harness
component: live-display-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/live_display/test_server.py treated receiving a frame response as proof that DisplayHandler had released predict_lock
symptoms:
  - "test_native_upstream_protocol_and_no_stale_frame"
  - "AssertionError: 429 != 409"
  - "HTTP Error 429: Too Many Requests"
tags:
  - live-display
  - concurrency
  - fixture-lifetime
  - stale-frame
sources:
  - commit b3679ea7be34ce096cc3686b6cb3d03eb746f299
  - agent 6731984c-4b1b-4f4a-9786-65b2f7bbc511 delegated display-gate investigation
repro: scripts/live_display/test_server.py::LiveDisplayTest.test_stale_frame_check_joins_previous_response_handler
status: fixed
---

## Problem

The final deploy structural run failed its `live-agent-display` domain at
`test_server.py:97`: the stale-frame test expected HTTP 409 but received 429.
The four-test domain failed in 1.663 seconds. The original log is
`.context/rca-6731984c/deploy-structural-v2.log`, section `live-agent-display`.
The unchanged isolated test subsequently passed in 0.682 seconds; that pass
did not reproduce or dismiss the gate failure.

## Diagnosis

The path is local HTTP frame request -> `DisplayHandler.do_GET` -> acquire
`predict_lock` without blocking -> upstream prediction or cached frame ->
`send` writes the HTTP response -> `finally` releases `predict_lock`.

The client can consume the complete response before the final release runs.
The original test immediately issued another frame request after consuming a
frame, and again after its cache check. It did not establish that the prior
handler had released its lock. The next request could therefore legitimately
take the HTTP 429 branch before reaching the revision comparison that the test
intended to exercise. This is concurrency exclusion, not a timed rate quota.
Changing the expected status or server exclusion semantics would conceal the
test's missing precondition.

A controlled scheduler retained the second successful handler after its real
response was written, until either the next request observed the busy lock or
the test explicitly joined the handler. The unchanged original test reproduced
`AssertionError: 429 != 409` in 0.326 seconds. The same scheduler and command
passed after the fixture correction in 0.736 seconds:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 .context/rca-6731984c/investigator/display_schedule_probe.py
```

The permanent registered control holds each of the first two handler releases
until the client explicitly waits for frame-idle. Before adding those waits,
the control failed with HTTP 429; afterward the unchanged control passed in
0.869 seconds. It asserts both releases were observed and joined, and that
neither bounded rendezvous timed out. No production response was fabricated.
The original failure did not record thread scheduling timestamps; the
controlled replay establishes the missing synchronization mechanism rather
than claiming to reconstruct its exact historical schedule.

The archive searches were `Frame already generating 429 409 live display`,
`test_native_upstream_protocol_and_no_stale_frame lock response flush race`,
and `live display predict_lock stale frame`. No same-boundary case was found.
`2026-10-15-recording-concurrency-counted-retired-server-handlers` is a relative:
both mistook client response completion for server handler retirement, but
the owning fixture and violated assertion differ.

Golden references use explicit lifecycle synchronization for concurrency
tests: `openclaw/packages/agent-core/src/agent-loop.test.ts:479` separates
`firstStarted` and `releaseFirst` deferred promises;
`codex/codex-rs/core/src/tools/parallel.rs:768` uses a completion notification
and an explicit release; `hermes-agent/tests/cron/test_parallel_pool.py:212`
uses a bounded barrier. The vendored `claude-code-src` snapshot had no matching
test source when searched for test/spec synchronization analogs. The fixture
correction converges on the explicit-entry/release pattern.

## Solution

Only `scripts/live_display/test_server.py` changes. Before issuing the next
sequential frame request, the fixture waits for `predict_lock` to become idle
using the existing three-second request bound, then releases its acquired
lock. All original HTTP-status, revision, cache and upstream-payload assertions
remain unchanged. Original assertion AST SHA256 before and after:
`0ad4c8fb1f4bfa6dba7edc5d034678aac09854bec28d67e2d4a075b02fe6f093`.

Two tests are registered through the existing unittest discovery:

- `test_stale_frame_check_joins_previous_response_handler` forces the legal
  response-before-release schedule and verifies both sequential waits.
- `test_inflight_frame_preserves_429` holds an active prediction lock and
  verifies the real HTTP 429 status and exact error body remain intact.

The permanent controlled regression was run red before inserting the waits,
then rerun unchanged green. Five consecutive full owning-domain runs passed
all six tests with the unchanged canonical command:

```bash
python3 -m unittest discover -s scripts/live_display -p 'test_*.py'
```

The existing `live-agent-display` entry in
`scripts/run-deploy-structural-gates.py` runs that same command. No new suite,
production request ordering, timeout, inference budget, or status semantics
was introduced. At 10,000 agents the production behavior and resource use are
unchanged; synchronization exists only in the local test fixture.

Source patch SHA256:
`3a70199d2f2f63aa8af3bd12dddca6944062faa1b1873b83ecb037fed022ca32`.
Production `server.py` remains unchanged, SHA256:
`7026628541eb9492d3c2d4ef97822bc7392ed0fe32dba49e478cf3863961de5f`.
Original and corrected replay logs, permanent-control logs and five domain
receipts are retained under `.context/rca-6731984c/investigator/display-*`.
The parent owns review, combined deployment and archive reindexing; this
delegated lane deliberately does not edit the shared index.

## Human feedback

The assignment required preserving HTTP expectations, bounds and production
semantics; permitted an ordinary test correction and this one archive entry;
and reserved shared index updates and deployment for the parent.

## Reusable lesson

Establish handler retirement explicitly before a sequential HTTP fixture asserts behavior that requires the previous handler's lock to be free.
