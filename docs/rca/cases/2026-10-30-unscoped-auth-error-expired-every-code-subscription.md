---
id: 2026-10-30-unscoped-auth-error-expired-every-code-subscription
date: 2026-10-30
title: One leased token's auth_error expired every code-agent subscription its user had
surface: cross
component: compute-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py mark_compute_token_rate_limited_activity reported source=user auth_error with only userId; back-end markGptUserTokenRateLimited / markUserTokenRateLimited then ran updateMany over every claude_code / gpt_code row of that user
symptoms:
  - all of a user's claude_code / gpt_code rows EXPIRED with failureReason auth_error and an identical updatedAt
  - "disabled after auth_error", updated > 1, accountId null, integrationId null in Render logs
  - every Codex / Claude Code session falls through to paid Azure
tags:
  - oauth
  - compute-token
  - subscriptions
  - codex
  - claude-code
sources:
  - task User Scale Bug Bash lane S33 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1644
repro: back-end/src/tests/blackbox/integrations.scoped-auth-expiry.cases.ts
status: fixed
---

## Problem

Prod had no usable code-agent subscription for Andy: all three `claude_code`
rows and two of three `gpt_code` rows were EXPIRED (`auth_error`), so every
code session ran on the paid Azure fallback.

## Diagnosis

Evidence (Render prod logs, read-only DB):

- Each batch shares one `updatedAt` to the millisecond (gpt: 2026-10-29
  03:15:17.292; claude: 2026-10-30 18:09:38.393), i.e. one `updateMany`.
- Render (prod; req 277d3376ff0e gpt, 36c6bfbac24f claude) made both writes through
  `POST /api/integrations/compute-code/token/rate-limited`, logging
  `disabled after auth_error`, `updated: 3`, `accountId: null`,
  `integrationId: null`.
- Across all users, only Andy's two batches (5 rows) match the pattern.
- Ruled out: a devbox gate rotating a prod token, concurrent refresh between
  instances, and upstream revocation. The expiry was our own write, and it was
  issued without naming a credential.

Root cause:

The compute-token lease served one `Integration` row but never told the worker
which one. On a 401/403 the worker reported `{type, source:"user", userId,
failureReason:"auth_error"}`. The service forwarded only `userId`, and the
user branch expired every matching row. One bad account therefore expired
every healthy sibling subscription.

## Solution

- The lease returns `integrationId`. The worker captures it in the auth
  context's mark callback and sends it back. The route and service pass it to
  the mark functions, which already scope by `integrationId`.
- Guard: an `auth_error` that names neither an integration nor an account never
  expires anything when the user has more than one live row. Workflow-threaded
  tokens that lack the id rotate to a fresh, scoped lease, and that lease's
  failure expires exactly the bad row.

## Regression

- `integrations.scoped-auth-expiry.cases.ts` (integrations blackbox, pooled
  sequential group): two accounts. An unscoped `auth_error` leaves both
  CONNECTED, the lease names the served row, and a scoped `auth_error`
  expires only that row. Before the fix both rows became EXPIRED.
- `rose.blackbox.py` `user_auth_error_report_names_the_leased_integration`:
  the worker's report body carries the leased `integrationId`.

## Human feedback

Andy (via parent, 2026-10-30): find why the subscriptions expired; never let a
test or second instance rotate a prod token; do not modify prod credentials;
he reconnects after the fix. Restoring the 5 collateral rows waits for his OK.

## Reusable lesson

A failure report must name the exact credential that failed. Any write keyed
only by user (or other coarse owner) can turn one bad credential into an
outage of every sibling. When the identity is missing, refuse the destructive
write and let a scoped retry handle it.

10k-agent behaviour:

The guard adds one indexed `count` per unscoped auth report. Scoped reports
update a single row by primary key. No new channels or fan-out.
