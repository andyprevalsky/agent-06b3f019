---
id: 2026-11-04-sandbox-login-rejection-marked-revoked-without-stored-credential-check
date: 2026-11-04
title: A sandbox's rejected login was marked revoked without checking whether the stored credential had simply expired or been re-synced
surface: back-end
component: code-agent-credential-feedback
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/codex-code/credentialFeedback.ts markCodexOAuthFailure (revoked branch) — disabled the integration by id from the sandbox's report alone
symptoms:
  - "GPT user token for <userId> disabled after auth_error"
  - "oauth_refresh_invalid"
  - "Your access token could not be refreshed"
  - gpt_code integration EXPIRED auth_error after a long Codex run
  - freshly re-synced login disabled by an older sandbox
tags:
  - codex
  - claude-code
  - oauth
  - token-expiry
  - credential-race
  - code-agent
sources:
  - commit cff49e7725
repro: back-end/src/tests/blackbox/code-agent-login-rejection.blackbox.ts (codex expired / replaced cases, claude replaced case); e2b-templates/codex-code/app-server.test.mjs (fingerprint on login_unusable)
status: fixed
---

## Problem

Code-agent sandboxes receive a copy of one leased access token and no refresh
token (`gptCredentials.ts` `toSandboxCodexAuthJson` blanks it; Claude gets
`CLAUDE_CODE_OAUTH_TOKEN` only). When a Codex sandbox's access token expires
during a long run, Codex cannot refresh and reports `oauth_refresh_invalid`;
`credentialFeedback.ts` maps that to revoked and `markGptUserTokenRateLimited`
sets the user's login `EXPIRED`/inactive with needs-reconnect, although the
login is healthy on the user's device. Marking was by integration id only, so a
stale sandbox could also disable a credential the device had re-uploaded after
the lease.

`bash scripts/run-blackbox-tests.sh code-agent-login-rejection` on base:
`codex user: the held token expired ...: Expected 'CONNECTED', actual 'EXPIRED'`
and `codex user: the stored login was replaced after the lease: Expected
'CONNECTED', actual 'EXPIRED'`; the Claude replaced case failed with
`no cooldown` (the sandbox's `OAuth token revoked · Please run /login` banner
put the re-synced login on a 24 h cooldown).

Prod (read-only, 2026-11-04): Andy's gpt_code row `86ae2dc2` went EXPIRED
auth_error on 2026-10-16 20:01:59Z; Render logs for that second have aged out,
so its writer is not recorded in the source. The 2026-10-29 and 2026-10-31
disables came from `POST /api/integrations/compute-code/token/rate-limited`
(user-wide, `accountId: null, integrationId: null, updated: 3`), and the
2026-11-03 disable from `computeCredentials.ts` `retireExpiredClaudeIntegration`
(`Skipping Claude credential past its own expiresAt`). Those writers are the
compute-token lease path, not this code-agent path; see Diagnosis.

## Diagnosis

The sandbox knows only that its token was rejected. Whether that means
revoked depends on the stored credential now: still the same token and live
(revoked), the same token past its expiry (expired), or a different token
(replaced after the lease). The feedback carried no identity of the held token
and the marker never read the stored one, so every rejection was a revocation.
Deepest owned cause: the rejection contract lacked the held-credential
identity. Sibling failures prevented by the same fix: Claude expiry after the
text classifier was removed, and the re-sync race for both providers.

Not changed here (outside this cluster, recorded for the owner): the
compute-token route marks a user-wide disable when the caller names no
credential (open sibling of `2026-10-20-compute-lease-served-claude-envelope-past-own-expiry`),
and `retireExpiredClaudeIntegration` deliberately retires an expired Claude row
as needs-reconnect (that case's documented decision).

## Solution

Both ws-servers report `credential` = sha256(held access token)[:16] on a
rejected login (never the token). Agents forward it in `credential_feedback`.
`back-end/src/providers/codeLoginRejection.ts` `classifyLoginRejection`
compares it with the stored credential (`storedClaudeLogin` /
`storedCodexLogin`): fingerprint mismatch → `replaced`, stored token expired →
`expired`, otherwise `revoked`. Only `revoked` disables the login; a missing
stored credential stays `revoked` (unservable either way) and a feedback
without a fingerprint compares expiry only.

Golden reference: Claude Code `utils/auth.ts:1384-1388` treats a 401 whose
stored token differs from the failed one as already recovered; Codex
`manager.rs:1850-1862` reloads the stored auth for the same account before
refreshing.

10k agents: one indexed integration read and one decrypt per rejected login,
only on failure; no hot-path cost.

## Human feedback

None recorded.

## Reusable lesson

Before disabling a credential because a sandbox reported it rejected, compare the sandbox's held token with the stored one and treat expiry or replacement as not revoked.
