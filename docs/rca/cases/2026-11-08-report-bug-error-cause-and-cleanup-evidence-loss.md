---
id: 2026-11-08-report-bug-error-cause-and-cleanup-evidence-loss
date: 2026-11-08
title: Report-bug tests discarded fetch causes and could replace primary failures during cleanup
surface: back-end
component: report-bug-blackbox
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: report-bug.blackbox.ts runTest discarded stack and cause, while finally cleanup could replace a primary exception and the screenshot test name did not identify the failed operation
symptoms:
  - "FAIL POST /report-bug/screenshots -- signed URL serves the image: fetch failed"
  - report-bug 12/13 passed with no failed-fetch stage or nested cause
  - primary test failure replaced by cleanup failure
tags:
  - report-bug
  - screenshot
  - signed-url
  - fetch-failed
  - cleanup
  - error-cause
sources:
  - PR #1770
  - PR #1781
  - commit 2bea5aa71b4d16921816d59ab32a616bb1f8555d
  - commit 49c2c60cec3137ae52762b4a544676be759852bb
  - commit 5066feea73da4a966aa7655ccbc40ea8c26529a8
repro: back-end/src/tests/blackbox/report-bug.diagnostics.cases.ts; unchanged original report-bug case on 2bea5aa71 for the transport outcome
status: fixed
---

## Problem

The original Blacksmith backend-coverage-blackbox gate on 2bea5aa71 failed only
report-bug's signed-image case with `fetch failed`: 248 selected domains ran,
247 passed, report-bug 12/13; units, FPS, coverage threshold and teardown passed.
The native result was complete, cleanup complete and exit 1. Its domain took
7771 ms; the artifact did not record that case's duration or failing stage.
The private handoff tarball SHA256 remains
258b079e8315ca3e716ae5b7954a3fe8a77bc248632c6d33118e2b28324f0128.
Original bytes, results and producer timestamps are preserved privately.

The case performed fixture creation, multipart upload/JSON read, signed GET/body
read/byte comparison, and fixture deletion. `runTest` returned only error.message.
A throwing cleanup in `finally` could replace an earlier exception. Successful
upload or failed signed retrieval could not be inferred from the case name.

## Diagnosis

The native historical packet remains unlocalized; its failed stage is NOT ASSERTED.
The owning failure was independently reproduced on byte-clean 2bea5aa71 with the
unchanged 13 cases and scoped, non-mutating Undici event capture. In a bounded
sequence, attempts 1-7 passed and attempt 8 failed the same named case, 12/13,
with `fetch failed` in a 7601 ms domain run. The captured sequence was:

- upload HTTP 201 and body complete at 11:31:47.933Z;
- signed GET HTTP 200 and body complete at 11:31:48.253Z;
- fixture cleanup DELETE failed ECONNRESET at 11:31:53.069Z after 4816 ms.

Thus the reproduced failure belongs to cleanup, after the image assertions passed.
The backend logged fixture-triggered greps of the captured report-bug alternation,
then synchronous analysis gaps. Its 48.041Z-53.056Z interval blocked request service
for 5.015 seconds. Queued Prisma completions measured 1013/2017/3028/4018/5024 ms.
The upload response's default five-second keep-alive expiry fell inside that gap;
the DELETE reset followed the gap by 13 ms. PR1781's owner reviewed this exact
packet and explicitly confirmed a mechanism MATCH for this reproduced occurrence,
while retaining the historical packet's localization gap.

Causal intervention reused PR1781's already merged regexSafety.ts, validate.ts and
service.ts only, on the original snapshot. The original report-bug test file,
fixtures, HTTP/status/schema/byte assertions and cleanup DELETE remained unchanged.
All eight post-intervention repetitions passed all 13 checks. The existing merged
data-grep responsiveness regression was also run unchanged apart from a private
measurement print. Before: FAIL on its retained expected-400 assertion (some
analyses returned 200), with measured worst /health latency 7712 ms. After: PASS,
eight HTTP 400 responses and worst /health latency 13 ms. No latency assertion,
pattern, deadline or concurrency was weakened. This verifies the reproduced
shared-event-loop failure and reuses the existing repair rather than duplicating it.
See the existing grep-regex-safety-blocked-event-loop case for that product cause.

The separate evidence-loss boundary has its own fail/pass proof: the same eight
permanent diagnostic regressions pass 1/8 against message-only/naive-finally
behavior and 8/8 against stage/cause/cleanup preservation. They require original
cause identity, transport code/stack, separate headers/body stages, both primary
and cleanup failures, cleanup-only rejection and signed-URL redaction. Five
consecutive full report-bug domain runs passed 23/23, including all original
assertions and the existing no-agent-run/history-cleanup guards.

Archive searches used `fetch failed report-bug` and `screenshot signed URL retrieval`.
PR1760's fixture accumulation case was a related lead and initially excluded this
unlocalized occurrence. PR1781's owner initially had no verified match either;
only the new captured failure and intervention establish the reproduced match.
No provider outage, credits, auth, storage or heap cause was inferred.

The evidence-loss ladder stops at the runner: message-only rendering erases causes;
a throwing finally block replaces the pending exception; no regression required
preserving both errors or body-read stages. The owning regressions now cover those
contracts. This is separate from the already merged synchronous-regex repair.

## Solution

The existing report-bug suite now labels fixture creation, upload headers/body and
assertions, signed-image headers/body and byte comparison, and fixture cleanup.
Cleanup runs once and retains primary plus cleanup errors through AggregateError;
cleanup-only failure still fails. Error rendering retains sanitized messages,
stack frames, codes and nested/aggregate causes. URLs, signed object paths, known
credentials and embedded status-response bodies are redacted. Graph and output
bounds prevent unbounded diagnostics. There is no I/O logger, retry, transport
policy change, deadline change, test serialization or assertion relaxation.

Current main already includes PR1760's local fixture rows/no-live-chat cleanup and
PR1781's off-event-loop regex analysis. Those product fixes are reused. The new
observability regressions register inside the existing report-bug domain and run
through the full backend deploy gate; no separate suite replaces acceptance.

Before these diagnostic edits, current main 5066feea7 passed the exact original
`cd back-end && npm run test:coverage:sharded`: 248/248 domains, report-bug 15/15,
374 unit files, FPS, thresholds and four teardown checks. Original-source native
replay 42474812178 also completed exit 0 with all checks and cleanup complete.
An earlier diagnostic replay 42473382657 passed report-bug but its global
NODE_DEBUG setting broke a separate Tilion log-redaction unit assertion; that
instrumentation fault is preserved, not attributed to the original test. Scoped
capture reproduced that unit's fail/pass without changing its assertions.
The first diagnostic-build full local run passed report-bug 23/23 but failed a
separate browser-provider certificate check; its unchanged owning replay passed
53/53 with verified cleanup. Its NOT_INTRODUCED packet remains separate.
Final frozen-source deploy gates remain required before release completion.

Private causal proof, exact commands, source hashes, stage events, original logs,
paired probe and repeated results are preserved by
`docs/handoffs/report-bug-fetch-repair/evidence-archive-receipt.json`, using the
existing encrypted trace archive. No raw signed URLs or credentials belong in Git.

10k-agent behavior: these additions change test execution only. They add no
production channels, subscriptions, queries, records, polling or locks. Error
formatting is bounded to 24 nodes, depth 6, 12 aggregate branches and 16 KiB output.
No provider or production records were changed to make the test pass.

## Human feedback

The user required preserving concurrency, assertions, deadlines and cleanup;
forbade guessing which fetch failed or assuming provider, credits, auth or storage
causes; required an actual reproduction and the original command to pass; and
retained assignment despite NOT_INTRODUCED attribution. Existing verified owners
must not be duplicated. Both sandbox no-remint obligations and the separate
originating live mixed-mode obligation remain outside financial-release authority.

## Reusable lesson

Preserve the failed operation's stage, sanitized cause chain and independent cleanup error before attributing a generic fetch failure to a test's named happy path.
