---
id: 2026-08-05-compute-token-db-write-healthy-waterfall-from-transient-claudeauth-refusal
date: 2026-08-05
title: Connected compute 'not used' was a transient Anthropic claudeAuth refusal, not a DB-write bug
surface: agents
component: rose-client-claude-auth
classification: third-party-failure
problem_class: other
first_bad_boundary: agents/providers/rose/streaming.py refusal classification on the claudeAuth (Anthropic OAuth) stream — RoseRefusalError falls the single call through to the waterfall
symptoms:
  - "connected claude and codex compute but agents I spawn aren't using the tokens"
  - "rose.complete.direct_auth.failed"
  - "token_error: refusal / RoseRefusalError"
  - "Claude token fallback (transient: refusal): actual_model=anthropic/claude-opus-4.8, keeping token for retry"
  - "active_route: waterfall while a healthy claude_code Integration exists"
tags:
  - compute-token
  - claude-auth
  - refusal
  - waterfall
  - integration-write
sources:
  - agent 51ab1ed8-e66a-4cd6-acfc-d139808928bd
  - commit ce7c4060b
repro: none — no owned defect reproduced; DB-write path proven healthy, tokens observed in use
status: open
---

## Problem

User reported: "connecting our claude and codex compute … any agents I spawn
aren't using the tokens," suspected a **DB write** bug (branch
`andyprevalsky/compute-token-db-write`). Runtime evidence refutes the DB-write
hypothesis: the write is healthy and the tokens ARE being used.

## Diagnosis

Evidence (prod, 2026-08-05, user 1f85ff25… = Andy):

1. **DB write is healthy.** `Integration` rows `claude_code` and `gpt_code` for
   the user are `status=CONNECTED`, `poolingEnabled=true`, `rateLimitedUntil=null`,
   `failureReason=null`, `config.encryptedCredentials` present (2168 / 7904 chars),
   `lastSuccessfulSyncAt` ~18:04–18:05. Write path
   `back-end/src/domains/integrations/service.ts:483 uploadClaudeCodeCredentials`
   → `repo.upsertIntegrationRaw` sets exactly these fields; it round-trips a
   decrypt check (`verifyCredentialEnvelopeDecryptable`) before persisting, so a
   stored row is guaranteed decryptable with the server key.
2. **Read path serves the user's own token** (no `poolingEnabled` requirement for
   the owner): `computeCredentials.ts:406 fetchComputeTokenForUser` lineage branch
   (`:433-450`). `ComputeTokenLineageLease` shows agent `51ab1ed8` acquired a
   `claude`/`user` lease at 18:05:31, and `Integration.claude_code.lastUsedAt`
   updated to 18:05:29 — proof the backend served Andy's own token.
3. **claudeAuth is attempted and mostly succeeds.** ClickHouse `fly_logs` for
   agent `51ab1ed8`: `claudeAuth ok ×2`, `error ×1`;
   `complete_route: direct_auth:claude ×2`, `waterfall ×1`. Timeline:
   18:05:32 plan_loop claudeAuth → `RoseRefusalError` (`token_error: refusal`,
   `rotations: 0`) → waterfall for that one call; 18:21:48 + 18:21:52 execute_loop
   claudeAuth → **ok**, ran on Andy's Claude token. So 2 of 3 completions used the
   connected token; the one refusal was transient and self-healed (re-attempted
   and succeeded). This also refutes the 2026-04-18 relative
   ("any claudeAuth failure permanently nulled the token") — the token was kept
   and reused.
4. Prod-wide over 24h, claudeAuth is low-volume (3 agents) with mixed
   third-party outcomes: `claude/rate_limit ×3`, `gpt/auth_error ×3`,
   `claude/refusal ×1`, and at least one `claude-fable-5-claude` `ok` — i.e. the
   claudeAuth path is not systematically broken.

First-bad boundary is the Anthropic claudeAuth stream returning a refusal/
policy code (classified to `RoseRefusalError` at
`agents/providers/rose/streaming.py:61,310`), which is a **third-party** outcome,
handled correctly (transient → single-call waterfall, token retained). No owned
DB defect exists.

Secondary observations worth separate follow-up (NOT the cause):
- The paid waterfall's OpenAI leg is itself `insufficient_quota /
  credit_balance_exhausted`, so a failed claudeAuth lands on the paid Anthropic
  waterfall rather than a free path.
- The user's `userId` (1f85ff25…) has **no `User` row** (80,033 users exist; this
  id absent) yet owns the Integration/Agent rows — an orphaned-identity data
  anomaly, harmless to token serving but worth investigating.

## Solution

No owned code fix. The DB write/read/decrypt path is healthy and tokens are in
use. The observed waterfall fallbacks are transient Anthropic refusals /
rate-limits on the personal Claude subscription token, which self-heal.
Open follow-ups (separate from this hypothesis): (a) top up the OpenAI waterfall
credits so a transient claudeAuth miss does not land on the most-expensive path;
(b) investigate the orphaned `User` row for 1f85ff25….

## Human feedback

None recorded.

## Reusable lesson

Before treating "my connected compute isn't used" as a DB-write bug, query the
Integration row + lineage lease + ClickHouse `direct_auth`/`llm.attempt` traces:
a healthy row plus `complete_route: direct_auth:claude` proves the token is used
and reframes the symptom to a transient Anthropic refusal/rate-limit.
