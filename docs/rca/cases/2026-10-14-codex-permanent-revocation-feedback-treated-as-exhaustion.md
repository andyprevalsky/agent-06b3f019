---
id: 2026-10-14-codex-permanent-revocation-feedback-treated-as-exhaustion
date: 2026-10-14
title: Codex output feedback left permanently revoked OAuth integrations selectable
surface: back-end
component: codex-code-credential-feedback
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: codex-code service detectAndMarkCodexExhaustion ignored permanent OAuth revocation in plain output and treated structured OAuth failure as temporary quota
symptoms:
  - "user/plain: captured permanent revocation must expire selected credential"
  - "token_revoked"
  - "refresh_token_invalidated"
  - "oauth_refresh_invalid"
  - "Selected revoked Codex integration remained CONNECTED and active after persisted output"
tags:
  - codex
  - credential-feedback
  - oauth-revocation
  - integration-connection-sync
sources:
  - task local ClaudeCodeSession 6303ae33-d6ca-4b11-b3fe-a02fad90b1b0
  - task .context/test-runs/backend-coverage-failed-20261014-232329-525786/runner.log
  - task .context/test-runs/backend-coverage-failed-20261014-232329-525786/server.log
  - task .context/codex-revocation-feedback-rca/original-safe-evidence.json
  - task .context/codex-revocation-feedback-rca/before.log
  - task .context/codex-revocation-feedback-rca/after.log
repro: back-end/src/tests/blackbox/codex-code-revocation-feedback.blackbox.ts
status: fixed
---

## Problem

The original Group 3 real sandbox smoke persisted output containing HTTP 401,
`token_revoked`, `refresh_token_invalidated`, and then funded-key exhaustion,
without its completion sentinel. Its exact session selected integration
`933aef3b-5183-4c86-a595-4a2076187496`; a read-only database query after closure
still found that integration CONNECTED/active, without failureReason or cooldown.
Safe evidence retains only metadata and whitelisted failure booleans, never
credentials or private claims. Original output length is 5805 characters/5807
UTF-8 bytes. The original revoked integration is not modified by this repair's
regression tests.

This is separate from the local-authority smoke fixture issue: the selected
old account was not the current local auth file's account. A successful smoke
using explicit current authority cannot establish revoked-account retirement.
The existing credit-skip classifier already correctly refuses to turn the mixed
failure into a funding skip. Neither fact repairs the output feedback defect.

## Diagnosis

Path: Codex terminal output/structured source feedback -> authenticated output
route -> persistOutput -> detectAndMarkCodexExhaustion -> selected Integration
health -> account connection -> future credential selection.

The plain-output path returned before loading the session unless a quota regex
matched. It did not recognize permanent revocation or the captured funded
`no credits remaining` wording. The structured path accepted an OAuth failure
reason but always passed it to temporary markGptIntegrationRateLimited. That
helper intentionally only sets a cooldown: it does not expire an integration
or synchronize needs_reconnect. A dead token could therefore remain CONNECTED
and later be selected again by the unchanged LRU policy.

The deepest owned gap is failure-kind loss at the Codex feedback boundary.
Selection and sync intentionally preserve other accounts; expiring all accounts
or changing LRU would be wrong. Canonical helpers already own permanent auth
failure: classifyComputeGrantFailure recognizes revocation, and
markGptUserTokenRateLimited with failureReason auth_error plus integrationId
expires only that selected integration and invokes account connection sync.
The repository lookup recovers the credential owner's account, including pool
credentials belonging to a user other than the session consumer.

Archive queries were `Codex CONNECTED revoked credential output feedback` and
`Codex permanent authentication failure quota cooldown connection needs
reconnect`. Process feedback and RCA methodology were read. The October 1
credit-skip case is a relative, not a recurrence: this failure is product
credential feedback, not test skip classification. The October 14 old-seeded-
account fixture case is separately owned and not edited here. The canonical
reference is gptCredentials.ts markGptUserTokenRateLimited and
integrationConnectionSync.ts markConnectionNeedsReconnectFromIntegrationFailure:
permanent failures expire the exact account, while rate limits do not request
re-consent. No new remint/fallback or classifier architecture is introduced.

## Solution

The Codex output service recognizes permanent OAuth failures through the
existing compute failure classifier, and recognizes the sandbox's existing
`oauth_refresh_invalid` structured reason. It routes those failures through
canonical scoped auth_error handling using the selected credential owner's
user/account and exact integration ID. Plain terminal segments remain separated
at the existing OAuth-to-funded fallback marker. Explicit empty structured
feedback falls back to retained output rather than hiding known revocation.
Within structured OAuth feedback, revocation takes precedence over an earlier
temporary quota reason. Real quota retains its existing temporary cooldown.
Funded quota retains shared-key cooldown, with the captured no-credits wording
included; a funded-key auth failure does not invalidate OAuth.

Permanent owning blackbox coverage is a new auto-discovered codex-code domain
file. It invokes the real persistOutput service, repository, canonical GPT auth
handler, and account sync against real local Postgres. It does not mock the
expected integration or connection updates or contact any provider/sandbox.
Only the existing funded-key singleton isolation helper substitutes its private
cooldown row so concurrent suites' global funding state is untouched.

Identical pre/post command, from repository root:

```bash
cd back-end && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria node --import tsx src/tests/blackbox/codex-code-revocation-feedback.blackbox.ts
```

Before: exit 1, 10 failures and two passing quota controls. Plain, structured,
initial and empty-feedback modes for both sources each reported captured
permanent revocation with actual CONNECTED versus expected EXPIRED. Both
funded-only negative controls also detected an unwarranted quota cooldown.
After: exit 0, all 12
finite user/pool cases pass. Each source covers raw output, structured revocation,
initial-source revocation, empty feedback with retained raw errors, temporary
quota, and funded-only auth failure. Tests assert exact-account expiration,
inactivity, auth_error, no temporary cooldown for revocation, needs_reconnect,
untouched unrelated account and connection, separate funded cooldown, and
unchanged revoked-OAuth hard-failure classification. Quota and funded-only
negative controls assert no unauthorized permanent invalidation.

The blackbox runner auto-discovers every *.blackbox.ts file; this file remains
registered without a new runner exemption. Scoped lint, formatting and tsc
were run. Parent owns the full deploy gates and INDEX regeneration. The case is
fixed for the local causal boundary only: no claim is made that this change has
been deployed or that the full deployment gate has passed. No new live smoke
was run; the parent's already completed current-authority smoke is separate.

Adversarial review: the regression checks stored state through real database
reads, not helper-call mocks. Source attribution prevents a funded error from
expiring OAuth; exact integration/account scope prevents another connected
account being retired. Existing pool and user selection both filter CONNECTED,
so EXPIRED removes the dead credential without changing selection policy.
The tests leave the captured historical integration untouched and retain
before/after failure evidence under .context. Provider revocation itself is
external; failing to retire it after observation is the owned bug fixed here.

## Human feedback

The user authorized deployment and fixing encountered real defects. The parent
agent delegated this repair with the constraints to preserve canonical auth
scope, LRU selection, temporary quota behavior, and hard failure for revoked
OAuth; avoid prompt/LLM/Zod changes and additional live provider requests; and
leave commits, deployment, the current-authority fixture case, and INDEX to the
parent. Those delegation constraints are not additional direct user requests.
The parent reviewed the 12-case causal proof and accepted the auto-discovered
blackbox domain as permanent regression registration.

## Reusable lesson

Preserve permanent-versus-temporary failure kind and selected credential identity when feeding sandbox authentication errors back into integration and account connection health.


## October 15 PR1520 cycle1: raw terminal revocation needs source attribution

The owning regression now proves this correction against the actual service and local database. The complete deployment gates remain separate.
Official comment 4277658886 identified that `isRevoked` classified every terminal
line as an attributed 401 body. Plain invalid_grant, Google OAuth failures and
application HTTP401 token_revoked therefore expired the selected ChatGPT grant.
The first bad boundary is the raw terminal compatibility reader, not structured
credential feedback or the canonical exact-selected expiry/sync handler.

The isolated proof executes the actual current/draft decision function, real
classifier and fake persistence boundaries. `node
.context/pr1520-cycle1-draft/proof.cjs` records current false expiry and proposed
healthy/cooldown outcomes without DB writes. The complete historical session
6303ae33-d6ca-4b11-b3fe-a02fad90b1b0 was SELECTed from explicit local Victoria in a
READ ONLY transaction and retained privately mode0600. Its 5805 characters/5807
bytes hash to b3321937f08d255920ee5f86378548b7e1c9614e13ec66c2a459b9113368406e.
`node .context/pr1520-cycle1-draft/historical-proof.cjs` passes: exact-selected
expiry plus funded cooldown; existing credit skip remains null. No private
output is printed and no live integration is mutated by this proof.

The implementation recognizes native [Codex] Error:/Turn failed: diagnostics outside
command-output blocks, exact whole-output oauth_refresh_invalid, and anchored
Codex login auth ERROR refresh diagnostics (required by the historical output).
Producer references: ws-server.mjs renderCodexJsonLine lines164/176,229/230 and
stderr append line566; native tracing analog is
codex/codex-rs/login/src/auth/manager.rs:1657. It carries oauthRevoked explicitly
rather than reclassifying full raw quota text downstream. Structured source
feedback remains unchanged; revocation retains precedence over quota. Arbitrary
unframed legacy prose no longer authorizes permanent retirement. Flat terminal
text cannot cryptographically defeat intentionally forged boundary/prose text;
no such stronger guarantee is claimed.

The permanent cases extend the existing discovered codex-code feedback
suite, with 15 finite modes across user/pool, real service+DB behavior and all
existing selected-owner, unrelated-account and cleanup assertions intact. The
original representative raw fixture gains native producer framing, preserving
its exact expiry assertions rather than pretending arbitrary 401 prose has
source authority. Structured precedence both orders, bare sentinel, native
Turn failed, Google/application/command/prose negatives and quota+unrelated auth
are retained. The same permanent regression command produced 18 passes / 12 failures before the implementation, then 30 passes / zero failures afterward. Logs are `.context/deploy-review-auth-before.log` and `deploy-review-auth-after.log`. The database assertions verify exact-account state, connection synchronization, unrelated accounts, cooldowns and cleanup. The isolated VM proof remains separately scoped; no full deployment success is claimed here.

Human feedback: the parent required immutable source during Group4, explicit
quota-plus-unrelated-auth negative coverage, full historical-output proof and
producer attribution rather than generic auth-word matching. Deployment was
user-authorized; these are delegated repair constraints. Comment4277658891's
claim that a physically missing row remains active is invalid; warning optional,
no credential fallback is warranted.
