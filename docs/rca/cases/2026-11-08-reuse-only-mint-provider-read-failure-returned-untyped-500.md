---
id: 2026-11-08-reuse-only-mint-provider-read-failure-returned-untyped-500
date: 2026-11-08
title: A reuse-only payment-card mint let an AgentCard read failure escape untyped, so the second browser task failed on a bare HTTP 500
surface: back-end
component: purchases-reuse-only-mint
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/domains/purchases/service.ts:tryReuseExistingPurchase — the held-card liveness read (tryGetLiveCardDetails → AgentCardOrgMcpProvider.getDetails) rethrew the raw AgentCardOrgRuntimeError, so POST /api/purchases/mint could only answer "500 Failed to mint purchase card"; the provider trigger behind that read is unconfirmed
symptoms:
  - "HTTPStatusError: Server error '500 Internal Server Error' for url 'http://localhost:3001/api/purchases/mint'"
  - "Message Type: FAILED Sender: /root/second_payment_checkout"
  - "Timeout after 904s (task timeout=900s)"
tags:
  - agentcard
  - purchases
  - payment-card-request
  - reuse
  - idempotency
  - rate-limit
  - deploy-smoke
  - agent-payment-idempotent-abandonment
sources:
  - fleet run 20261107-201518-443935-m217e9def0164
  - agent 6a4eea22-3135-47f1-9e7c-86db1e45af03
  - agent ce9d2ae6-c109-435d-bea4-c5fb1e5c1f1c
repro: cd back-end && DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/tests/blackbox/purchases-agent-cart-reuse.blackbox.ts
status: mitigated
---

## Problem

Cloud smoke `agent-payment-idempotent-abandonment` (fleet run
20261107-201518-443935-m217e9def0164, deploy group of 13 members, root agent
6a4eea22) failed. The first browser task requested a one-time card for the
$43.96 Rose Labs Test Payment cart. It was approved at 20:27:12Z and issued
(last four 9436) at 20:27:17Z, and the task left checkout unsubmitted. The
second browser task asked for the same card at 20:28:51Z. No new approval
prompt appeared, so the workflow's purchase lookup had found the HELD purchase
reusable and minted with `reusePurchaseId`. At 20:29:04Z the browser task failed
with `HTTPStatusError: Server error '500 Internal Server Error' for url
'http://localhost:3001/api/purchases/mint'`. The root could not continue and the
run timed out after 904 s.

Its passing sibling (agent ce9d2ae6, same task) took this path successfully:
`payment_card_ready` carried `reusePurchaseId` 457a13d9 and
`attentionRequestId: null`.

## Diagnosis

### Evidence

- The guest backend logs are gone. The guest was an ephemeral Fly Machine, the
  Hub run record carries no logs, and `observability.fly_logs` has no rows for
  the agent. Only the Hub transcript, the browser recordings and the
  diagnostics zips survive. None of these captures backend responses.
- The route can return 500 only for an error that is not a `PurchaseError`
  (`routes.ts` → `log.error('Mint purchase failed')`). A reuse-only mint runs
  just the agent-admission transaction, `findPurchaseById`, the field checks
  and `tryReuseExistingPurchase(..., reuseOnly=true)`. The last of these calls
  `tryGetLiveCardDetails`, which rethrows any provider error except
  `card_closed`. Every validation failure on this path is a typed 409.
- The lookup and the receipt-scoped `lookupPurchase` both wrap provider errors in
  a `PurchaseError` (502 `purchase_approval_lookup_failed`). The fresh-mint path
  maps them through `toPurchaseBoundaryError`. Only the reuse liveness read in
  the mint skipped that mapping.
- Timing: 13 s separated the second request from the error. The pre-reuse
  browser diagnostics finished 6 s before the error. In the passing sibling the
  card was ready 1 s after the same diagnostics, even though its lookup and mint
  also read the card from AgentCard twice.
- The organization MCP is throttled at a 120-request-per-minute window shared
  by every caller (case 2026-10-02-agentcard-structured-throttle-returned-as-wallet-read).
  Several AgentCard payment members of the same deploy group were running
  against the same sandbox organization at 20:28–20:31Z. These included
  `agent-payment-abandonment`, which polls transfer release.

### Root cause

What is proven: the reuse-only mint lets a provider read failure escape the
purchases boundary untyped. Production then reports a bare 500 that hides the
provider's status and code. The local reproduction runs the observed text-only
AgentCard throttle body through the real `AgentCardOrgRuntime` and
`AgentCardOrgMcpProvider`. Three `get_card_details` attempts are spent in about
3 s with zero provider latency. Before the fix, `mintPurchaseCard` rejected with
the raw `AgentCardOrgRuntimeError`, which the route turns into exactly this 500.

What is not proven: which provider failure the guest actually hit. A throttle
on the shared organization fits the timing best. With real call latency, three
attempts plus the 1 s and 2 s backoffs take about 5–6 s. It also fits the
group's concurrent AgentCard load. A transient MCP outage or a database error
in the same request could produce the same 500. This stays an observability gap
until a typed failure is captured.

## Solution

`tryReuseExistingPurchase` maps a failed liveness read through the existing
`toPurchaseBoundaryError`. AgentCard runtime and provider failures now reach
`/api/purchases/mint` as a typed `PurchaseError` that keeps the provider status
and code, for example 429 `agentcard_org_mcp_rate_limited`. Any other error is
rethrown unchanged, so existing identity assertions still hold. The purchase
stays HELD with its card. Nothing is cleared, billed or reopened. Retry counts,
budgets, timeouts and the benchmark are unchanged.

Regression: `purchases-reuse-provider-error.testkit.ts`, run by the existing
`purchases-agent-cart-reuse` backend blackbox domain. It sends the observed
throttle body through the real organization runtime and provider into a
reuse-only mint. It asserts a typed 429 with the provider code, exactly three
`get_card_details` attempts, and the HELD purchase and card left unchanged. It
failed before the fix (`type=AgentCardOrgRuntimeError status=undefined`) and
passed five consecutive times after it.

Outcome proof is still open. The fix makes the next occurrence attributable,
but it does not make a throttled reuse succeed. The agent still raises on a 429
from mint. If the next failure shows `agentcard_org_mcp_rate_limited`, the
follow-up is to reduce the shared sandbox organization's request volume, or to
retry the side-effect-free reuse-only mint on typed transient codes. That
change belongs to its own approval.

### Update 2026-11-08

Case 2026-11-08-throttled-agentcard-read-ended-on-attempt-cap-before-its-budget raises the throttled read allowance on this same read (PR #1825): throttled reads without an advertised reset now back off for up to 15 s before surrendering typed (an advertised reset can wait up to the 30 s budget). Whether that resolves this occurrence stays unproven, because its provider trigger was never captured. Failure logs now record `status` and `code`.

## Human feedback

None yet.

## Reusable lesson

When a boundary already maps provider failures to typed errors, check every
code path that reaches the provider through it, including reuse and liveness
reads. An untyped 500 after a successful reuse lookup hides which provider
failed. Without the guest's backend logs the cause cannot be recovered.
