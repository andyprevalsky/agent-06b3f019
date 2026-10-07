---
id: 2026-10-02-agentcard-structured-throttle-returned-as-wallet-read
date: 2026-10-02
title: AgentCard's HTTP 200 structured throttle result was returned as a successful org read, failing benchmark payment seeding as "no structured wallet"
surface: back-end
component: agentcard-org-runtime
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts:callToolWithRateLimitRetry — a `{status:"error", message:"…API key rate limit exceeded…"}` tools/call result was returned as a value instead of entering the bounded throttle retry
symptoms:
  - "AgentCard get_company_wallet returned no structured wallet"
  - "subprocess.CalledProcessError: Command '['npx', 'tsx', 'scripts/setup-benchmark-payment.ts', ...]' returned non-zero exit status 1."
tags:
  - agentcard
  - rate-limit
  - mcp
  - benchmark-fixture
  - deploy-gate
sources:
  - PR #1341
repro: cd back-end && npx tsx src/tests/unit/agentcard-org-runtime.test.ts
status: fixed
---

## Problem

`/deploy` Group 4 (deploy run `20261001-145844-51013`, HEAD `9c8594e05`) failed
the Pre-Deploy smoke and AgentCard lifecycle lanes before either ran a task.
Both isolated stacks seeded the payment fixture at the same time. Both
`setup-benchmark-payment.ts` runs died within the same second (17:15:00 and
17:15:01 UTC) in `ensureAgentCardSandboxFloat` with
`AgentCard get_company_wallet returned no structured wallet`.

The AgentCard code was byte-identical to the two earlier Group 4 runs on
2026-10-01, and both of those seeded the pool successfully ("AgentCard sandbox
pool ready at $981743.40 available").

## Diagnosis

### Evidence

- A single read right after the failure returned a normal wallet (sandbox mode,
  $979,774.55 available). The failure was transient.
- 40 concurrent reads through the shared runtime all succeeded, because
  `inFlightReads` merged them into one request.
- 150 concurrent reads, one runtime instance each (no merging, no retry
  budget), returned 136 wallets and 14 results of this exact shape at HTTP 200:

  ```json
  {"content":[{"type":"text","text":"get_company_wallet failed: API key rate limit exceeded, please try again later"}],
   "structuredContent":{"message":"get_company_wallet failed: API key rate limit exceeded, please try again later","status":"error"}}
  ```

### Root cause

The org MCP throttle (120 requests per minute, shared by every org caller)
arrives in two shapes: a thrown transport error, and an HTTP 200 `tools/call`
result whose `structuredContent` has `status: "error"`.
`callToolWithRateLimitRetry` lifted structured results into a retryable error
only when the message said "temporarily unavailable". A structured throttle was
returned to the caller as a successful read. `readAgentCardOrgWallet` then found
no `wallet` and threw. The bounded throttle retry, and `benchmark-float`'s own
rate-limit retry, never saw it.

Two seeders plus the deploy stack's org cron traffic briefly exceeded the
shared window, which made the gap visible.

## Solution

`mcpStructuredResultRetryableError` lifts both structured shapes into the
matching typed error: a throttle becomes a 429 `agentcard_org_mcp_rate_limited`
and an outage becomes a 503 `agentcard_org_mcp_unavailable`. The existing
bounded retry then owns them. When retries run out, callers receive the same
typed rate-limit error the transport-throttle path already produces, with the
provider's text in the message.

`agentcard-org-runtime.test.ts` replays the observed body. One throttle followed
by a wallet must return the wallet after two calls. A persistent throttle must
reject with the 429 code after exactly three calls. The test failed before the
fix. After the fix, the same 150-read live burst with the default retry budget
returned 150 wallets.

## Human feedback

None recorded.

## Reusable lesson

When a provider can report a failure in-band (HTTP 200 with an error status),
the adapter must normalise every in-band failure it retries out-of-band. A
classifier that covers only one message keeps the others looking like empty
successes.
