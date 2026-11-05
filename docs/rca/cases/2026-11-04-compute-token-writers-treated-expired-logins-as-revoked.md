---
id: 2026-11-04-compute-token-writers-treated-expired-logins-as-revoked
date: 2026-11-04
title: Compute-token writers disabled code-agent logins whose access token had merely expired or been re-synced
surface: back-end
component: compute-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/computeCredentials.ts retireExpiredClaudeIntegration (lease) and back-end/src/domains/integrations/service.ts markTokenRateLimited / markGptTokenRateLimited (worker auth report) — disabled a login without comparing the rejection with the stored credential
symptoms:
  - "Skipping Claude credential past its own expiresAt"
  - "User token for <userId> disabled after auth_error"
  - claude_code integration EXPIRED isActive false failureReason auth_error while the device login is healthy
  - every code-agent session falls back to the paid Anthropic API key
  - "Login rejection report not applied: expired"
tags:
  - claude-code
  - codex
  - oauth
  - token-expiry
  - compute-token
  - subscriptions
sources:
  - task T7 delegated RCA 2026-11-04 (branch fix/compute-token-login-disable-writers)
  - commit 9d4b0ea24
  - task T7 prod read-only audit 2026-11-04 (Integration rows; ClickHouse fly_logs)
repro: back-end/src/tests/blackbox/integrations.login-disable-writers.cases.ts (expired/replaced report; lease skips expired Claude login; other login kind); back-end/src/tests/blackbox/compute-grant-readpath.blackbox.ts
status: fixed
---

## Problem

Prod (read-only, 2026-11-04): Andy's `claude_code` row `7e916787` went
EXPIRED/auth_error at 2026-11-03 02:07:01Z with the log
`Skipping Claude credential past its own expiresAt`: the compute-token lease
found the stored access token past its own `expiresAt` and retired the row as
needs-reconnect. An expired access token is not a revoked login; the mac app
refreshes on the device and re-uploads. The worker's auth report route had the
same rule gap: a report naming a login disabled it even when the stored token
was expired, or was a newer token than the one the worker held.

Prod totals (claude_code/gpt_code, all users): 3 claude_code rows and 3 gpt_code
rows EXPIRED/auth_error, all Andy's (1 user; his only live login is 1 gpt_code
row). By last write: gpt 2026-10-16 20:xx (1, writer unknown, logs aged out),
gpt 2026-10-29 03:xx (2, unscoped route report), claude 2026-10-31 00:xx (2
still stamped; that write was `updated: 3` and its third row was rewritten on
11-03), claude 2026-11-03 02:xx (1, this lease retirement). Decrypted expiry
(read-only, no token printed): claude `074bfdd5` and `88a02cdc` hold tokens
valid until 2027-10, gpt `6a703dd4` until 2026-11-07, so those three are
healthy logins disabled by our writes; `86ae2dc2`, `de79f8a2` and `7e916787`
hold expired tokens and need a device re-sync either way.

## Diagnosis

`classifyLoginRejection` (codeLoginRejection.ts, T2 case
`2026-11-04-sandbox-login-rejection-marked-revoked-without-stored-credential-check`)
defines the rule: replaced (stored ≠ held), expired (stored past expiry),
otherwise revoked; only revoked disables. Two compute-token writers bypassed it:
the lease's `retireExpiredClaudeIntegration` (a decision recorded in
`2026-10-20-compute-lease-served-claude-envelope-past-own-expiry`, reversed
here because it is "expired treated as revoked"), and the
`compute-code/token/rate-limited` route, which never read the stored
credential. The worker reports also carried no held-token identity.

Repro (pre-fix, observed failing):
`bash back-end/scripts/run-blackbox-tests.sh integrations` →
`FAIL login writers -- an expired or re-synced login is not disabled (T7) -- claude_code: an expired login must not be disabled: {"status":"EXPIRED","isActive":false,"failureReason":"auth_error"}` and
`FAIL login writers -- the lease skips an expired Claude login without disabling (T7) -- {"status":"EXPIRED",...}`.
Identical command after the fix: `PASS integrations` (all four T7 cases).

## Solution

- `computeCredentials.ts`: deleted `retireExpiredClaudeIntegration`; an expired
  envelope is logged and skipped, like `claudeCredentials.ts` serving does, and
  its `lastUsedAt` is stamped so least-recently-used selection stops reaching
  it first on every lease.
  New `computeLoginFailure.ts` `classifyReportedLogin(type, integrationId,
  fingerprint)` reads the stored login (`storedClaudeLogin` /
  `storedCodexLogin`) and applies `classifyLoginRejection`; no integration id,
  or an id that is not that kind of login here (a guest's local id, a claude id
  reported as gpt), → `unverified`. `markComputeTokenUnavailable` moved there too.
- `integrations/service.ts`: an auth-failure report (user or pool) is applied
  only when `classifyReportedLogin` returns `revoked`; otherwise the reply is
  `{disabled:false, rejection}`. The route accepts a fingerprint-sized
  `credential`.
- `markComputeTokenUnavailable` (chat rotation) classifies with the
  fingerprint of the token it holds and names the leased integration.
- Workers send `credential` = sha256(held token)[:16] (`credential_fingerprint`).

Golden reference: `claude-code-src/src/utils/auth.ts:1373-1392`
(handleOAuth401ErrorImpl) compares the stored token with the failed one: a
different stored token is already recovered, the same one is refreshed, never
logged out. Codex `codex/codex-rs/login/src/auth/manager.rs:1850-1858` (cited by the
T2 case) reloads stored auth for the account before acting. The fix converges:
the stored credential decides, and only a still-current live token is revoked.

Trade-off: an expired login whose device never re-syncs stays CONNECTED but is
never served; availability (`hasLeasableIntegration`) already excludes it, so
plans do not promise it.

Open (self-healing): when the device refreshes, the provider revokes the old
access token before the device uploads the new one; a rejection in that window
still compares equal and live and is classified `revoked`. The next upload
resets the row to CONNECTED.

10k agents: no new hot-path work. An expired row costs one primary-key
`lastUsedAt` write each time selection reaches it, after which it sorts behind
every live row. An auth report costs two primary-key reads + one decrypt, only
on failure.

Update 2026-11-05 (CodeRabbit 4475152998): the workflow no longer reports a
token failure at all. RoseClient's provider cool-down and stall mark already
report every failed attempt with that attempt's own login and fingerprint; the
usage the workflow receives names only the last error, so after an in-call
rotation the workflow's cached lease was misattributed (lease A reported with
rotated lease B's auth_error). `AgentWorkflow._on_tokens` now only re-leases.
Regressions: workflow.blackbox `test_workflow_never_reports_its_cached_login_for_a_call_failure`
(failed on 99f748064 with lease A reported as auth_error) and rose.blackbox
`test_rotated_attempt_failures_are_reported_with_their_own_login`.

## Human feedback

Parent (for Andy, 2026-11-04): an expired access token is "expired", not
"needs reconnect/revoked"; restoring the disabled prod rows is a prod data write
and must be proposed, not done.

## Reusable lesson

Every writer that disables a credential must classify the rejection against the stored credential through the one shared rule; expiry and replacement never disable.
