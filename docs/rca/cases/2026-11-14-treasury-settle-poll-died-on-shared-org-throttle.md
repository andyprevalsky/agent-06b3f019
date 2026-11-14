---
id: 2026-11-14-treasury-settle-poll-died-on-shared-org-throttle
date: 2026-11-14
title: treasury-rails failed when one settle poll exhausted the shared AgentCard org throttle 28 s into its 240 s wait
surface: back-end
component: agentcard-unused-mint-settle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/agentcard/unused-mint-settle.ts waitForUnusedMintSettled — an exhausted `agentcard_org_mcp_rate_limited` from THIS card's list_transfers poll was rethrown because the caller's transient classifier only knew timeouts and outages, so a 60 s org throttle window ended a 240 s settle wait
symptoms:
  - treasury-rails blackbox FAILED: AgentCard Organization MCP rate limit exhausted for list_transfers after 5 attempts
  - AgentCard Organization MCP list_transfers is rate limited: list_transfers failed: Too many requests, please try again later
  - code=agentcard_org_mcp_rate_limited retry_after_advertised=false
tags:
  - agentcard
  - treasury-rails
  - rate-limit
  - 429
  - poll-loop
  - shared-sandbox-org
sources:
  - PR #2024 deploy gate backend-coverage-blackbox (Actions run 43414430212, artifact 14031253731, FLAKY occurrence 1dc793d7777246c785e8d24beb75499a)
  - commit be7284063a (quarantine marker)
  - PR #2041 (merged fb728c702287, 2026-11-14)
  - task treasury-rails repair thread https://boxes.dev/thread/thr_7ef29bd5e93d464eab3c02da1f9beb66
repro: back-end/src/tests/unit/agentcard-settle-coalesce.test.ts
status: fixed
---

## Problem

The PR #2024 deploy gate (head fb1234f11346, 2026-11-13) failed the `treasury-rails`
blackbox domain with `AgentCard Organization MCP rate limit exhausted for list_transfers
after 5 attempts`. Gate log (`blackbox-run-shard2/treasury-rails.log`): the $13 card minted at
11:10:16Z, closed at 11:10:17Z, and the settle wait polled cleanly at 11:10:18, :27 and :36.
The fourth poll's `list_transfers` got HTTP 429 five times (11:10:45.7Z, :47.9, :50.2, :54.7,
11:11:03.0Z; waits 1/2/4/8 s; no `retryAfter`) and the runtime gave up with 12.4 s of its own
budget left because the read attempt cap (5) was reached. The 240 s settle window still had
~194 s left. The runner's "passing" rerun (attempt 2) did not exercise the rails: it hit 429
then the 401 flap on the first `get_company_wallet` and exited 0 through the
credential-precondition SKIP.

## Diagnosis

1. `readCardTransfer` → `callOrgTool('list_transfers')` → `callToolWithRateLimitRetry` spent
   its bounded read retry (5 attempts) and threw the typed `AgentCardOrgRuntimeError`
   (429, `agentcard_org_mcp_rate_limited`). That bound is deliberate: the runtime budget is
   documented as the last line of defence, smaller than the 60 s throttle window.
2. `waitForUnusedMintSettled` (the poll-loop owner) caught it and asked the caller's
   `isTransientError`; treasury-rails' classifier matches only timeouts/unavailable, so the
   throttle was rethrown and failed the domain. First bad boundary: the loop treated
   org-wide backpressure — which says nothing about THIS transfer — as a settle failure,
   and had no pacing for it (the timeout path re-polls every 8 s, which would only add load).
3. Why was the window drained? The org is shared (~120 req/min across every deploy, smoke
   payment task and production). This run itself issued 104 `recover_funds` + ~20 other calls
   between 11:09:34Z and 11:10:14Z (~175 calls/min; 94 in the 60 s before the first 429): the
   pre-mint residual sweep (`recoverAllCardholderResiduals`) visited every cardholder in the org,
   twice, although a mint nets only its own cardholder's headroom. Concurrent callers filled the
   rest. Deepest owned rung: the test's own fan-out, which also starves concurrent deploys'
   AgentCard smoke tasks.
4. The gate's "passing" rerun (attempt 2, 11:11:03Z) never exercised the rails: it hit 429, then
   the 401 flap on the first `get_company_wallet`, and exited 0 through the credential SKIP. An
   independent reviewer reached the same first bad boundary and flagged rung 3 as blocking.

Archive searches: `rate limit exhausted list_transfers treasury-rails`, `agentcard_org_mcp_rate_limited
org MCP throttle 429`. Relatives: 2026-09-12-treasury-rails-mcp-abort-timeout (same loop,
timeout class; its lesson — a transient org read must not end the settle window — applies and
is extended to throttles), 2026-11-08-throttled-agentcard-read-ended-on-attempt-cap-before-its-budget
(runtime-level cap; not reopened: the runtime stays bounded), 2026-10-02-agentcard-structured-throttle-returned-as-wallet-read
(classification of in-band throttles; already fixed). Not a recurrence of any of them.

## Solution

`waitForUnusedMintSettled` recognises the runtime's typed throttle outcome
(`AgentCardOrgRuntimeError` code `agentcard_org_mcp_rate_limited`) itself, reports it, waits one
full throttle window (`UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS` = 60 s, capped at the deadline) and
keeps polling THIS transfer inside the unchanged 240 s window; a throttle still in force at the
deadline fails exactly as before. Non-throttle errors (401, unknown) still fail on the first poll.
Every caller of the settle wait gets this without its own classifier.

The treasury-rails pre-mint sweep now nudges (via `nudgeCardholderRecovery`, which coalesces on
an open recovery) only the mint cardholder and the cardholders of open pending-ledger mints, the
only residual that can net this mint or flip an earlier unused mint. Live proof on the same
command (2026-11-14): org calls per run 252 → 99, `recover_funds` 125 → 29, sweep of 1
cardholder, all checks passed. Single-shot calls (wallet read, create/close card, cleanup) keep
the runtime's bounded retry by design; mutations are never replayed blindly.

Regression:
`agentcard-settle-coalesce.test.ts` (throttle → one window → reclaimed; persistent throttle →
fails after 5 polls without sleeping past the deadline; 401 → immediate failure).

10k behaviour: a throttled poller now issues one org request per 60 s instead of one per 8 s,
so many concurrent settle waits shed load during a throttle instead of amplifying it.

Shipped in PR #2041 (merge `fb728c702287`, 2026-11-14). Verification:
- the repro `npx tsx src/tests/unit/agentcard-settle-coalesce.test.ts` failed (exit 1) on the unfixed code with the exact gate error and passed (exit 0) afterwards, 5/5 runs;
- `cd back-end && bash scripts/run-blackbox-tests.sh treasury-rails` passed live twice locally (`all checks passed`);
- in the PR's own deploy gates, rounds 1 and 2 soft-skipped mid-run on the separate AgentCard org 401 flap (`Invalid or expired organization token`, the existing credential-precondition SKIP). That is not this defect. Round 3 (`8f8c33e6`) fully passed in the gate: 92 org calls, `recover_funds` 28, no throttle;
- production lanes Render, Vercel, backend probes and semantic PASS. The AgentCard production lane is waived because the live payment identity is unprovisioned (human-only prerequisite).

Observation for the release streak: the in-gate 401 SKIP exits 0 and is counted as QUARANTINED_PASS, so the marker's 5-pass streak can advance without a full run.

## Human feedback

None recorded.

## Reusable lesson

A poll loop over a shared, rate-limited provider must treat the client's typed throttle
exhaustion as backpressure — wait out one window inside the same deadline — never as the
outcome it is polling for.
