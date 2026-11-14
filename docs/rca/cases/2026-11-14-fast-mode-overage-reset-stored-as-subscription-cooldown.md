---
id: 2026-11-14-fast-mode-overage-reset-stored-as-subscription-cooldown
date: 2026-11-14
title: A fast-mode request's overage rejection cooled every Claude subscription until the monthly overage reset
surface: cross
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/claude_auth.py _attempt_with_token (and back-end/src/providers/rose/claudeAuth.ts claudeAuthComplete) treated a fast-mode request's 429 "Usage credits are required for fast mode." as the account's rate limit and surfaced its unified-reset (the monthly overage reset) as the credential cooldown
symptoms:
  - "Usage credits are required for fast mode."
  - claude_code rows rateLimitedUntil 2026-12-01T00:00:00Z rateLimitReason rate_limit rateLimitAuthoritative true while a standard quota check says allowed
  - rose.claude_auth.rotate reason=rate_limit rate_limited_until=2026-12-01T00:00:00Z on a speed=ultrafast agent
  - claude_auth_present=false on every rose-1-ultra rose.complete.start; actual_model never ends in -claude
tags:
  - claude-auth
  - fast-mode
  - subscriptions
  - rate-limit
  - cooldown
sources:
  - agent b2f12926-54b4-4a37-877f-0dfc46fee218
  - task RCA prod ultra calls never use Claude subscription auth (parent thread ph78393fcn3fqnvcdhq1f3jn0s8j3jyk)
  - PR #2030
repro: agents/tests/blackbox/rose.blackbox.py::test_claude_auth_fast_mode_overage_rejection_retries_standard_on_same_token; back-end/src/tests/blackbox/rose.blackbox.ts (claudeAuth / fast-mode overage rejection retries standard on the same token); back-end/src/tests/blackbox/compute-subscription-usage.refresh.cases.ts (a provider cooldown beyond any subscription window is re-checked and lifted when allowed)
status: open
---

## Problem

PR #2030 shipped the fix for unnamed cooldown reports. Prod still made zero
Claude-subscription `Rose.complete` calls from 2026-11-14 02:00Z: every
`rose-1-ultra` call logged `claude_auth_present=false` and was served by
Foundry or the waterfall. All five pooled `claude_code` rows were cooling. Four
of them (`88a02cdc`, `074bfdd5`, `6aa8c17b`, `9b51c93b`) held
`rateLimitedUntil=2026-12-01T00:00:00Z`. Two of those were written at 01:41Z
with `rateLimitReason=rate_limit` and `rateLimitAuthoritative=true`. A
standard-speed 1-token probe at 06:40Z showed every one of the four allowed,
with 7d utilization 0.0 to 0.19.

Evidence:

- ClickHouse `observability.fly_logs`, 2026-11-14 01:41:16-01:41:59Z. Prod
  agent `b2f12926` (`speed: ultrafast`, `rose-1-ultra`, call sites
  `dag_param_populator` and `explore_agent`) logged `rose.claude_auth.rotate`
  with `reason=rate_limit` and `rate_limited_until=2026-12-01T00:00:00Z` on one
  Claude account after another. Each was followed by `Marked compute token
rate-limited`.
- A live probe on `88a02cdc` sent the same 1-token Opus 5.5 body twice:
  - standard: `200`, `unified-status: allowed`, 7d utilization 0.0;
  - `speed: fast` with beta `fast-mode-2026-02-01`: `429`, body
    `"Usage credits are required for fast mode."`, headers
    `unified-reset: 2026-12-01T00:00:00Z` and
    `unified-overage-disabled-reason: org_level_disabled`. No 5h or 7d window
    was rejected.
- The two rows already at `12-01` since 2026-11-06 10:36/10:37 came from a
  devbox agent's `tokenType=claude` lease. Their 429 headers were not
  captured. The value fits the same overage reset; that is unproven.

## Diagnosis

Fast mode on a Claude subscription is billed as extra usage (overage). When
the organisation has extra usage disabled, Anthropic rejects the fast request
with the MONTHLY overage reset. The account's own 5h/7d windows keep serving
standard requests.

`anthropic_speed_for` sends `speed: "fast"` (and the transport adds the
fast-mode beta) for every `fast` or `ultrafast` agent on Opus. Both Rose
clients handled that 429 like any other. They parsed `unified-reset`
(2026-12-01) as a far-future usage window, rotated, and marked the credential
with that reset as an authoritative `rate_limit` cooldown. Each rotation
leased the next subscription and made another fast request, so a single
ultrafast agent cooled every Claude account until the first of next month.

Deepest owned cause: the client equated "this request's billing tier is
unavailable" with "this credential is exhausted". Claude Code keeps them apart
(`services/api/withRetry.ts:266-281`): a fast-mode 429 carrying
`anthropic-ratelimit-unified-overage-disabled-reason` calls
`handleFastModeOverageRejection` (`utils/fastMode.ts`), turns fast mode off and
retries at standard speed on the same credential. Nothing is cooled.

A second gap let the damage persist. Reconcile (PR #2030) lifted only Rose's
own non-authoritative backoffs, so a provider-sourced reset that no
subscription window can produce stayed until 12-01.

Repro (all three fail before the fix, pass after):

- `cd agents && source venv/bin/activate && BLACKBOX_CASE_FUNCTIONS=test_claude_auth_fast_mode_overage_rejection_retries_standard_on_same_token python scripts/run_blackbox_tests.py rose`
  - pre-fix: `RoseRateLimitError: claudeAuth exhausted after 1 rotations (rate_limit)`
- `cd back-end && ROSE_BLACKBOX_TEST_FILTER='fast-mode overage' bash scripts/run-blackbox-tests.sh rose`
  - pre-fix: `FAIL claudeAuth / fast-mode overage rejection retries standard on the same token -- Anthropic 429`
- `cd back-end && bash scripts/run-blackbox-tests.sh compute-subscription-usage`
  - pre-fix: `FAIL a provider cooldown beyond any subscription window is re-checked and lifted when allowed -- ... must be re-checked even with fresh usage`

## Solution

- `claude_auth.py` `_attempt_with_token` and `claudeAuth.ts`
  `claudeAuthComplete`: a 429 to a fast request that carries
  `anthropic-ratelimit-unified-overage-disabled-reason` does three things. It
  turns fast mode off for that token until the reported reset (process-local
  and bounded; one hour without a reset). It retries the same token at
  standard speed with a fresh attempt budget. It surfaces no rate limit, so
  nothing is cooled. Later calls on that token skip the doomed fast request.
- `reconcileRoseCooldown` and `usageNeedsRefresh`: a cooldown ending more than
  `SUBSCRIPTION_WINDOW_MAX_MS` (7d + 1h) out is not a usage-window reset,
  whoever wrote it. The standard-speed quota check re-checks it. An allowed
  answer lifts it, and a rejected answer replaces it with the spent window's
  reset. Auth cooldowns are untouched. The four stuck rows heal on their next
  refresh, with no manual DB write.

Sibling failures prevented: every fast/ultrafast agent and chat call on a
subscription whose org has extra usage off.

10k agents: no new shared state. The latch is a bounded per-process map, and
the reconcile is one conditional UPDATE per row refresh.

Golden reference:

- `claude-code-src/src/services/api/withRetry.ts:266-281` and
  `claude-code-src/src/utils/fastMode.ts` (`handleFastModeOverageRejection`):
  the fix converges on these.

Open follow-ups (from the GROUNDED review, not fixed here):

- A fast 429 without `overage-disabled-reason` (an account with extra usage
  on, hitting a fast-mode-specific limit) still cools the account. Claude Code
  falls back to standard speed there too, via a fast-mode cooldown
  (`withRetry.ts:284-301`).
- The Anthropic API-key leg still sends `speed: fast` and backs the key off
  on a fast-mode 429. hermes-agent
  (`agent/turn_recovery.py:252-258`, `agent/fast_mode.py:92-115`) drops
  `speed` for that model before any credential is benched.

## Human feedback

The parent thread relayed Andy's rules: do not mint, rotate or revoke
credentials. It chose option (b) for the stuck rows: reconcile re-probes any
authoritative cooldown more than 7 days out at standard speed and lifts it
when allowed, inside this PR, with no hand-run prod write.

## Reusable lesson

Never let a request-tier rejection (fast mode, priority, extra usage) set the
credential's cooldown. Drop the tier and retry the same credential, and treat
any cooldown longer than the provider's longest usage window as wrong until a
standard request proves it.
