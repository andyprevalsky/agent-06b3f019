---
id: 2026-11-08-agentcard-fixture-lacked-org-backpressure-tolerance
date: 2026-11-08
title: One provider 401 during the pre-barrier AgentCard payment fixture failed a guest and tripped the campaign infra stop for all 13 smoke jobs
surface: harness
component: agentcard-benchmark-float
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/setup-benchmark-payment.ts seedSandboxFixture ran read-only AgentCard org verification with no tolerance beyond each call's own retries, so a transient provider 401 or throttle ended the guest before the start barrier
symptoms:
  - "[AgentCardOrgRuntime] Organization MCP tool call failed list_cardholders failed: Invalid or expired organization token retryable=false"
  - "FATAL: setup-benchmark-payment.ts failed"
  - "INFRA STOP: 1/13 scheduled jobs are confirmed infrastructure failures (>= 5%); breach at r001-j0009 (INFRA_ERROR)"
  - isolated stack failed before the start barrier
  - "Failed to prepare-residual benchmark AgentCard setup: 401"
tags:
  - agentcard
  - cloudbench
  - deploy-smoke
  - payment-benchmark
  - rate-limit
sources:
  - PR #1975 smoke round 6b (devbox 6253baf7, run 20261113-012150-2086617, job r001-j0007 agent-payment-test-shop)
  - PR #1813
  - PR #1786 deploy attempt 4, smoke campaign deploy-cloud/604a576acbf1c746c131fe58ef25977da4cad6fa81cd612760fc5c2fb16f7bd9
  - commit 34fd7d036b165e235a02a05197a4ddc00f6bc46e (failed source)
repro: cd back-end && env -u FLY_APP_NAME npx tsx src/tests/unit/agentcard-benchmark-float.test.ts (and, for the 2026-11-13 recurrence, src/tests/unit/agentcard-benchmark-float-burst.test.ts), plus test_agentcard_setup_retries_only_the_structured_org_rate_limit and test_abandon_retries_typed_org_auth_rejection_after_reconciling in agents/tests/blackbox/benchmark.blackbox.py; on the pre-fix behaviour the first verifyBenchmarkOrgFixture call rejects with "AgentCard Organization MCP list_cardholders failed: Invalid or expired organization token", and the KYC case reports "Missing expected rejection"; both pass on the fix
status: mitigated
---

## Problem

In the PR #1786 deploy attempt 4 smoke campaign, five AgentCard payment guests hit org errors between
03:55:12Z and 03:55:31Z on 2026-11-08. `agent-payment-setup-resume` (r001-j0009) logged
`list_cardholders failed: Invalid or expired organization token retryable=false`, then
`FATAL: setup-benchmark-payment.ts failed`. "API key rate limit exceeded" was interleaved in the same
window. One INFRA_ERROR meets the 5% campaign stop at 13 scheduled jobs, so every job was cancelled.
The same five tasks passed together in earlier campaigns, and later reruns on the same source passed
12/13.

## Diagnosis

Two transient provider states can outlast one call's retries: the fixed 60 s organization rate-limit
window shared by every lane using these credentials, and an intermittent HTTP 401 on a healthy secret.

On the failed source a read got only the ~1 s immediate auth retry. #1796 (merged later) added a 15 s
read auth-flap window, which is still shorter than the 19 s span seen here. The fixture is read-only
pre-barrier work, yet it ran with no patience of its own while its failure cancels the whole campaign.
That missing tolerance at the fixture boundary is the owned defect.

A sibling defect sat in `resolveBenchmarkCardholderId`: a 401 on a KYC read was treated as "not ready",
so resolution could continue and seed a less-preferred, unverified cardholder.

Step 5a ladder: why did one error stop the guest? The fixture had no wait. Why was the wait needed? The
provider window and flap are longer than a per-call budget. The next "why" (why AgentCard returns 401
for a healthy secret) leaves what we own.

Separately, `AgentCardOrgRuntime` stops a text-only throttle after 3 attempts (scratch repro: 3 requests,
3006 ms) even with 27 s of its 30 s budget left. Existing tests pin that bound, so it was left unchanged.

The fixed source then exposed the same class one boundary later. PR #1813's smoke campaign `c014b69b` passed the
pre-barrier fixture but failed `agent-payment-setup-resume` after the barrier at 11:17Z with `Failed to prepare-residual
benchmark AgentCard setup: 401 {"error":"AgentCard Organization MCP recover_funds failed: Invalid or expired organization
token","code":"agentcard_org_mcp_unauthorized"}`. `configure_benchmark_agentcard_setup` waited out the typed 429 but
treated the typed 401 as terminal, and the abandon POST had the same gap.

Runtime evidence, from the restored guest logs (`pr1786-fdf1accd94-core`): four guests logged 401s interleaved with throttles
across 03:55:12-03:55:31Z, and a 401 on `get_cardholder_kyc_status` was treated as not-ready at 03:55:17Z while resolution
moved to the next candidate, which is the sibling defect above occurring live.

Evidence gaps, stated plainly:

- What consumed the org budget at 03:55Z is only partly attributed. The failing guests' driver logs hold 13 org tool-call
  lines in that window, at most about 70 HTTP requests. The Benchmark Hub shows another deploy's campaign, `deploy-7cafb99e`,
  launched five AgentCard payment tasks at 03:49:03Z; its `agent-payment-abandonment` lifecycle ran until about 03:58:24Z,
  across the whole failure window. So contention crossed deploys on the shared org credentials. Its request count was not
  measured, 13 payment-class Hub rows in the scan have no duration, and non-Hub callers were not measured, so exhaustion
  itself is still unquantified.
- Whether throttling causes the 401s is unproven. They interleave, but #1796 also saw 401s on a healthy secret.
- The exact benchmark cannot be made to fail on demand on the buggy revision, because it depends on provider state. The
  causal proof is the replayed provider errors at the owning boundaries; the outcome proof is the deploy smoke campaign.

## Solution

`waitOutBenchmarkOrgBackpressure` in `back-end/src/providers/agentcard/benchmark-float.ts` re-runs a
read-only org verification when a typed rate limit, provider HTTP 401 or 503 outlasts its per-call
retries: 30 s apart, 1 + 3 attempts, no new attempt after 180 s. Empty orgs, low float and pending
cardholders still fail on the first pass, and a sustained outage still surfaces the provider's error.
`setup-benchmark-payment.ts` uses it through `verifyBenchmarkOrgFixture`; the other fixture scripts
that resolve a cardholder share it. Resolution now rethrows backpressure instead of skipping the
candidate, and the readiness wrapper keeps the error type.

The same typed-401 tolerance now covers `configure_benchmark_agentcard_setup` and the abandon POST in
`agents/benchmarks/run_benchmark.py`, using the existing delay and attempt bounds; untyped 401s stay terminal.

No fleet-wide admission was built. The evidence does not show this campaign's guests exhausted the budget, and the Hub
overlap shows contention from another deploy, so a per-campaign lease would not have covered this incident. An
org-wide lease across deploys remains the open design question.

Fixture-only change: 10k-agent behaviour is unaffected, and at most 4 passes of 5-6 reads per guest are
spent, 30 s apart.

Outcome: deploy smoke campaign `deploy-60fcfad4` on the fixed source passed 14 of 15 jobs, including every payment fixture
guest and `agent-payment-setup-resume`; the remaining job (`agent-payment-abandonment`) is the standing AgentCard release
stall, recorded as a skip and never a pass. Status stays `mitigated`: the provider 401/throttle's origin is unexplained.

Golden reference: not applicable (no approval-gated hunk).

## Recurrence 2026-11-13 (PR #1975 smoke round 6b): why the earlier fix did not hold

Guest `agent-payment-test-shop` began seeding at 01:31:42Z. `list_cardholders` got two 429s at
01:31:46–47Z, then the provider's 401 throttle answer ("Invalid or expired organization token").
`waitOutBenchmarkOrgBackpressure` made all four passes (01:31:42, 01:32:30, 01:33:08, 01:33:53Z),
each re-hitting 429/401, and gave up at 01:34:00Z. That was only ~138 s into its 180 s window,
because the fixed 30 s gaps exhausted the 1 + 3 attempt count early. The org's last 401 in
production Render logs was at 01:34:02Z, so the burst ended seconds after the fixture quit. The
guest failed before the start barrier, and the campaign INFRA-stopped at 1/11. The earlier fix
bounded the count and the window but spaced the attempts for a 60 s rate window, not for a
multi-minute throttle burst. PR #1994 found that AgentCard answers a throttled request with 401 and
that replays extend the throttle.

Fix: the same 1 + 3 attempts and the same 180 s cap, with growing gaps (30 s, 45 s, 60 s), so the
last attempt lands near the end of the window instead of ~50 s early. There are no extra provider
requests and no longer deadline. `agentcard-benchmark-float-burst.test.ts` replays a 140 s and a
160 s burst on a virtual clock: it fails on main with the provider 401 and passes with the fix.
A second occurrence had the same shape. PR #1994's round-1 smoke guest `browser-auth-guest-purchase` saw its first 429 at 01:02:36Z, used all 1 + 3 passes and gave up at 01:04:46Z, ~115 s into the window. The sandbox throttle ended ~01:04:43Z for all six payment guests. That guest's first call was already a 429, so the load came from other concurrent consumers of the shared sandbox client; production's client stayed clean.
Status stays `mitigated`: a burst longer than the 180 s window still fails the fixture, and the
throttle's origin (shared org-wide budget) is unexplained.

## Human feedback

None recorded.

## Reusable lesson

Give read-only setup that can cancel a whole campaign its own bounded wait across the provider's real recovery window, and retry only typed transient states so real fixture defects still fail immediately.
