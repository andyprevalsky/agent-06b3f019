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
at the existing OAuth-to-funded fallback marker. Supplied structured feedback is authoritative, including an empty list; legacy terminal parsing applies only when the field is omitted.
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

The initial twelve-case regression, before the review refinements below, observed: exit 1, 10 failures and two passing quota controls. Plain, structured,
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


### Structured metadata remains authoritative

The current worker always supplies its structured event list, and the original
main implementation treated an explicit empty list as no observed failures.
Retaining that contract prevents an ordinary agent message beginning
`[Codex] Error:` from overriding the actual event metadata. Only callers that
omit the field use the bounded legacy terminal reader. No producer or agent
runtime changes were needed.

The permanent suite now has 16 modes across both credential sources (32 cases).
Before restoring this boundary it had 28 passes and four failures: explicit
empty feedback and diagnostic-looking agent prose expired both selected user
and pooled credentials. The unchanged command then passed all 32 cases, with
all positive revocation, quota and ownership assertions retained. Proof is
`.context/deploy-review-structured-before.log` and
`.context/deploy-review-structured-after.log`. The complete historical raw
failure remains expiry plus funded cooldown, with credit-skip null.

## October 15 Cycle2: native diagnostic blocks and exhaustion attribution

PR1520 comments4278530049/4278530054 on27513d29f identified two remaining
compatibility-reader defects. Header-only filtering lost invalid_grant on native
error continuation lines. Raw OAuth quota/funded scans could cool healthy keys
from printed output, and a printed fallback marker could redirect attribution.
Archive searches were `fundedKeySegment command output multiline` and `codex
native diagnostics continuation quota`; these recur at this existing case's
legacy-feedback boundary. The producer repair is separately owned.

The service now extracts complete supported native diagnostic blocks first,
then changes OAuth/funded attribution only at an exact outside-command-block
fallback marker. Both cooldown and revocation consume those same blocks.
Native Error/Turn failed and timestamped codex_login::auth refresh diagnostics
retain JSON/indented/explicit-machine continuation lines. Command output and
unrelated records are excluded. Producer references remain ws-server.mjs
renderCodexJsonLine (Error/Turn failed framing, command output/end markers,
raw stderr append) and codex-rs/login/src/auth/manager.rs:1657 native tracing.

The parent corrected an intermediate policy mistake: the canonical compute
classifier deliberately gives payment/quota precedence over overlapping
revocation text in ONE provider error. Word windows or splitting a diagnostic
into separate classified lines violates that policy. Both were removed. Each
whole native block and each whole structured feedback reason is now classified
with the unchanged canonical function. A separate later revoked diagnostic may
still retire the selected account; one quota diagnostic mentioning revocation
remains connected with cooldown. The exact oauth_refresh_invalid sentinel is
preserved. Supplied structured feedback, including[], remains authoritative.
A canonical payment_required verdict also authorizes cooldown, fixing parity
for existing payment phrases such as out of credits that narrower regexes miss.
Existing explicit funding/usage dialects and reset timestamp parsing remain.
No marker palette, token-window bound or global classifier change is added.

The permanent real-service/Prisma owning suite preserves all original32 cases
and their exact-selected/unrelated-account assertions, extending to76 ordinary
finite user/pool cases. Two additional --historical cases replay the private
hash-checked real transcript against synthetic rows. Controls cover supported
multiline revocation vs unrelated logs/commands, printed funding/quota/fallback
markers, native funding, whole-block and structured quota precedence (machine
codes and natural-language phrases), distinct later revoked diagnostics,
payment parity, reset time and structured empty-list authority. Existing shared
funded cooldown isolation is retained. Cleanup records exact created session
UUIDs, including funded-only sessions without an Integration ID. Desired DB
mutations are not mocked. Raw representative fixtures use exact native producer
framing; healthy/cooldown/expiry and ownership assertions are not relaxed.

Exact final paired command, repository root:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria node --import tsx back-end/src/tests/blackbox/codex-code-revocation-feedback.blackbox.ts --historical
```

`.context/pr1520-cycle2-backend/block-before.log` and `.exit` record exit1,
58 passes/20 failures against the original reviewed service. `block-after.log`
and `.exit` record exit0,78/78 passes with the identical final test body.
Final test SHA256: 87d10c9af2aa6789f2cf0a004c2dde7b4ea1efb46eda5ca0b7513842b75842fc.
The earlier word-window policy and logs are superseded exploratory artifacts,
not the accepted final proof. `precedence-before/after` additionally prove that
the prior word-window version wrongly expired quota errors and the block reader
corrected them; `payment-parity-before/after` isolate canonical payment cooldown
parity. Those tests were executed unchanged for their respective pairs.

The complete original session6303ae33-d6ca-4b11-b3fe-a02fad90b1b0 transcript
remains privately retained mode0600:5805 characters/5807 bytes; SHA256
b3321937f08d255920ee5f86378548b7e1c9614e13ec66c2a459b9113368406e.
Both historical cases expire exactly the synthetic selected account and cool
the funded key; the existing credit-skip classifier still returns null. The
original session/integration is never mutated. No raw body, tokens or claims
are printed; no paid provider is contacted.

Compatibility remains bounded: unsupported unframed/unindented continuation
dialects require structured feedback, and malformed command blocks stay
excluded. Flattened text is not authenticated provenance; deliberately forged
end-markers or diagnostic-looking multiline prose cannot be made tamper-proof
here. Full TestLoop/deploy verification and final official review remain parent
owned. The service functions retain the80-line limit; scoped lint/type/format
receipts live beside the final proof. INDEX is untouched and no commit is made.

The user resumed deployment; the parent delegated backend ownership and then
explicitly required canonical quota-first semantics after inspecting the
classifier. The separately owned producer now preserves that same quota-first
policy. No prompt, schema, selection scope, environment or producer file was
changed by this backend repair.

## October 15 producer and worker feedback completion

The real Codex renderer's typed error path did not classify `invalid_grant`.
The owning `e2b-templates/codex-code/oauth-feedback.test.mjs` executes the actual
renderer, fallback block and worker feedback function with sandbox/process IO
replaced. The original producer emitted no fallback or feedback for a complete
multiline invalid-grant error; the fixed producer emits `oauth_refresh_invalid`
and the actual worker preserves it. Six test groups retain command/tool/prose
exclusions and the existing quota-first/first-event policy. The discovered
backend `codex-oauth-feedback.test.ts` wrapper runs this contract under normal
unit and coverage gates. Final receipts are
`.context/cycle2-producer-final-{before,proof,wrapper}.log`.

The preserved historical transcript also contains eleven funded native Error
or Turn-failed records with `no credits remaining`, and none of those records
matches the worker's previous quota vocabulary. The worker therefore omitted
that real funding failure from its authoritative feedback. The existing
`spawn-claude-code-agent` owning blackbox now checks all four backend-supported
funding phrases, flat/nested native errors, initial/funded sources, and exclusion
of command/tool/agent text, other providers and unrelated disk quota errors.
The exact canonical command was run before and after adding only the four
funding markers to `build_codex_credential_feedback`:

```bash
source agents/venv/bin/activate
python agents/scripts/run_blackbox_tests.py spawn-claude-code-agent
```

`.context/cycle2-worker-funding-before-gate.log` records exit1 and the new native
funding case failing (141 cases pass, one fails);
`.context/cycle2-worker-funding-after-gate.log` records exit0
and all142 cases passing. The negative controls pass both versions. Running the
domain file directly had reported the failure but exited zero; that exploratory
run is not the accepted gate evidence. The canonical runner correctly failed.
This worker change forwards observed native errors; it adds no synthetic LLM
context, changes no prompt and does not infer failures from printed text. It
requires the normal agent-runtime production rollout as well as backend deploy.

## Fresh development stabilization: canonical payment dialect parity

The first deploy attempt closed blocked/review-unstable after its third review;
its ledger is archived at `.context/deploy-review-cycle-attempt1.json`. No fourth
review was requested. The user still requested finishing deployment, and the
parent delegated development stabilization before any fresh deploy. Review
comment4278874829 against fcd9b9f63 exposed a real remaining mismatch:
`invalid_grant insufficient_quota` takes the native producer's quota fallback,
but the complete error reason delivered by the worker was classified revoked
by the canonical backend classifier because its payment vocabulary omitted
insufficient_quota. The earlier finite precedence controls used usage_limit_reached
and out-of-credits wording that was already recognized, missing this upstream
vocabulary mismatch. This is a classifier defect, not a reason to bypass
canonical payment-first ordering or change the producer/worker.

Archive searches were `invalid_grant insufficient_quota payment precedence`
and `provider quota dialect classifier expires credential`; the user explicitly
required this existing case be amended rather than creating a duplicate.
The finite source audit covers9 actual native quota spellings: usage limit,
usage_limit, usage_limit_reached, hit your usage limit, purchase more credits,
check your plan and billing, the full quota-exceeded/billing-plan sentence,
insufficient_quota and insufficient quota. Four additional dialects come from
the existing backend funding/exhaustion path (no credits remaining, add credits
to continue, credit_balance_exhausted, credit balance is too low); two existing
canonical dialects (out of credits, purchase credits) remain pinned too.

`.context/pr1520-quota-stabilization/audit-native.cjs` executes the actual pure
classifyOAuthFallbackReason function extracted from the unchanged ws-server
source; all9 producer dialects retain quota-first fallback. `native-audit.json`
records results. The actual build_codex_credential_feedback function was also
executed in isolation from its Python AST with typed error/fallback events;
`worker-audit.json` proves the insufficient_quota collision retains its complete
reason as source oauth. Matrix structured inputs exercise the same authoritative
feedback shape; this does not claim every dialect is emitted verbatim by every
worker version. No provider, sandbox, producer or worker mutation was involved.

Only canonical PAYMENT_MARKERS changes: extend purchase credits to permit more,
unify usage limit/reached spellings, and add the existing plan/billing,
insufficient_quota/insufficient quota and explicit backend funding dialects.
Payment still precedes revocation; success and429 still return first. No bare
quota matcher, resource-error classifier, prompt, schema, selection policy or
producer/worker change is added. The pure negative controls pin bare quota,
disk quota exceeded, rate quota exceeded and insufficient scope as nonpayment;
adding genuine invalid_grant to those generic errors still proves revocation.
Existing credit-balance, unknown-auth and bare invalid_grant behavior remains.

The registered compute-grant-failure suite now has76 tests. Sixty finite
collision controls combine15 dialects, both token orders and same-line/supported
indented multiline bodies; each pins statuses400/401/403 as payment,429 as
rate-limited and200 as success. Existing live-response fixtures remain labelled
separately from these synthetic combinations. A shared support file supplies
only test data, not production classification. It needs no independent runner.

The existing discovered codex-code-revocation-feedback suite adds240 real
persistOutput/Prisma cases: those60 bodies x legacy/structured x user/pool.
Every one asserts selected Integration remains CONNECTED/active with temporary
cooldown, selected connection connected/no auth error, no funded cooldown from
an OAuth-only quota event, and unrelated account/connection untouched. Four
additional native controls pin bare invalid_grant expiry and bare/disk/rate
quota remaining healthy. The existing78 cases (including the2 private full
historical replays) remain unchanged and pass;326 total cases pass with
--historical,324 self-contained cases run normally. Existing cooldown isolation
and exact-created-row cleanup are retained; no desired DB effect is mocked.

Exact unchanged pre/post commands, repository root:

```bash
node --import tsx back-end/src/tests/blackbox/compute-grant-failure.blackbox.ts
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria node --import tsx back-end/src/tests/blackbox/codex-code-revocation-feedback.blackbox.ts --historical
```

Evidence directory `.context/pr1520-quota-stabilization/` retains the original
classifier and final fixed copy plus immutable paired logs/exit receipts.
`classifier-before.log` records exit1,32/76 passed (44 collision failures);
`classifier-after.log` records exit0,76/76 passed. `db-before.log` records exit1,
150 passed/176 failed; `db-after.log` records exit0,326/326 passed. The final test
bodies were byte-for-byte identical across each pair; `result.json` records
all three test/support hashes. These commands used explicit local Victoria URLs,
never `.env` production DB. Complete historical transcript SHA256 remains
b3321937f08d255920ee5f86378548b7e1c9614e13ec66c2a459b9113368406e;
only synthetic task/account rows received it. Original session/credential rows
were not mutated and no private body/token/claim was printed.

Independent adversarial review found no actionable issue in marker scope,
precedence, discovery or ownership assertions. Static receipts live beside the
paired proof; the parent owns fullR7/TestLoop and any fresh deploy/review cycle.
No push, commit, provider request or official review was made here. This
stabilization does not reopen or extend the exhausted prior review ledger.

### Parent acceptance before full R7 gates

The parent reviewed and accepted the final production diff, unchanged paired
76/76 classifier and326/326 real-DB proofs, lint and typecheck. The separately
owned producer contract work is complete:7 groups/280 cases and42 controls,
with14-dialect mapping evidence at
`.context/attempt2-producer-dialect-proof.json`. That is producer-side evidence,
not an additional backend or live-provider run. No remaining finite dialect gap
was identified in the reviewed canonical fix. Source is handed back for parent
freeze and fullR7 gates; deployment completion is not claimed. No further tests
or production edits were made after acceptance, and Freedom remains untouched.
