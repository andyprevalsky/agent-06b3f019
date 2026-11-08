---
id: 2026-11-08-agentcard-org-read-auth-retry-shorter-than-provider-401-flap
date: 2026-11-08
title: AgentCard Organization MCP reads gave up on a ~1 s auth retry inside a multi-second provider 401 flap, and a superseded lifecycle-read error vetoed the stall waiver, so smoke payment abandonment failed as ERROR
surface: back-end
component: agentcard-org-runtime
classification: third-party-failure
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts callToolOnce/callOrgMcpTool — a provider HTTP 401 "Invalid or expired organization token" on an idempotent read was retried for only ~1 s (3 x 250 ms HTTP attempts plus one immediate re-call), shorter than the provider's >=5.2 s flap, so get_card in POST /api/test-payment/lifecycle/abandon returned 401 agentcard_org_mcp_unauthorized
symptoms:
  - "Failed to abandon test payment: 401 {\"error\":\"AgentCard Organization MCP get_card failed: Invalid or expired organization token\",\"code\":\"agentcard_org_mcp_unauthorized\"}"
  - "POST /api/test-payment/lifecycle/abandon -> 401"
  - "Organization MCP tool call failed tool=list_transfers attempt=2 error=...Invalid or expired organization token retryable=false"
  - "Payment lifecycle did not reach the expected terminal state before timeout: payment_lifecycle.purchase.status mismatch: expected 'VOIDED', got 'HELD'"
  - "INFRA STOP: 1/18 scheduled jobs are confirmed infrastructure failures (>= 5%); breach at r001-j0011 (ERROR)"
tags:
  - agentcard
  - organization-mcp
  - auth
  - retry
  - deploy-smoke
  - agent-payment-abandonment
sources:
  - hub run 20261108-041743-3156927-m547c38d72f0c
  - agent f2b010a3-7612-49d6-bd01-2e658449d2a6
  - PR #1777
  - PR #1796
  - memory:agentcard-org-auth-outage-20261027
  - PR #1781
repro: cd back-end && npx tsx src/tests/blackbox/agentcard-org-runtime.blackbox.ts
status: fixed
---

## Problem

During PR #1777's deploy, cloud smoke campaign 3cd670edb6dc (18 scheduled jobs) ran
`agent-payment-abandonment` as member r001-j0011. The agent prepared checkout and a
one-time card was minted at 04:23:04Z. The harness then posted
`/api/test-payment/lifecycle/abandon`, which answered 401 after 3083 ms (04:23:08.805Z)
with `AgentCard Organization MCP get_card failed: Invalid or expired organization token`
(`agentcard_org_mcp_unauthorized`). `run_benchmark.py` does not retry a 401, so the task
ended ERROR. The campaign's infra predicate (20 x 1 >= 18) stopped the run and cancelled
4 healthy jobs.

## Diagnosis

Evidence (the guest backend log excerpt recorded by the originating deploy; the guest is gone):
- 04:23:08.805Z: abandon -> 401.
- 04:23:09.701Z: `list_cards` succeeded (attempt=2).
- 04:23:09.940Z, 04:23:10.727Z and 04:23:10.902Z: `list_transfers` failed with the same message (attempt=2, retryable=false).
- 04:23:57.538Z: the same abandon POST succeeded with every call at attempt=1.

The mint at 04:23:04Z had used the same static `acs_` client secret successfully. The 401s were therefore a provider-side flap of at least ~5.2 s (04:23:05.7Z to 04:23:10.9Z), interleaved with successes, not a dead credential.

Prod Render logs for 04:15 to 04:35Z show no Organization MCP failures, so the live client was unaffected; the flap hit the sandbox client the guest used. ClickHouse has no guest rows. The Hub record keeps only the failure reason. So the retryable class behind the outer `attempt=1` failures (likely a throttle) was not retained; that is an observability gap.

The runtime retried an HTTP 401 three times at 250 ms inside `callOrgMcpTool`, plus one immediate re-call in `callToolOnce`: about 1 s in total. The outer rate-limit loop treats 401 as non-retryable. Every read issued inside the flap therefore failed hard.

Related: memory agentcard-org-auth-outage-20261027. The same provider message opened that day's ~37 min outage, so any retry must stay bounded and surface a sustained 401.

Additional occurrences on 2026-11-08, from the PR #1781 deploy on devbox fb2cf1b1 (merge 49c2c60ce):
- **~04:17Z:** smoke r001-j0011 failed with the identical abandon 401 on `get_card`. In the same second, `list_transfers` succeeded on the same secret. The 401s were interleaved with 429 "Too many requests". This suggests that under org-wide throttling the provider sometimes answers a throttled request with the auth 401, which is consistent with the outer `attempt=2` lines above.
- **~05:20Z:** 41 such 401s hit `get_card`/`list_transfers` lifecycle reads. The harness's read loop rode them out until its reconciliation deadline.
- That second pass printed the standing release-stall SKIP but saved ERROR. That verdict flip is a separate harness defect owned by that deploy's handoff.
- **~06:00Z:** the next pass on 2a6396121 had no 401.

Backing off on the 401 therefore also gives a throttled window time to refill.

Repro: `cd back-end && npx tsx src/tests/blackbox/agentcard-org-runtime.blackbox.ts`. It replays the provider's 401 body for 6 s on a virtual clock. On 839396e48 it failed with `AgentCardOrgRuntimeError: AgentCard Organization MCP get_card failed: Invalid or expired organization token` (status 401, code `agentcard_org_mcp_unauthorized`); on the fix it passes.

Second boundary, from the PR #1781 packet (run 20261108-045825-2709472, evidence restored from the encrypted closeout archive `devbox-closeout-private/pr1781-49c2c60c/cloud.tar.gz.aesgcm`):
- 05:17:24Z: a lifecycle GET returned 401, so `last_fetch_error` was set.
- 05:17:36Z: the next GET returned 200 with the exact release stall.
- The resume branch then started the idempotent abandon re-POST, which was still in flight at the 05:18:16Z reconciliation deadline.
- `_wait_for_expected_payment_lifecycle` raised with `allow_release_skip=last_fetch_error is None`. The superseded 401 refused the waiver, so the task saved ERROR, although the deadline snapshot passes `_agentcard_release_skip_lifecycle` on replay. Cleanup later printed the SKIP from its own fresh read.
- Repro: `test_agentcard_release_policy_skips_fresh_stall_after_a_recovered_read_error` in agents/tests/blackbox/benchmark.blackbox.py failed on cfb2bd34c with the exact saved message.

Searches run:
- `rca_archive.py search "Invalid or expired organization token agentcard_org_mcp_unauthorized"`
- `rca_archive.py search "agent-payment-abandonment abandon 401 auth flap"`

The incident is novel. Related cases cover the 2026-07-25 static-credential retirement and the 2026-11-08 reuse-mint untyped 500.

## Solution

PR #1796.
- After the unchanged immediate auth retry, an idempotent org read that still gets the provider's typed HTTP 401 backs off 1, 2, 4 and 8 s, one request per step.
- The window is 15 s, about 3x the observed flap, and it is also capped by the caller's shared retry deadline.
- A 403, a spent deadline and every mutation keep their exact previous behaviour.
- A sustained outage still surfaces the provider 401 after 10 requests (previously 6).
- `mintCard` shares one post-`create_card` deadline across its detail reads and the transfer poll, so the added window cannot push a created card's mint past the caller's HTTP timeout.

The harness fix: in the resume path, a successful observation becomes the durable snapshot and clears the stale read error before the recovery POST. An actual failed last read still never qualifies. Also in #1796: `back-end/scripts/prisma-local-push.test.sh` leaked a scratch DB on every local-PG run, because a later EXIT trap replaced the earlier one.

The regression asserts the flap recovery, the bounded outage (10 requests, 15 s, 401), the 6-attempt/no-sleep behaviour for a spent-deadline read, a 403 read and a mutation. Outcome: on 2026-11-08 the deploy smoke gate ran `agent-payment-abandonment` three times on the fixed sources (bf0e288cf, cfb2bd34c, d01078768; the last was Hub run 20261108-080709-1961857). Each run had zero org-MCP 401s, every abandon and lifecycle request returned 200, there was no INFRA STOP, and the other 14 tasks passed. Each run ended on the standing AgentCard sandbox release stall (native SKIPPED, `agentcard_release_stall`; docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md), which is a provider settlement outcome and not a PASS. Merged as dd330764a.

## Human feedback

None recorded.

## Reusable lesson

Size a third-party retry window from the provider's observed transient span, retry only idempotent reads within it, and keep a sustained failure surfacing within a bounded window.
