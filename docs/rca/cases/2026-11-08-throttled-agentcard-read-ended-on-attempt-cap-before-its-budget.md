---
id: 2026-11-08-throttled-agentcard-read-ended-on-attempt-cap-before-its-budget
date: 2026-11-08
title: AgentCard org reads ended on a 3-attempt throttle cap with most of their 30 s retry budget unspent, so a throttled card read could still kill a browser task
surface: back-end
component: agentcard-org-runtime
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts callToolWithRateLimitRetry — a throttled idempotent read stopped at RATE_LIMIT_RETRY_ATTEMPTS=3 regardless of the 30 s budget; proven by the cap-reverted arm (lookup 502 with retry_budget_remaining_ms=24968), not reached by the observed read, which ended on the non-retryable rejection fixed in PR #1796
symptoms:
  - "payment_lifecycle.purchase.status mismatch: expected 'CLEARED', got 'HELD'"
  - "AgentCard Organization MCP get_card_details failed: Invalid or expired organization token"
  - "POST /api/purchases/lookup -> 502"
  - "AgentCard Organization MCP rate limit exhausted for get_card_details after 3 attempts"
  - "Browser manager failed RuntimeError AgentCard Organization MCP get_card_details failed"
tags:
  - agentcard
  - purchases
  - reuse
  - rate-limit
  - retry-budget
  - auth-flap
  - deploy-smoke
  - agent-payment-idempotent-abandonment
sources:
  - PR #1825
  - PR #1796
  - PR #1775
  - agent 2c6b3ffd-8b15-4ff0-ace7-1cea3eb6ac26
  - agent 6579ec49-560d-465d-bd4f-c94220973947
  - commit 43834c974dc87f909af93e00a3c41b3e29707dd5
  - fleet run 20261108-015557-1713873
repro: cd back-end && npx tsx src/tests/blackbox/agentcard-org-runtime.blackbox.ts
status: fixed
---

## Problem

Deploy smoke `agent-payment-idempotent-abandonment` (PR #1775 campaign, 13 tasks at concurrency 13, job r001-j0010, agent 2c6b3ffd, source fde378f8) failed with `payment_lifecycle.purchase.status mismatch: expected 'CLEARED', got 'HELD'`.

The second browser's purchase reuse lookup called AgentCard `get_card_details`. Backend log: attempt 1 (02:08:27.035Z) and attempt 2 (02:08:28.186Z) got HTTP-200 structured throttles carrying no `retryAfter`. Attempt 3 (02:08:31.771Z, 1584 ms) got `Invalid or expired organization token`, `retryable=false`, `retry_budget_remaining_ms=24307`. `POST /api/purchases/lookup` answered 502. The handler raised `RuntimeError` before any approval reuse or mint, the browser task failed, and the root filed `report_bug` and finished. The task allows exactly two browsers and a failed browser agent cannot be messaged, so nothing could continue checkout. The same static secret succeeded before (02:06:51Z) and after (02:11:10Z).

## Diagnosis

Gate: NOT_INTRODUCED by PR #1775. The repair was assigned here regardless.

The observed read ended on `Invalid or expired organization token`, the provider auth flap repaired by PR #1796. Its evidence is appended to case 2026-11-08-agentcard-org-read-auth-retry-shorter-than-provider-401-flap. The observed read did not reach the attempt cap.

This case is the adjacent defect in the same retry loop. The documented bound is a 30 s delay budget, but `RATE_LIMIT_RETRY_ATTEMPTS = 3` stopped first: when a throttle advertises no `retryAfter`, three attempts wait only 1+2 s. With #1796 alone, a throttle during or after the rejection ends the read. Whether the provider was still throttling after 02:08:31Z in the original run was not observed. The sibling case 2026-11-08-reuse-only-mint-provider-read-failure-returned-untyped-500 has the same task and read, with timing consistent with three throttled attempts, also unconfirmed.

Why activity retries did not help: the POST lookup returns status >= 400 as a payload (`repo.py`), so Temporal's `maximum_attempts=3` never applies. The runtime owns the retry.

Local reproduction: `back-end/src/tests/blackbox/agentcard-org-runtime.blackbox.ts`. Observed sequence (throttle x2, 401 x6): fails on pre-#1796 main with HTTP 401 `agentcard_org_mcp_unauthorized`; passes with #1796. Continuation, labelled hypothesised (throttle x2, 401 x6, throttle x2) with the cap at 3: `AgentCard Organization MCP rate limit exhausted for get_card_details after 3 attempts`; passes at 5. Five consecutive unchanged passes.

Exact unchanged task, `AGENTCARD_MCP_URL=http://127.0.0.1:18917/mcp scripts/run-bench --local agent-payment-idempotent-abandonment`, through a replay proxy injecting those responses from the second `get_card_details`:
- Pre-#1796 runtime: FAIL. Lookup 502, purchase HELD, agent 272cedf1, `Timeout after 902s`.
- Final code, observed sequence only: PASS. Lookup 200, purchase CLEARED, agent 9b37a27d.
- Final code with only the cap reverted to 3 and throttles after the rejections: FAIL. Lookup 502 with 24,968 ms of budget left, purchase HELD, agent 6579ec49, `Timeout after 902s`.
- Interim 6-attempt build, throttles after the rejections: PASS, purchase CLEARED, agent 4839f11b.

The failing arms ended on the task timeout with the same bad state, not the original assertion text. In the deploy's real cloud smoke campaigns on the final source, the assigned task passed twice (agents in campaigns deploy-0b7dac74 and deploy-bb319fda).

Known gaps: only one guest's logs survive from the original run, so who consumed the shared throttle window and why the provider rejected the token are unobserved, and the rejection's HTTP status is inferred from identical text being HTTP 401 in the PR #1777 occurrence. A 403 or HTTP-200 RPC-error rejection bypasses the auth-flap window. Failure logs now carry `status` and `code`, which will settle this on recurrence.

## Solution

PR #1825, `org-runtime.ts`: an idempotent read that hits a rate limit gets up to 5 attempts (1, 2, 4, 8 s of backoff), still capped by the caller's shared deadline. Mutations and non-throttle transient failures keep 3 attempts and their original tests. The retry loop and auth-flap deadline use the injectable clock. Failure logs add `status` and `code`. Golden reference: not applicable (no approval-gated hunk).

At 10k agents: at most 2 more requests per throttled read, each caller backing off from its own start. Identical in-flight reads stay coalesced and looping callers share one deadline. A coalesced joiner inherits the leader's deadline, so its overrun can reach about 15 s for an unadvertised throttle.

## Human feedback

None recorded.

## Reusable lesson

When a retry loop documents a time budget, check that its attempt cap can actually spend that budget when the provider sends no reset hint.
