---
id: 2026-11-14-agentcard-org-runtime-replayed-throttle-401-back-to-back
date: 2026-11-14
title: AgentCard answers a throttled org request with 401 "Invalid or expired organization token", and the org runtime replayed each 401 six times back-to-back inside the throttle, turning a 429 window into minutes of org-wide 401s
surface: back-end
component: agentcard-org-runtime
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts callOrgMcpTool (3 in-call 401 attempts 250 ms apart) + callToolWithImmediateAuthRetry (immediate full re-call) — 6 HTTP requests per logical call within ~1.5 s after a provider 401
symptoms:
  - "AgentCard Organization MCP get_cardholder_kyc_status failed: Invalid or expired organization token"
  - "AgentCard Organization MCP list_cardholders failed: Invalid or expired organization token"
  - "Organization MCP read auth rejected"
  - "Could not accelerate AgentCard transfer release through residual recovery"
  - "Too many requests, please try again later"
tags:
  - agentcard
  - organization-mcp
  - throttle
  - retry
  - deploy-smoke
sources:
  - PR #1994 (merge e13dacb7831f82de4cdb8e1281de139135773b7d)
  - PR #1994 evidence: Render srv-d3jga77diees73cgrvk0 logs 2026-11-12 22:55-23:56Z and 2026-11-13 00:50-01:15Z
  - PR #1987 deploy smoke agent-payment-new-user-journey (~23:58Z 2026-11-12)
  - PR #1994 round-1/round-2 smoke runs 20261113-005331-* and 20261113-014936-*
  - PR #1981 occurrence eaa5c8e60ba14904bcd6f78931db2912; PR #1910 handoff; #2036 occurrence (agent a70ff481)
  - PR #1796 (prior case 2026-11-08-agentcard-org-read-auth-retry-shorter-than-provider-401-flap)
repro: cd back-end && npx tsx src/tests/blackbox/agentcard-org-runtime.blackbox.ts
status: fixed
---

## Problem

Production Render logged two bursts of AgentCard Organization MCP HTTP 401 "Invalid or expired organization token" on every replica:
- 2026-11-12 23:06:03.6–23:08:28.6Z: 165 lines, instances strvl and 4cvgq.
- 23:50:04.4–23:50:57.7Z: 29 lines, instances w98n8 and nlgr9.

The affected paths were reads, cleanup reclaims, the org-wallet monitor and WalletFunding residual recovery. The same error failed deploy smokes: PR #1987 at ~23:58Z, PR #1981's setup-resume, PR #1910's payment tasks, and PR #1994's own rounds 1 and 2, where the guests ran on the sandbox org client.

## Diagnosis

- **Hypothesis "concurrent OAuth refresh-token rotation" refuted:**
  - The org runtime sends the static `acs_` client secret as Bearer and never mints or refreshes a token.
  - Render events show no env update and no deploy at 23:06 or 23:50 (deploys ran 22:23 and 23:24–23:32).
  - Prod and the guest env use different org client ids (sha256 prefixes 37891a4084 vs 6e63d4d747).
- **Each burst starts with a 429 on the same credential:**
  - 23:06:00.652Z `recover_funds` "Too many requests"; first 401 at 23:06:03.609Z.
  - 23:49:42.712Z `list_transfers` 429; first 401 at 23:50:04.414Z.
  - Across 2026-11-10..13 Render logs, 429s and 401s occur only in the same windows; there is never a 401 without a 429.
  - Guest smoke on 2026-11-13 showed the same pattern: member-discount's first sandbox call at 01:02:36.217Z was already a 429, followed by 401s on six payment guests until 01:04:43Z.
  - Prod stayed clean in that window (~28 ok/min), so budgets are per client.
- **The 401 is AgentCard's throttle answer** (org budget 120 req/min).
- **Amplifier (ours):** on a provider 401 the runtime sent 3 in-call attempts 250 ms apart, then an immediate full client-credential re-call.
  - That is 6 HTTP requests per logical call in ~1.5 s; reads then added 4 flap steps, for 10 in total.
  - Every concurrent caller on every replica did this inside the throttled window.
  - None of the in-call attempts were logged.
- **Local repro:** `assertProviderUnauthorizedIsNeverReplayedWithoutBackoff` failed on f43345a18 with "get_card: request 2 replayed a provider 401 0 ms after the previous one (sent at [0,0,0,0,0,0,1000,3000,7000,15000])". It passes on the fix.

## Solution

PR #1994: a provider 401 is never replayed back-to-back.
- No in-call 401 retry (403 is unchanged).
- No immediate client-credential re-call on a provider 401.
- Reads go straight to the existing 1/2/4/8 s window: 5 requests over 15 s instead of 10.
- Mutations get one replay after a 1 s backoff: 2 requests instead of 6.

Regressions live in `agentcard-org-runtime-throttle-401.cases.ts`, run by the `agentcard-org-runtime` blackbox domain. Deploy smoke on the merged source passed 13/13, including agent-payment-setup-resume, idempotent-abandonment, test-shop, new-user-journey and both browser-auth purchases.

10k-agent behavior: per-call request count during a throttle drops about 6x; there is no new shared state.

Open:
- Sustained budget exhaustion (e.g. 12 min of `test_charge` 401s on #2036's 06:38–06:50Z run) cannot be ridden out by a bounded per-call backoff.
- Thread ph7d3st88 owns a measured follow-up for a process-wide not-before gate after a 429 or throttle 401. It changes production behavior, so it needs a design review.
- The extra load that tipped prod's client at 23:06/23:50 is unattributed (per-attempt counts were not logged).
- The minute org crons (purchase-hold reconcilers, org-wallet monitor) have no cross-replica lease.

## Human feedback

None recorded.

## Reusable lesson

When a provider's auth error coincides with its throttle, treat it as backpressure. Never replay it back-to-back, and verify that hypothesis against the logs before assuming a credential problem.
