---
id: 2026-10-26-claude-code-sandbox-refreshed-shared-oauth-grant
date: 2026-10-26
title: Claude Code sandboxes received and force-refreshed users' shared OAuth refresh tokens
surface: back-end
component: claude-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/claudeCredentials.ts buildClaudeCodeCredentialResult / forceOauthEnvelopeRefresh handed the full claudeAiOauth envelope (refreshToken) to E2B and expired it so the sandbox CLI refreshed
symptoms:
  - "Not logged in · Please run /login"
  - Claude Code on the user's Mac signed out after a Rose code agent ran
  - invalid_grant on Claude OAuth refresh
  - Serving refreshable user Claude Code envelope after direct-token auth failure
  - concurrent Claude Code sandboxes of one user revoke each other
tags:
  - claude-code
  - oauth
  - refresh-token
  - e2b
  - credentials
  - scale-100-seats
sources:
  - task User Scale Bug Bash lane S12 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - task S12 read-only evidence worker thread ph74xqb2qy847y823f4hq3tq6d8h15cg
  - memory:devbox-codex-oauth-revoked-use-prod-credential
  - PR #1590
repro: back-end/src/tests/blackbox/integrations.claude-shared-grant.cases.ts
status: fixed
---

## Problem

Claude Code E2B sandboxes received the user's full `claudeAiOauth` envelope,
including the refresh token, as `CLAUDE_CODE_CREDENTIALS`. In two cases,
`forceOauthEnvelopeRefresh` set `expiresAt=0` and dropped
`CLAUDE_CODE_OAUTH_TOKEN`, so the sandbox CLI spent the refresh token before its
first request:
- the access token expired within 5 minutes;
- the row was EXPIRED with `failureReason=auth_error`.

Anthropic refresh tokens are single-use, and a refresh revokes every earlier
access token of the grant (measured and modelled in
`compute-token-semantics.blackbox.ts`). The Integration is a copy of a grant
the user's own Claude Code still holds (Mac Keychain upload). One sandbox
refresh therefore signs the user out on their Mac and revokes concurrent
sandboxes. The rotated token stays in the sandbox and is never persisted, so
prod's stored copy is dead too.

Prod evidence (read-only, fingerprints only) for user 1f85ff25:
- Row `074bfdd5` (andy@hinavi.ai) is EXPIRED auth_error and not rate-limited.
  Its refresh token `9346b7bf5bbd` has an access-token expiresAt of 2026-10-15.
- Row `7e916787` shares the same grant.
- So every Linux deploy smoke (`BLACKBOX_SMOKE=1` → `syncAndyClaudeTokensFromProd`)
  served this grant through the forced-refresh path.

The triggering incident was every RCA-lane devbox logging out at
21:59:20–22:05:15Z on 2026-10-26. The evidence does **not** attribute that to
this defect:
- Devboxes authenticate as a different Claude account (andyprevalsky111),
  through a boxes.dev-injected access-token-only `CLAUDE_CODE_OAUTH_TOKEN`.
- There is no refresh token on the box, and no prod row shares that grant.

The most consistent explanation is boxes.dev's central refresher rotating that
login, which revokes the env token of every already-running Claude process.
That is an open gap on the boxes.dev side and was reported via
`dvb-onbox report-bug`.

## Diagnosis

1. Claude Code reference (`claude-code-src/src/utils/auth.ts`
   getClaudeAIOAuthTokens) treats `CLAUDE_CODE_OAUTH_TOKEN` as inference-only:
   `refreshToken: null`, never refreshed. A credentials file with a refresh
   token is refreshed once it is within 5 minutes of expiry
   (`services/oauth/client.ts` isOAuthTokenExpired), and force-refreshed after
   a 401.
2. `buildClaudeCodeCredentialResult` returned `credentialMode: 'oauth_envelope'`
   with the full envelope. `forceOauthEnvelopeRefresh` removed the access
   token, so only the file path remained, and that path refreshes.
3. The compute-token lease path already encoded the opposite contract
   (`claudeOauthEnvelope.ts`: "The server never refreshes a Claude grant").
   The code-sandbox path contradicted it, a logical inconsistency between two
   consumers of the same credential.

Local repro: `.context/s12/repro.sh`, which runs
`integrations.claude-shared-grant.cases.ts` against an isolated local DB.
- Before the fix, it failed with "sandbox env carries the shared refresh
  token" in all three scenarios.
- It also failed with "sandbox CLI (refreshed) revoked the device's access
  token" and "the device's refresh token was already spent" for the near-expiry
  and auth_error rows.
- After the fix, it passes 5/5 consecutive runs.

Archive searches (`refresh token rotated revoked other holders Not logged in`,
`forceOauthEnvelopeRefresh`) found no Claude case. This is related to the Codex
shared-grant memory (2026-10-19, devbox `~/.codex` revoked by a prod rotation),
not a recurrence.

## Solution

The fix is in `claudeCredentials.ts`:
- Sandbox credentials are access-token-only: `credentialMode: 'oauth_token'`,
  `CLAUDE_CODE_OAUTH_TOKEN`, and no `credentials` envelope. The refresh token
  never leaves the server.
- An access token with less than 5 minutes of life left, or a malformed
  `expiresAt`, is not served (an omitted `expiresAt` is served, as Claude Code
  does). Selection then falls through to the pool or the funded key.
- The EXPIRED auth_error "refreshable envelope" path and
  `forceOauthEnvelopeRefresh` were removed.
- The owning device refreshes its token and re-uploads it. The server never
  refreshes, matching the compute lease contract.

The tests that cemented the old behaviour were inverted:
- `integrations.compute-rotation-2.cases.ts`
- the claude-code blackbox expired-account case
- the Linux smoke resolvability check

The new regression lives in the integrations blackbox pooled-sequential
registry.

Golden reference: `claude-code-src/src/utils/auth.ts:1260` (the env OAuth token
is inference-only and never refreshed). Our fix converges on it by injecting
exactly that mode.

10k-agent behaviour: N concurrent sandboxes of one user share one access token
and perform zero refreshes, so there is no refresh race and no cross-revocation.
Selection is one indexed Integration lookup per session, unchanged. Mid-session
access-token expiry (8h TTL) ends in a 401 inside that one long-lived CLI
process instead of rotating the grant. That was already true for healthy
envelopes, which ran on the env token. Re-leasing and restarting the CLI with
`--resume` before expiry is a follow-up (CodeRabbit finding on PR #1590).

The Codex path has the same class: `CODEX_AUTH_JSON` carries `refresh_token`,
and the Codex CLI refreshes a stale `last_refresh`. Codex refresh keeps the old
token valid for a short horizon only. That fix is tracked as a follow-up.

## Human feedback

None recorded.

## Reusable lesson

Never hand a refresh token for a grant another holder shares to a sandbox; inject the access token only and let the grant's owning device refresh.
