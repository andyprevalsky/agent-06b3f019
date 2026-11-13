---
id: 2026-11-13-claude-usage-endpoint-403-inference-scope
date: 2026-11-13
title: Claude usage bars never got windows or reset times because the usage refresher asked an endpoint that 403s every inference-only setup-token
surface: back-end
component: compute-usage-refresh
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/computeUsageRefresh.ts refreshClaudeUsage called GET https://api.anthropic.com/api/oauth/usage with every Claude row's token, but Rose's accounts are setup-tokens scoped user:inference only; the endpoint requires user:profile, so it answered 403 and the refresher stored nothing and backed off 60 minutes
symptoms:
  - 'ComputeUsageRefresh usage_endpoint.unavailable status=403'
  - '{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}'
  - GET /api/oauth/usage 403 for every claude_code account
  - compute usage bars empty with no reset time after PR #1981
  - usageObservedAt null on every CONNECTED claude_code Integration row
tags:
  - usage-bars
  - compute-accounts
  - subscription-usage
  - oauth-scope
  - setup-token
  - anthropic
  - quota-check
sources:
  - commit cfc940ef32 (added refreshClaudeUsage)
  - PR #1981 (merged 5d8e6d4d39)
  - commit 7c1e7ccdee (fix)
repro: back-end/src/tests/unit/compute-usage-quota-check.test.ts; back-end/src/tests/blackbox/compute-subscription-usage.refresh.cases.ts (an inference-only Claude login gets its windows and resets from a quota check; a Claude login the usage endpoint refuses (403 scope) falls back to a quota check), run by back-end/src/tests/blackbox/compute-subscription-usage.blackbox.ts
status: fixed
---

## Problem

PR #1981 merged as 5d8e6d4d39 to make the compute usage bars retrieve their
usage and reset times automatically. The acceptance criterion was that reset
times are retrieved without user action. After the deploy, the Render logs
showed one line per Claude account and no stored usage:

```
2026-11-13T11:00:05Z ComputeUsageRefresh usage_endpoint.unavailable integrationId=d50e4b97-… status=403
2026-11-13T11:00:57Z … 9b51c93b-… 6aa8c17b-… d50e4b97-… 88a02cdc-… 074bfdd5-… status=403
```

All five production Claude rows got 403. A read-only check of those rows
(`SET TRANSACTION READ ONLY`, rolled back; envelope metadata only, never a
token) showed the same credential shape for each one. Each row is a CONNECTED
`sk-ant-oat` setup-token. Its envelope declares `scopes: ["user:inference"]`,
it has no refresh token, its `expiresAt` falls in 2027, and its
`usageObservedAt` is null. The bars therefore had no data.

Archive searches were `usage_endpoint.unavailable 403 oauth usage scope
user:profile` and `usage bars reset time not retrieved inference-only
setup-token`. The relative case is
`2026-11-12-usage-snapshot-sent-only-on-next-heartbeat-and-every-cooldown-drawn-exhausted`,
which added this refresher. Its endpoint path was never exercised with a real
production credential. This incident is novel and is not a recurrence.

## Diagnosis

Critical path:
`GET /api/compute-accounts` (or a non-authoritative cooldown mark) →
`usageNeedsRefresh` → `scheduleClaudeUsageRefresh` → `refreshClaudeUsage` →
`readClaudeAccessTokenForUsage` → `GET /api/oauth/usage` →
`recordIntegrationUsage` → `Integration.usage*` → `accountUsageView` → bar.

Binary search:

- The trigger fired. Five `usage_endpoint.*` lines appeared within a minute
  of the deploy.
- The token read succeeded. A null token returns `no_token` before any
  request, and every row reached the request.
- The first bad boundary is the provider response.

Live capture through the unchanged refresher on main 969a862d4b ran
`refreshClaudeUsage` with the real token reader and the real `fetch`. The store
was capture-only, and only the provider's error type and message were printed.
The endpoint returned 403
`{"type":"permission_error","message":"OAuth token does not meet scope
requirement user:profile"}` (request `req_011Cgzq5SnJ3Ft34iZvXWPeJ`). The
outcome was `unavailable`, and the stored list was `[]`.

Cause: the endpoint needs the `user:profile` scope. Rose's accounts are
long-lived setup-tokens, which carry `user:inference` only. The golden
reference treats the endpoint as profile-only:

- `claude-code-src/src/services/api/usage.ts:34`: `fetchUtilization`
  returns early unless `hasProfileScope()`.
- `claude-code-src/src/utils/fastMode.ts:424`: "Service key OAuth sessions
  lack user:profile scope → endpoint 403s".
- `claude-code-src/src/services/oauth/client.ts:81`: inference-only tokens
  request `[CLAUDE_AI_INFERENCE_SCOPE]` only.

For quota, Claude Code does not use this endpoint.
`claude-code-src/src/services/claudeAiLimits.ts:199-249` (`makeTestQuery` /
`checkQuotaStatus`) sends one `max_tokens: 1` request on the small fast model.
It reads the `anthropic-ratelimit-unified-*` headers from that response, or
from the 429 error.

Ladder (Step 5a):

1. Why did no usage get stored? The refresher's only source was an endpoint
   that this credential type cannot use. It handled the 403 as
   "unavailable", with no other path for the row.
2. Why was that possible? `readClaudeAccessTokenForUsage` returned a bare
   token. The stored envelope's `scopes` were parsed for pool eligibility
   (`inferenceScope`) but never consulted for the usage endpoint. The
   refresher had no input from which to tell that the endpoint would refuse.
3. Why was the gap not caught? The unit test asserted the 401/403 branch as
   the intended outcome: unavailable, nothing stored. No test seeded the
   production credential shape, a setup-token with scopes
   `["user:inference"]`.

The next rung would be the decision to use setup-tokens. That is a deliberate
design choice (`isUsableClaudePoolEnvelope`), so the ladder stops there.

Hermetic reproduction on main, with the source unchanged and only the new
tests added:

- `npx tsx src/tests/unit/compute-usage-quota-check.test.ts`, run against an
  immutable `git archive origin/main` export (969a862d4b), exited 1. Output:
  `usage_endpoint.unavailable integrationId=row-setup status=403` and
  `AssertionError: an inference-only account must get its windows and resets
  + 'unavailable' - 'stored'`.
- `bash scripts/run-blackbox-tests.sh compute-subscription-usage` exited 1
  with 20/22 passing. The case "an inference-only Claude login gets its
  windows and resets from a quota check" failed with "a token without
  user:profile never calls the usage endpoint". The case "a Claude login the
  usage endpoint refuses (403 scope) falls back to a quota check" failed with
  "the refresh must store the account's windows, got unavailable".

## Solution

Commit 7c1e7ccdee follows the golden reference.

- `parseClaudeEnvelope` now exposes `profileScope`.
  `readClaudeUsageCredential` returns `{ accessToken, profileScope }`.
- `refreshClaudeUsage` calls the usage endpoint only for `user:profile`
  tokens. An inference-only token goes straight to the quota check. So does a
  token the endpoint refuses with 401 or 403.
- The quota check is `claudeQuotaCheck` in `providers/rose/claudeAuth.ts`. It
  uses the same `buildAnthropicBody` and `postAnthropicStream` OAuth transport
  as chat. The request is `max_tokens: 1` with the content `quota` on
  `rose-1-mini` (Haiku, already in the OAuth client contract). It makes one
  attempt, with no retry or rotation, and cancels the stream unread.
- Its headers go through the chat path's own parser,
  `analyzeSubscriptionUsage`, and then `parseUsagePayload` and
  `recordIntegrationUsage`. The usage source stays `response` or
  `rate_limit`. There is no new enum value and no Zod change.
- A refused quota check stores nothing and backs off for 60 minutes. It never
  marks the account; the lease path owns auth classification.

Live check of the fix through the same code path, with a capture-only store:
the setup-token's quota check returned 429 with
`anthropic-ratelimit-unified-7d-status: rejected` and
`7d-reset 1794589200` (request `req_011CgzqeqvGXYtSEn68SKUsQ`). The refresher
produced `sevenDay {usedPct: 100, resetsAt: 2026-11-13T17:00:00Z}`, source
`rate_limit`, status `rejected`, outcome `stored`. That is the reset time the
bar needs.

Verification on 7c1e7ccdee:

- The unit test exits 0 on five consecutive runs.
- `compute-subscription-usage` passed 22/22 on five consecutive runs.
- All 150 selector-chosen backend unit files pass.
- Prettier, ESLint and backend `tsc --noEmit` are clean.

The fix also covers a sibling failure: a `user:profile` login whose access
token the endpoint refuses now gets the same fallback instead of an hour with
no data.

At 10k agents the cost depends on account rows, not agents. Each row gets at
most one refresh per 5 minutes per backend process, and only when its usage is
missing, stale (over 30 minutes) or under a non-authoritative cooldown. Each
refresh sends at most one GET plus one one-token request; an inference-only row
sends only the one request. Nothing runs on the completion path. Busy accounts
stay fresh from their own response headers and never trigger a check. Golden
reference: cited above. The change has no approval-gated hunk; the prompt,
agent-behavior and trajectory-injection guards report none.

## Human feedback

Andy, 2026-11-12 15:51Z (recorded in the relative case): "We need to display
the next reset times when empty (should be auto retrieved when we get a failing
req / these bars should be updating in a non blocking way from normal
Rose.complete usage)". This 403 left that requirement unmet in production. No
further human feedback was recorded during this RCA.

## Reusable lesson

Before depending on a provider endpoint, check the scopes the stored credential
actually carries against what the golden client requires, and test with the
production credential shape rather than a generic token.
