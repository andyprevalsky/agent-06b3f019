---
id: 2026-11-04-code-credential-availability-counted-expired-logins
date: 2026-11-04
title: Code-agent credential availability counted connected logins whose stored token had expired, so plans promised a subscription that serving skipped for the paid key
surface: back-end
component: code-session-credential-plan
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/usageLimit.ts hasLeasableIntegration — counted CONNECTED, non-rate-limited rows without the expiry check serving applies
symptoms:
  - next_credential claude subscription but the session ran on the funded ANTHROPIC_API_KEY
  - claudeTokenSource anthropic although the user has a connected Claude login
  - "User Claude Code integration for <userId> has no usable OAuth token"
  - code agent used the paid key instead of the subscription
  - CodeAgentCredentialError instead of a structured no_credentials result
tags:
  - code-agent
  - credential-order
  - subscriptions-before-paid-keys
  - token-expiry
sources:
  - commit cff49e7725
  - memory:feedback-subscriptions-before-paid-keys
repro: back-end/src/tests/blackbox/code-session-credential-order.cases.ts ("a login whose stored access token expired is not a leasable subscription"), run by code-session-usage-limit.blackbox.ts
status: fixed
---

## Problem

`codeCredentialTiers` (the C15 plan, `next_credential`, the usage-limit
outlook) asked `hasLeasableIntegration`, which counted `CONNECTED`
non-rate-limited rows. Serving (`buildClaudeCodeCredentialResult`,
`toSandboxCodexAuthJson`) refuses a token that is expired or inside its
refresh window. A user whose only login had an expired token was therefore
told a subscription was next, and the spawn fell through to the funded key
(`e2b.ts` funded path) or raised a generic `CodeAgentCredentialError` instead
of the structured `no_credentials` pause. Serving's user path also read only
the first connected row (`findFirst`), so an expired first row hid a live
sibling account.

On base, with only `usageLimit.ts` reverted:
`bash scripts/run-blackbox-tests.sh code-session-usage-limit` →
`not ok 4 - a login whose stored access token expired is not a leasable
subscription (availability = serving)` / `an expired Claude token cannot be
served` / `true !== false`.

## Diagnosis

Two selectors answered "can this login be leased?" with different predicates.
The plan's count omitted the expiry rule that serving enforces, and serving's
user lookup stopped at the first row. Deepest owned cause: the expiry rule
lived only inside the serving builders.

## Solution

`hasExpiredClaudeCodeToken` (claudeCredentials.ts) and `hasExpiredCodexToken`
(gptCredentials.ts) expose the serving expiry rule (same minimum lifetime /
refresh window); `hasLeasableIntegration` excludes rows whose stored token is
provably expired. Rows that cannot be decrypted keep their previous
(counted) treatment, to stay within the reported failure and not change
fixtures that seed credential-less rows. Serving's Claude and Codex user paths
iterate every connected own login and take the first servable one.

10k agents: availability reads the user's own rows (a handful) and the pooled
rows, decrypting until the first non-expired one — the same work serving does
per spawn; no writes.

## Human feedback

None recorded.

## Reusable lesson

A plan that promises a credential must use the same eligibility rule as the code that serves it.
