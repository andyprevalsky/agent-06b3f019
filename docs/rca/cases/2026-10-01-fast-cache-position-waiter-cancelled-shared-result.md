---
id: 2026-10-01-fast-cache-position-waiter-cancelled-shared-result
date: 2026-10-01
title: A cancelled Fast Mode cache waiter cancelled the result shared by sibling callers
surface: agents
component: fast-cache-position-singleflight
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/providers/fast_cache/client.py::_fetch_position_http awaited the shared Future without separating waiter cancellation from HTTP ownership
symptoms:
  - fast_cache.get_position_error with ReadTimeout during mass-agent fan-out
  - summarize_and_filter_links hit its 90-second nested attempt budget
  - retry raised CancelledError after get-many returned HTTP 200
  - spawn_agent ERROR caused t10-no-tool-failures to fail
  - owner cancellation left a pending shared result
tags:
  - fast-cache
  - singleflight
  - cancellation
  - mass-agent
  - async-future
sources:
  - PR #1299
  - commit bc1806459838b8bc7e31282f3fc637f5e2106577
  - agent 72488e32-9931-4a16-9bc0-0ee1b0a1daba
repro: agents/tests/fast_cache/test_fast_cache.py::test_position_fallback_cancellation_preserves_singleflight_ownership
status: open
---

## Problem

The original mass-agent deploy smoke reached a completed root with 51 agents in
512.9 seconds, but its declared no-tool-failures evaluator failed on a
`spawn_agent` ERROR. Two explore operations recorded that terminal tool error.
The original run remains FAILED; a completed root does not satisfy this smoke
check. This cached diagnostic provides no LIVE-query fleet acceptance credit.

Retained worker evidence contained 453 current get-position ReadTimeout retry
rows and four owned unhandled-Future ReadTimeout rows. These were current HTTP
transport events, not historical log messages replayed from cache. They do not,
by themselves, prove that required work was lost: the foreground cache lookup
error and live-miss counts were both zero, with 3,521 cache replay events.
The four owned unhandled-Future reports occurred after the two tool errors.

## Diagnosis

The two nested summary attempts ended at their unchanged 90-second bound
(90.001 and 90.002 seconds). The web-fetch handler sets this attempt budget;
the activity helper applies it around summarize_and_filter_links. Each retried
after one second, then failed with CancelledError
in 1.807 and 1.586 seconds. Temporal recorded those failures before the parent
persisted its two spawn errors.

Exact backend parent spans show that the initial calls completed their only
owned get-many requests in 1.844 and 1.864 seconds. Neither emitted its own
get-position request before its deadline. The retries completed get-many in
1.798 and 1.580 seconds and failed within nine and six milliseconds afterward.
Together with the source, this supports a wait on another caller's shared
position result, followed by re-awaiting a cancelled result. The logs do not
capture the Python await stack at cancellation, so this runtime attribution is
an inference supported by the owning reproduction below.

`_fetch_position_http` stores one Future per goal hash, call site and step.
A follower used `await existing`; cancelling that follower also cancelled the
shared Future. Subsequent followers could inherit CancelledError even though
they had not been cancelled. Separately, cancelling the HTTP owner removed the
registry entry without settling its Future, stranding existing followers.
The missing invariant was independent cancellation ownership for the HTTP
request, its shared result and every waiting caller.

The original event-gated public-fallback reproduction failed both waiter and
owner cancellation controls before the runtime edit. A strengthened three-arm
oracle additionally requires a live follower to acquire a fresh request after
owner cancellation, while simultaneous caller cancellation must still propagate.
That strengthened test failed against the intermediate implementation, which
released followers by cancelling them instead of preserving their progress.
All fixture requests use a real HTTP client with an in-process MockTransport;
there are no model/provider calls, invented network delays or private payloads.

Archive searches found the September 2 position-timeout/live-fallthrough and
July 7 cache-read/pool-exhaustion cases. Their retry and no-live guards remain
in force here; this case records a distinct shared-result cancellation defect.
The backend cache slowdown itself remains unexplained. Retained successful
get-position requests were all HTTP 200, with p95 13.662 seconds, but these
completed rows cannot establish whether SQL, queueing or another resource caused
the delay. No observed late success justifies increasing the activity timeout.

## Solution

The isolated integration draft shields a follower's await of the shared result.
Cancelling the actual HTTP owner settles its Future as cancelled and removes
its exact registry entry. A still-live follower then joins or owns the next
request; a caller with its own pending cancellation propagates it instead.
No detached request task or additional timeout is introduced. The goal/site/step
key, memoization, HTTP retries, request contents and result contract are retained.

The HTTP owner also retrieves an already-set shared Future exception in its
finally block. This prevents a duplicate unhandled-Future notification while
preserving the original typed HTTP failure for the owner and followers; an
exhausted request must not become a cached miss.

The final unchanged eight-case command failed on original source (three failed,
five passed, 2.046 seconds) and passed on the draft repair (eight passed, 1.888
seconds). It covers three cancellation paths, two typed HTTP-error paths and
three existing position memo/prefetch/retry controls. The error controls preserve
all three original HTTP attempts and backoff. All 132 original test definitions
remain unchanged, and the two new parameterized tests run through the existing
Fast Cache pytest coverage gate. This is bounded ownership proof, not a fresh
benchmark outcome. Independent review verified the final source, unchanged
RED/GREEN fixture, error propagation and test-process retirement; it passed.
Integrated validation and the canonical smoke outcome remain pending.

The 90-second summary deadline, existing 600-second/default and 1,800-second/deep
explore bounds, and benchmark harness caps are unchanged. The normal 7,200-second
execution backstop and temporary 300-second fleet execution and 1,800-second
allocation cutoff are unaffected.

A fresh canonical smoke outcome on the integrated source is still pending.
Neither an isolated GREEN nor recovered cache retries can relabel the original
FAILED smoke, establish the cause of its cache latency, or grant fleet credit.
The case remains open until the required outcome verification is recorded.

## Human feedback

The user accepts genuine benchmark FAILURE, requires zero infrastructure errors,
and asked to avoid unnecessary resets and a large new verification suite.
The authorized 20 percent headroom applies to infrastructure timeouts, not harness
caps; no bound was increased for this cancellation repair. Distinguish current
transport retries, terminal loss of required work and the evaluator's actual
verdict instead of classifying every ReadTimeout string as infrastructure failure.

## Reusable lesson

Separate shared-request ownership from each caller's cancellation, and test both cancelled waiters and cancelled owners with live followers.
