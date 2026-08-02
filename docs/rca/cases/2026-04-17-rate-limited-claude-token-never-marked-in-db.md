---
id: 2026-04-17-rate-limited-claude-token-never-marked-in-db
date: 2026-04-17
title: A rate-limited Claude Max token was cleared from cache but never marked in the DB, so every retry re-fetched the same blocked token
surface: agents
component: claude-token-rotation
classification: our-bug
problem_class: other
first_bad_boundary: workflow _on_tokens — cleared the local cache without writing rateLimitedUntil to the credential row
symptoms:
  - rate_limit or auth_error on Claude Max followed by retries on the identical token
  - Anthropic-pinned smoke runs never rotate off Andy-token to pool-token-2
  - fetchClaudeCodeAccessToken and fetchPoolToken keep returning the blocked token
tags:
  - claude-token
  - rate-limit
  - rotation
  - credentials
  - smoke
sources:
  - commit 3bd35b010
repro: back-end/src/tests/blackbox/integrations.blackbox.ts
status: fixed
---

## Problem

When the workflow hit `rate_limit` or `auth_error` on Claude Max, it cleared the
local token cache but never marked the token rate-limited in the DB. So
`fetchClaudeCodeAccessToken` and `fetchPoolToken` kept returning the same blocked
token on every retry. Anthropic-pinned smoke runs stayed pinned to the same user
token indefinitely and never rotated to `pool-token-2`.

## Diagnosis

Rotation state lived only in process-local cache, while token selection read from
the database. Clearing the cache therefore accomplished nothing: the next fetch
re-selected the same row because the row carried no signal that it was blocked.
The workflow also did not know _which_ row to mark or which pool ID to rotate off
of, because `fetch_claude_max_token_activity` returned only the access token.

## Solution

`fetch_claude_max_token_activity` now returns `{accessToken, source, poolTokenId}`
so the workflow knows which DB row to mark and which pool ID to rotate off.
A new `mark_claude_token_rate_limited_activity` POSTs to
`/api/integrations/claude-code/token/rate-limited` with a time-windowed
`rateLimitedUntil` (default now+5min, matching `POOL_RATE_LIMIT_COOLDOWN_MS`).
The workflow's `_on_tokens` marks rate-limited BEFORE clearing the cache and
proactively refetches, so subsequent LLM calls in the same phase use the rotated
token instead of falling back to racing until the next phase boundary. The marker
is TIME-WINDOWED, not permanent: both `fetchPoolToken` and
`fetchClaudeCodeAccessToken` filter on `rateLimitedUntil < now`, so tokens
auto-heal after the cooldown.

Cemented by new blackbox tests in `integrations.blackbox.ts` covering all five
failure modes: user rate-limited → pool token; pool A rate-limited → next forced
fetch returns pool B; past `rateLimitedUntil` → available again; all tokens
rate-limited → 404 `NoTokensAvailableError`; default cooldown is bounded (not null,
not permanent). Tests seed real encrypted credential envelopes matching
`decryptCredentialEnvelope`'s format (RSA-OAEP-SHA256 wrapping AES-256-GCM) and
assert both the HTTP contract and the underlying Prisma state.

## Human feedback

None recorded.

## Reusable lesson

Rotation state must live where selection reads it — clearing a local cache does not
rotate anything when the picker queries the database.
