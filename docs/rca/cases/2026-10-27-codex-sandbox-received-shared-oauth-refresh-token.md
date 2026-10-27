---
id: 2026-10-27-codex-sandbox-received-shared-oauth-refresh-token
date: 2026-10-27
title: Codex sandboxes received and could rotate users' shared ChatGPT OAuth refresh tokens
surface: back-end
component: gpt-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/gptCredentials.ts fetchGptCodeCredentialsWithMeta returned the decrypted gpt_code auth.json (tokens.refresh_token) verbatim as CODEX_AUTH_JSON for E2B and local-device Codex CLIs
symptoms:
  - refresh_token_reused
  - refresh_token_invalidated
  - "Your access token could not be refreshed because your refresh token was already used"
  - Codex CLI on the user's Mac or devbox signed out after a Rose Codex code agent ran
  - concurrent Codex sandboxes of one user rotate each other's grant
tags:
  - codex
  - oauth
  - refresh-token
  - e2b
  - credentials
  - scale-100-seats
sources:
  - task User Scale Bug Bash lane S14 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1590 (S12 follow-up 2)
  - memory:devbox-codex-oauth-revoked-use-prod-credential
repro: back-end/src/tests/blackbox/integrations.codex-shared-grant.cases.ts
status: fixed
---

## Problem

`fetchGptCodeCredentialsWithMeta` decrypted the user's (or pool owner's)
`gpt_code` Integration and handed the complete `~/.codex/auth.json` to every
Codex CLI consumer as `CODEX_AUTH_JSON`:
- E2B Codex code sessions (`e2b.ts`);
- `inspect` sandboxes (`codeSessions/inspect.ts`);
- local-device Codex runs (`localDevices/session.ts`).

That envelope includes `tokens.refresh_token`. The Integration is a copy of the
grant the user's own Codex CLI still holds (Mac upload, devbox sync). The Codex
CLI refreshes when the access-token JWT is within 5 minutes of `exp`, when a JWT
without `exp` has a `last_refresh` older than 8 days, or after a 401
(`codex/codex-rs/login/src/auth/manager.rs` should_refresh_proactively,
UnauthorizedRecovery). OpenAI rotates the refresh token on each refresh. The
holder that did not refresh later fails with `refresh_token_reused` or
`refresh_token_invalidated` and is signed out. The sandbox never persists the
rotated token, so prod's stored copy goes stale too.

The 2026-10-19 incident is this class: prod's copy of Andy's grant was rotated
at 07:53, and the devbox `~/.codex` that shared its refresh token then failed the
Codex E2B smoke with `refresh_token_invalidated`.

S12 (PR #1590) fixed the same defect for Claude Code. This is its Codex
follow-up #2.

## Diagnosis

1. The S12 golden contract: sandboxes get an access token only, and the grant's
   owning device refreshes it. `computeCredentials.ts` already served Codex
   access tokens without the refresh lineage. Its comment noted that the Codex
   CLI sandbox reader "remains strict" and passes the complete auth.json.
   The two consumers of one credential were inconsistent.
2. `parseGptCodeEnvelope` also rejected access-only envelopes (empty
   `refresh_token`), so the sandbox path depended on the refresh token's
   presence.
3. Local repro: `.context/s14/repro.sh` runs
   `integrations.codex-shared-grant.cases.ts` against an isolated local DB
   (`victoria_s14`). It uses the existing `FakeIdp('codex')` and a Codex CLI
   model of the rules above. On the buggy revision it failed with:
   - "sandbox env carries the shared refresh token", in all three scenarios
     (healthy, near-expiry, opaque token with stale `last_refresh`);
   - "near-expiry access token: expected served=false";
   - "sandbox CLI (refreshed) spent the device's refresh token", for the
     near-expiry and stale scenarios;
   - "no sandbox gets a refresh token", for 8 concurrent sessions.

## Solution

The fix is in `gptCredentials.ts`, via `toSandboxCodexAuthJson`:
- `CODEX_AUTH_JSON` keeps `auth_mode`, `id_token`, `access_token` and
  `account_id`. `tokens.refresh_token` is blanked, so the refresh token never
  leaves the server.
- `last_refresh` is stamped at serve time. It drives Codex's schedule only for
  a token without a JWT `exp`, and the stamp stops the CLI attempting a refresh
  that cannot succeed. Such a refresh would otherwise surface as
  `oauth_refresh_invalid` and disable the row (see
  2026-10-14-codex-permanent-revocation-feedback-treated-as-exhaustion).
- An access token inside Codex's 5-minute refresh window, or with a malformed
  `exp`, is not served. Selection falls through to the pool, then the funded
  `OPENAI_API_KEY`.
- Access-only envelopes are now accepted.

The stored Integration is unchanged. The owning device refreshes and
re-uploads; neither the server nor a sandbox ever refreshes.

The `compute-grant-readpath` test that asserted the sandbox received the refresh
lineage was inverted.

10k-agent behaviour: N concurrent sandboxes of one user share one access token
and perform zero refreshes, so there is no rotation race. Selection is
unchanged: one indexed Integration lookup and one JSON rewrite per session.
Codex access tokens last 10 days. A session still running when its token
expires ends in a 401 inside that one CLI. The ws-server then falls back to the
funded key when one is configured, instead of rotating the user's grant.

## Human feedback

None recorded.

## Reusable lesson

Every consumer of a shared OAuth grant other than its owning device gets the access token only; audit each provider path (Claude, Codex, local devices) when the contract is fixed for one.
