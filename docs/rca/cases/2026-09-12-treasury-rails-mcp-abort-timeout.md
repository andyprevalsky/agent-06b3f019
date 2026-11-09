---
id: 2026-09-12-treasury-rails-mcp-abort-timeout
date: 2026-09-12
title: treasury-rails died on unused-card settle when AgentCard tools/call AbortSignal timed out
surface: back-end
component: agentcard-org-runtime
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts shouldRetryOrgMcpError — AbortSignal.timeout on tools/call was not treated as transient
symptoms:
  - The operation was aborted due to timeout
  - still waiting for release to settle, attempt 3
  - treasury-rails blackbox FAILED
tags:
  - treasury-rails
  - agentcard
  - org-runtime
  - timeout
  - deploy-gate
sources:
  - commit 347552664
repro: cd back-end && npx tsx src/tests/unit/agentcard-org-runtime.test.ts
status: fixed
---

## Problem

`/deploy` backend coverage failed `treasury-rails` after mint → close → settle
wait. The domain printed `(still waiting for release to settle, attempt 3)` then
`treasury-rails blackbox FAILED: The operation was aborted due to timeout`.
Coverage run `1789246160-35515-15171`; card `cmtyv2pb90180ij042kiu634j`.

## Diagnosis

`callOrgMcpTool` uses `AbortSignal.timeout(30000)`. Under coverage concurrency
the shared AgentCard sandbox stalled a `recover_funds` / `list_transfers` poll
past 30s, so `fetch` threw `TimeoutError` before any HTTP/RPC body existed.
`shouldRetryOrgMcpError` only retried rate-limit and structured
`temporarily unavailable` bodies, so the raw abort escaped to the blackbox
`main()` catch, which also did not treat AbortSignal timeouts as the existing
credential-infra skip.

Local repro: `npx tsx src/tests/unit/agentcard-org-runtime.test.ts` — a fetch
that throws `The operation was aborted due to timeout` once used to fail the
caller immediately (0 retries).

## Solution

Classify AbortSignal / `aborted due to timeout` as transient unavailable in
`org-runtime`, convert the fetch throw to `AgentCardOrgRuntimeError` 503, and
retry on the existing bounded budget. `waitForRecoverable` /
`waitForTransferReclaimed` continue the settle window across one slow poll
instead of aborting the domain. Exhausted timeouts stay 503 so the existing
treasury-rails skip still applies.

At 10k agents this keeps one stalled org MCP read from failing every in-flight
settle poll; retries stay capped at three attempts with the shared deadline.

## Human feedback

None recorded.

## Reusable lesson

A transport AbortSignal timeout on an idempotent org MCP read is the same
transient class as a structured 503 — retry it on the existing budget; do not
let the raw `TimeoutError` fail a money-settle poll.

## 2026-11-08 review: the retry classifier also replayed ambiguous mutations

The original read-recovery fix applied its timeout/unavailable classification to
all tools. A deterministic replay in the existing org-runtime blackbox sent
`recover_funds` three times after a lost response, even though no idempotency key
was supplied. A structured unavailable result had the same three-call behavior.
This was found during the AgentCard reliability review; it is not evidence that
three real production recoveries occurred.

Critical path: purchase/recovery caller -> organization MCP transport -> retry
classifier -> second mutation. The first incorrect boundary was allowing a
transient *read* classification to authorize an ambiguous *mutation* replay.
Problem class: logical inconsistency in retry/idempotency contracts. Why did the
replay occur? The generic retry classifier did not know the tool's effects. Why
was the earlier body-read protection insufficient? It covered response bodies,
while fetch timeouts and structured unavailable results still used the generic
retry path. The deeper provider question (whether an individual lost request
committed) cannot be answered by the client.

The same replay exposed an adjacent contract gap: HTTP 503 with an opaque proxy
body and HTTP 429 with a `Retry-After` header were not retried because the old
classifier depended on body wording. The transport now preserves HTTP status
and parses Retry-After delta seconds or HTTP dates. Reads recover on HTTP
500/502/503/504 within the existing budget; permanent JSON-RPC errors keep their
previous failure behavior. A reset outside the shared deadline fails without
waiting. No timeout or attempt cap was raised.

Simplification: one effect-aware retry decision owns all transient failures.
Reads can retry; mutations can retry a proven connect-phase failure, but an
ambiguous timeout/unavailable result is returned to their owner. The card
provider retains its existing exact-idempotency-key timeout replay. A regression
runs that provider through the real runtime and checks identical card arguments
on both attempts. Known mutation body-read failures remain explicitly ambiguous.

Local causal proof (both revisions, identical test):
`cd back-end && npx tsx src/tests/blackbox/agentcard-org-runtime.blackbox.ts`.
Before: `3 !== 1` for both mutation tests, HTTP 503 raised on the first read,
and both Retry-After formats raised HTTP 429 instead of recovering.
After: the identical assertions pass. Additional assertions cover keyed card
replay, opaque 500/502/504 bodies, mutation 503 non-replay and over-budget
Retry-After. The normal blackbox runner discovers this existing domain.

The existing org-runtime unit file now uses an injected clock for retry waits
and measures virtual elapsed time rather than scheduler-sensitive wall time.
Baseline: 31,529 ms; first complete fixed unit pass: 686 ms. This removes real
backoff sleeps and the host-load-sensitive '<5 seconds' assertion, without
weakening the no-wait or advertised-reset assertions.

Archive searches: literal `operation was aborted due to timeout recover_funds`
and behavioral `AgentCard HTTP retry transport mutation`; this extends the
original timeout-recovery case. Golden reference: not applicable (no
approval-gated hunk). This evidence proves the owned transport behavior, not a
live provider settlement or an unchanged benchmark outcome.

The independent review added overlapping-failure regressions: HTTP 200 and 503
upstream throttle wording both replayed an unkeyed recovery three times. They now
make one call. Only reads, transport HTTP 429, or documented idempotent mutation
intents qualify for throttle recovery; an ambiguous body-read mutation remains
non-retryable. Typed HTTP errors also use their actual status for auth recovery.
New company-funded purchase issuance has moved to the current v2 REST API, with
cached platform credentials and structured fields. MCP recovery tests remain to
protect existing cards and optional tools. See `docs/agentcard-review.txt` for the
current contract, real sandbox proof and explicitly unverified production scope.


## 2026-11-09 REST reclaim deadline follow-up

The v2 release observer reused the 57-second legacy poll schedule while giving
all reads one 30-second deadline. Its fifth observation could therefore start
after the request budget expired and return a transport timeout instead of the
existing release-pending result. A registered wallet regression reproduced that
failure with an injected clock and deadline-aware transport, without wall-clock
sleep or global clock changes. Poll sleeps now fit the existing deadline and
expired reads remain pending; authentication failures still escape as failures.
The owning wallet unit passed five consecutive runs. This local proof does not
substitute for the unchanged browser abandonment/refund outcome.
