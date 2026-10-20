---
id: 2026-10-20-compute-lease-served-claude-envelope-past-own-expiry
date: 2026-10-20
title: Compute-token lease served a Claude OAuth envelope already past its own expiresAt
surface: back-end
component: compute-credentials
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/computeCredentials.ts rowToCredential returned a Claude access token without checking the envelope's own claudeAiOauth.expiresAt
symptoms:
  - "OAuth access token has expired. Re-authenticate to continue."
  - "Compute credentials not found for user"
  - "GET /api/integrations/compute-code/credentials/token 404"
  - "disabled after auth_error"
  - "actual_model gpt-6-sol-gpt compute_token_rotated true"
tags:
  - claude-oauth
  - compute-token
  - token-expiry
  - silent-failover
  - mac-app-credential-sync
sources:
  - task reasoning-probe ultra-claude 2026-10-20 02:05Z (req_011CgCfqx63ou9MX75qtdXL7)
  - memory:devbox-codex-oauth-revoked-use-prod-credential
repro: back-end/src/tests/blackbox/compute-grant-readpath.blackbox.ts::a Claude envelope past its own expiresAt is never leased to an agent
status: fixed
---

## Problem

A live probe (2026-10-20 ~02:05Z) leased a Claude compute token for user
1f85ff25 through `fetch_compute_token_activity(token_type="claude")`. The
backend served Integration `7e916787` (source `user`); both Anthropic calls
returned 401 `OAuth access token has expired. Re-authenticate to continue.`
Rose rotated, the re-lease returned 404 `Compute credentials not found`, and the
call was silently served by `gpt-6-sol-gpt`.

Prod DB (read-only) showed the served row's decrypted envelope was a Mac keychain
OAuth envelope (refresh token present, 8h access token) with
`expiresAt = 2026-10-15T03:05Z`: five days expired when it was leased. It had
`lastSuccessfulSyncAt = 2026-10-20T01:21Z`. Render logs show the Mac app
re-uploaded that same stale keychain envelope at 2026-10-18 22:01Z,
2026-10-19 23:20Z and 2026-10-20 01:21Z. Each upload sets `CONNECTED`, clears
`failureReason` and resets `lastUsedAt = null` (first in LRU order). The next
lease produced the 401. That disabled the account (2026-10-16 20:01Z,
2026-10-19 18:26Z, 2026-10-20 01:13Z and 02:05Z), and the cycle repeated.

Every one of those disables logged `"updated":3`. `markUserTokenRateLimited`
was called with only `userId` (agents never learn the integration id), so it
marked **all three** of the user's `claude_code` rows EXPIRED, including the
year-long setup-token `074bfdd5` and `88a02cdc`. That collateral damage is why
the re-lease returned 404: prod has only these three `claude_code` rows, so no
Claude user or pool token remained.

Impact (prod, read-only): `ToolUsage` LLM items served by any `*-claude` Opus,
Sonnet or Fable model: 775 between 2026-08-01 and 09-12, and **zero from
2026-09-13 to 2026-10-20** (only 26 `claude-haiku-4-5-claude` items through
10-07). In that window 1,851 `gpt-6-sol*` items were served in the slot whose
Claude lease maps to Opus. ClickHouse (7-day retention): 54 Anthropic attempts
from 2026-10-12, all errors — 52 funded API-key out-of-credits 400s and two OAuth
401s from the resurrected expired envelope. No live OAuth token reached Opus in
that window, so the separate `claude_code_version_too_old` 400 (claude-opus-5-5
needs CLI ≥2.1.280 and the transport sends 2.1.251; owned in
`2026-09-10-claude-oauth-client-version-below-model-minimum`) never appeared in
retained logs. It would have masked Opus even with a healthy token from
2026-09-27 onward. The reconnected token returns that 400 for Opus and 200 for
sonnet-5 and haiku-4-5. There is no alerting: every failure is a `warning` log
followed by fallthrough.

## Diagnosis

Critical path: Mac keychain → `/claude-code/credentials/upload` (stores as
CONNECTED) → `fetchComputeTokenForUser` → `rowToCredential` → agents
`ClaudeAuthContext` → Anthropic 401 → `_RotateToken(auth_error)` →
`mark_compute_token_rate_limited_activity(userId)` →
`markUserTokenRateLimited` (unscoped updateMany) → re-lease 404.

First bad data: `rowToCredential` served `claudeAiOauth.accessToken` without
reading `expiresAt`. The server never refreshes Claude grants by design
(compute-token-semantics: refresh is single-use and revokes the user's local
Claude Code token), so an envelope past its own expiry is provably dead. The pool
predicate even accepted any *refreshable* envelope regardless of expiry. Nothing
on this path refreshes it, so "refreshable" meant nothing here.

Why 1: `rowToCredential` and `hasUsableClaudePoolEnvelope` checked shape and
scope, not expiry. Why 2: the only liveness signal was a real provider 401. Its
handler retires every Claude account of the user, not the failing row, turning
one dead envelope into a total Claude outage. Why 3 would be the Mac app syncing
a stale keychain envelope. That client re-upload is legitimate input
(the keychain is the user's source of truth); the lease boundary is the owned
place to validate it.

Local reproduction (owning suite, isolated local DB
`victoria_agent-ad27cafeb8413ea20`):

```bash
cd back-end && L=postgresql://postgres:postgres@localhost:5432/victoria_agent-ad27cafeb8413ea20
DATABASE_URL=$L DIRECT_URL=$L FAST_MODE_CACHE_DATABASE_URL=$L \
  node --import tsx src/tests/blackbox/compute-grant-readpath.blackbox.ts
```

Pre-fix: `FAIL a Claude envelope past its own expiresAt is never leased to an
agent — user path leased an access token past its own expiresAt`
(RESULTS 11/12). Post-fix: 12/12. The red run was repeated with the final
strengthened assertion by reverting only `computeCredentials.ts`.

Golden reference: `claude-code-src/src/services/oauth/client.ts:344`
(`isOAuthTokenExpired`: `expiresAt === null` → not expired) and
`claude-code-src/src/services/api/usage.ts:38-41` ("Skip API call if OAuth
token is expired to avoid 401 errors"). The fix converges on that. It deliberately
omits Claude Code's 5-minute refresh buffer, because we never refresh and must
not retire a still-valid token.

## Solution

`computeCredentials.ts` now parses the Claude envelope once
(`parseClaudeEnvelope`). Any envelope whose own `expiresAt` has passed is skipped
on every lease path: user, pool, and existing lineage lease. Exactly that row is
retired via `markUserTokenRateLimited(userId, { failureReason: 'auth_error',
integrationId })`, so it shows as needing reconnect, the warning is logged
once, and sibling accounts stay CONNECTED. This removes the guaranteed-401
round trip and its user-wide collateral disable for this class.
The pool predicate keeps its prefix + (refresh lineage | setup-token scope)
rule minus the meaningless "refreshable while expired" pass.

Regression: new case in `back-end/src/tests/blackbox/compute-grant-readpath.blackbox.ts`
(backend blackbox runner, `/deploy` Step 5a). It covers the user, lineage and
pool paths, EXPIRED surfacing, and a healthy sibling account staying served
and CONNECTED.

10k agents: no new queries on the healthy path (the envelope was already
decrypted per lease). An expired row costs one scoped update, once, then leaves
the CONNECTED candidate set.

Open sibling (not fixed here): a real provider 401 still reaches
`markUserTokenRateLimited` with only `userId`. That disables every Claude account
of the user, because neither the lease response nor `mark_compute_token_rate_limited_activity`
carries the integration id, and user lineage leases key on `userId`. Fixing that
needs integration identity threaded through the lease contract.

## Human feedback

None recorded.

## Reusable lesson

Never lease a credential its own envelope already marks expired when nothing on
the path can refresh it, and retire only the failing row, never the user's
sibling accounts.
