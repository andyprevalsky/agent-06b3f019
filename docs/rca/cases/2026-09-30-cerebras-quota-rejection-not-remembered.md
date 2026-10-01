---
id: 2026-09-30-cerebras-quota-rejection-not-remembered
date: 2026-09-30
title: Every new agent request retried a known rate-limited Cerebras credential
surface: infra
component: cerebras-route-admission
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/providers/rose/cerebras.py::cerebras_complete discarded quota/reset state before the next request selected its primary route
symptoms:
  - repeated Cerebras HTTP429 across a ten-bench fleet
  - recovered calls still probed the known unavailable primary credential
tags:
  - cerebras
  - rate-limit
  - cloud-fleet
  - cooldown
sources:
  - PR #1299
  - fleet run 20260930-172350-24141
  - commit e7ad0782f4791827ef86dfe55cac3abe91c0cf13
repro: agents/tests/blackbox/rose.blackbox.py:test_cerebras_cooldown_skips_known_quota_then_reopens
status: fixed
---

## Problem

Proof80's ten-bench fleet recorded 116 Cerebras429 events, including111 recovered
fallthroughs. The existing same-pool OpenRouter waterfall worked, but every new
request still probed the exhausted primary. No higher-quota credential exists;
the user asked to avoid known rate limits before issuing the next request.

## Diagnosis

Cerebras completion kept no quota expiry, unlike the existing shared funded
Anthropic-key cooldown. An unchanged registered three-call fixture against
e7ad0782 issues three primary requests despite the first429 with Retry-After30;
the required behavior is one primary probe and three normal waterfall results.
The fixture fails before and passes after, then advances time and verifies that
the primary becomes eligible again. Inputs and waterfall models are unchanged.

Archive searches `Cerebras 429 cooldown` and `rate limited token never marked`
found the April17 missing-DB-marker and July28 shortened-cooldown cases. Their
solution/feedback require persisted selection state and monotonic provider reset
times. This is the same missing-admission-state class in a separate provider.
It does not explain proof80/81's terminal idle request, which remains unproven.

## Solution

Remember429 and explicit exhausted-quota response headers before awaiting shared
backend persistence. Subsequent requests skip the cooled credential and use the
existing waterfall. State is scoped by backend, credential SHA256 and model;
raw credentials never enter the state API or database. Reuse the Integration
sentinel pattern without a migration. An atomic conditional timestamp update
preserves the largest expiry across concurrent creators and shorter responses.

Honor valid Retry-After/date and exhausted-dimension reset evidence, including
zero/past expiry. Missing/invalid timing alone uses60 seconds; huge invalid
numbers cannot poison admission state. This uses observed capacity rather than
guessing prompt tokens or modifying generation budgets.

Shared reads use15-second caching and one in-flight lookup per scope. Entire
GET/POST operations have a2-second asyncio budget, including trickled response
bodies; caller cancellation cannot cancel a sibling's shared lookup. Backend
failure keeps local cooldown and ordinary fallback available. RPC time remains
inside the original model-request guard and is not described as instantaneous.

Registered Rose cases cover unchanged-request skip/reopen, credential/model
isolation, singleflight, cancellation, backend failure, valid/invalid reset
headers and bounded reads/writes. The autodiscovered backend unit runs ten real
concurrent creators against an isolated local PostgreSQL database, proves the
maximum expiry, validates scope/input and deletes its exact test sentinel.
TypeScript compilation and the deploy-owned Rose/LLM runner validate integration.

Workers sharing one backend/database share expiry. Fleet-isolated databases are
separate domains, and already-in-flight probes may still return429. Backend TS
inference paths are outside this agent-side admission change. This neither
promises globally zero429 nor turns a terminal model failure into valid proof.
At10,000 agents the hot path has no RPC during known cooldown; clear-state reads
are cached/singleflight and writes occur only when quota evidence changes.

### 2026-10-01 review recurrence: successful quota headers delayed streaming

CodeRabbit finding 4151506574 exposed that a successful response with exhausted
quota headers awaited the shared cooldown POST before reading its ready SSE
content. The final owning blackbox failed on immutable `864644162` with a
TimeoutError after 0.109 seconds while the backend write was held. The unchanged
fixture passes after separating local admission state from the stream-owned
bounded shared write. The local cooldown is visible before content is emitted;
the same existing POST runs concurrently with SSE consumption.

The write remains owned by that generator: normal exhaustion joins it, and
closure or cancellation cancels and joins it. Public live delegates explicitly
close their inner generators. The regression checks actual POST task completion
and cancellation state for direct and public close, cancel and normal completion
(six paths), preserving request count and the error-response marking order.
No module-wide detached task registry or worker pending-task exception is added.

Independent review reran the exact six sealed focused checks successfully in
2.109 seconds with all four source hashes unchanged. Tests are registered in the
existing Rose blackbox; evidence is under
`.context/acceptance/provider-timing-review/`, including sealed RED/GREEN and
`independent.receipt.private.json`. Archive searches were `Cerebras success quota
headers TTFT` and `buffered tool arguments idle disabled deadline`. This is a
recurrence of the cooldown ownership boundary, with constant per-stream state,
one existing bounded POST, zero live test requests and zero benchmark credit.

### 2026-10-01 main integration: new Foundry stream owner

The merged Foundry route introduced another source generator beneath the public
Rose stream. Public close returned while its HTTP response and client remained
open because the new call site lacked the source's explicit closing boundary.
The existing Rose blackbox now drives the actual public client, Foundry parser
and HTTP client through an offline MockTransport. Its unchanged three-path
fixture fails on public close before the fix, with cancellation and normal
completion as controls; it passes after enclosing the source in the same
`aclosing` contract already used for Cerebras (0.251 to 0.249 seconds).

Assertions run before fixture cleanup and require closed response, closed HTTP
client, propagated cancellation and exactly one provider request. The existing
Rose registration owns this regression. No route order, payload, model, budget,
fallback criterion or live provider state changes. Private RED/GREEN receipts
bind identical final fixture bytes under
`.context/acceptance/proof84-main-integration/foundry-integration/`; network
connections were forbidden, and these checks earn no benchmark credit.

### 2026-10-01 coverage recurrence: cancellation fixture shared its timeout arm

The canonical integrated coverage gate failed the sibling-success assertion in
`test_cerebras_cooldown_rpc_is_bounded_and_cancellation_isolated`. Runtime logging
showed that the shared GET hit the fixture's 40-millisecond timeout before the
fixture released its mocked response. Production's two-second RPC budget was
unchanged. The test applied its deliberately short timeout to both the positive
cancellation handshake and the requests intentionally held open to test timeout.

An unchanged private launcher pauses the scheduler for 80 milliseconds at that
handshake in the actual registered test. Before the fixture correction it fails
at `assert await sibling is True` with one shared-read timeout warning (0.314
seconds). The same pause and assertions pass after scoping the existing
40-millisecond override only to the deliberate timeout arms (0.413 seconds).
Those ten-reader and POST arms retain their original 40-millisecond and
300-millisecond limits, result assertions, request counts and pending-task checks.
The cancellation handshake exercises the unchanged production RPC budget.
No production code, production cap, provider call or extra test suite changed.

This is a recurrence in the cooldown regression fixture, not evidence that
production sibling cancellation failed. Original failing coverage and the
scheduler-pause RED/GREEN receipts remain private under
`.context/acceptance/proof84-agents-contract-rca/`. Archive searches were
`cerebras_cooldown_rpc_is_bounded` and `cooldown singleflight cancellation`.
The existing Rose registration continues to own the corrected case. On the
actually adopted dependency environment its complete owning domain passes all
201 cases in 10.435 seconds; production Cerebras bytes remain unchanged.

## Human feedback

Use the existing waterfall to preemptively avoid rate-limited providers. Fix
infrastructure; keep task inputs, models, evaluator criteria and timeout caps.
Credit only genuine completed live queries and fully evaluated/retired benches.

## Reusable lesson

Provider fallback must remember reported unavailability where the next request
selects its route, while expiry updates preserve the longest valid reset.
