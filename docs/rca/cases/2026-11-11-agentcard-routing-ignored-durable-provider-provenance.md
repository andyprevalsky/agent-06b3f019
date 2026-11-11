---
id: 2026-11-11-agentcard-routing-ignored-durable-provider-provenance
date: 2026-11-11
title: AgentCard routing selected API and owner from current configuration or card prefix instead of durable purchase provenance
surface: back-end
component: agentcard-card-provider-routing
classification: our-bug
problem_class: other
first_bad_boundary: AgentCardRoutingProvider.mintCard selected v2 before consulting the persisted purchase funding intent; getDetails/closeCard and settlement inferred v2 from the card_ prefix
symptoms:
  - persisted legacy funding intent must replay legacy even after v2 enrollment
  - card_ is not REST provenance
  - known company-flow card without org binding must not fall back to user MCP for read or close
  - agentcard_funding_provider_unknown
  - agentcard_card_provider_unknown
tags:
  - agentcard
  - v2-migration
  - provider-provenance
  - legacy-cleanup
  - idempotency
  - financial-custody
sources:
  - PR #1864
  - PR #1891
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
  - plan:.context/agentcard-stability/review-cycle1-findings/back-end__src__providers__card-provider__agentcard-routing.ts-61.md
  - plan:.context/agentcard-stability/review1-backend-provenance/receipt.json
  - plan:.context/agentcard-stability/review1-backend-provenance/source-manifest.json
repro: back-end/src/tests/blackbox/agentcard-v2-provenance.cases.ts via agentcard-v2.blackbox.ts; back-end/src/tests/unit/agentcard-checkout-settlement-recovery.test.ts; private final candidate ce75acee2dfda14137ead86b12ccad72b0a85fad4317efdb7f76a91d38a58186
status: open
---

## Problem

Deploy review of source a5085083a51997a460a39fb8dd480ddacba70a52 identified
three related routing errors. A company-funded purchase with a persisted legacy
mint intent could replay through REST v2 after its Rose user completed v2
onboarding. Existing cards whose identifiers started with `card_` were read and
closed through REST even when durable funding metadata identified the legacy
org provider. The default checkout settlement last4 getter used the same prefix
assumption. These are confirmed owning mocked regressions, not a report of
production duplicate funding, an actual wrong-owner close, or a new native E2E
failure. No financial/provider operation was performed in this investigation.

The final private ce75 candidate is reviewed CODE_ONLY and remains unapplied at
this record's cutoff. It has no integrated, deployment, production, or native
repeatability credit. This case stays OPEN until parent integration and relevant
public-source verification; historical native passes do not cover the candidate.

## Diagnosis

The first bad decision is in `AgentCardRoutingProvider.mintCard`: any company
request with v2 dependencies resolves the user's current v2 connection before
consulting the persisted purchase/funding operation. That current enrollment is
not evidence of the API that owns an older idempotent mint. Separately,
`getDetails`, `closeCard`, and the default settlement identity getter treated
`card_` as v2 provenance, although the legacy provider can own such identifiers.
The deepest proven owned cause is the absence of one durable provider-selection
boundary shared by mint replay and existing-card operations. The demonstrable
siblings are legacy pending replay, card read, card close, and settlement last4.

`problem_class: other` names a missing taxonomy bucket: durable external-resource
identity/provenance validation. This is a product routing invariant, not a
harness contract, timeout, model choice, fixture corruption, missing capability,
or demonstrated concurrency/resource bottleneck. There is enough isolated
source proof to classify our-bug; no third-party behavior is needed to explain
the observed selections. Historical production exposure is unknown.

### Identical-test causal proof

The final routing test SHA256 is
`3254e8ac2e9b0c001ec1448a74183894e2d7c5ebc578cdd120dc7aff66ec3bb1`.
Against the original router, it failed the legacy-replay assertion with exit1
in0.466s. Against ce75, the identical bytes passed with exit0 in1.068s. The test
uses injected provider spies and rejects real fetch/socket connections; its
child executes the real prepare/repository/provenance functions with an owned
purchase/funding fixture and mocked database/store module boundaries.

The final checkout recovery test SHA256 is
`1dc65140034b4d4589cf96a5471e92df2c1e88c56bcf24466084ad0d5dce2c1b`.
The original getter failed with exit1 in0.767s; the same test passed on ce75
with exit0 in0.867s. It exercises the actual default getter and intercepted REST
client, preserves exact purchase/amount/last4 capture binding, and verifies that
legacy identity avoids REST while unknown identity selects neither provider.

Parent financial review found a further flaw in the private 3e97 draft:
`funding_model: company_flow` selected legacy but a missing current org binding
then let read/close fall through to User MCP. The same final routing test was
run against that draft with both read and close attempted: exit1 in1.12s,
with the explicit missing-org refusal assertion. The final ce75 legacy owner
guard requires an available org binding and compares the recorded cardholder
when present. The identical test now refuses both operations before any provider
read/close. A separate legacy-only unmarked user-card control still reads/closes
through User MCP exactly once. The 3e97 patch remains preserved unchanged; it
was not integrated. This is a caught private candidate defect, not evidence of
an additional deployed incident.

### Archive search and related causes

Searches covered `FUNDING_PENDING original provider legacy v2 routing`,
`closed unreleased consumed transfer pending reclaim retry`, and literal
`funding_model`, `AgentCardRoutingProvider`, `card_ prefix`, legacy replay,
provider provenance, and pending legacy terms. No same-cause case was found.
`2026-10-02-agentcard-abandonment-closed-card-transfer-never-released` concerns
provider release behavior; `2026-07-13-closed-card-treated-as-spent-clobbers-inflight-reclaim`
concerns a spent/reclaim state race. Neither is this API-selection defect.
`2026-11-10-payment-cleanup-trusted-local-terminal-flags-over-all-intent-evidence`
concerns independent all-PI custody observation, not mint/read/close routing.
Their diagnoses and human-feedback constraints were not adopted as causal proof.

## Solution

PRIVATE candidate only: exact patch SHA256
`ce75acee2dfda14137ead86b12ccad72b0a85fad4317efdb7f76a91d38a58186`.
Nine path hashes, physical modes, base source and validation commands are bound
by `source-manifest.json`, `checks.json`, and `receipt.json` in the existing
private evidence directory. Parent independently verified all nine source/mode
pairs and patch/apply-check, and accepted CODE_ONLY; source application is held
until the image publisher releases its snapshot. No source was applied by this
RCA worker.

The candidate persists a v2 API-rail marker when the existing repository first
creates a newly prepared company-funded intent, before its first provider
mutation. Existing upsert update remains empty and never overwrites an older
intent's metadata. A shared resolver validates exact Rose user, keyed purchase,
amount, immutable expected billing mode, owned funding row, currency, and card
identity before selecting positive v2 or legacy evidence. Explicit recorded
provider owners must match current bindings; malformed, conflicting, foreign,
or unknown provenance fails closed with typed409. A positive legacy org card
requires an available org binding, instead of falling into User MCP. The
separate legacy-only unknown-metadata user-card compatibility path is retained.
Mint replay, read, close, and checkout last4 use this boundary. V2 settlement
reads documented secretless card identity and keeps exact paid capture binding.

The regression is registered in the existing AgentCard v2 blackbox domain,
with owning unit/default-getter coverage. The full private domain passed in1.67s;
full private backend typecheck passed in25.113s; owning lint, format and patch
apply-check passed. Root's separately reviewed immutable-mode compensation
source was overlaid in the private combined validation view; it is not part of
ce75. Earlier private module-cache fixture isolation errors remain diagnostic
logs, not production failures or waived assertions. These are mocked/loopback
checks, not native provider or production proof. No new paid CI suite is added.

At10k agents the change adds bounded indexed purchase/funding provenance reads
at the existing mint/card operation boundary; there is no global scan,
background poller, new provider write, or retry loop. It makes no latency or
capacity claim beyond the measured private tests. Golden-reference gate: not
applicable (no approval-gated hunk); no prompt/schema/verifier policy changes.

### Migration and verification limits

Ambiguous old transferless/unmarked intents require authoritative manual
migration or reconciliation. They are not silently converted into a fresh v2
mint, and cardholder IDs are not aliased to v2 provider user IDs. Positive API
rail does not establish readiness of a new connection or permission to send OTP.
The marker pins API rail, not a complete historical organization OAuth-client
namespace; arbitrary historical credential rotation is not comprehensively
proven. Explicit recorded owners are checked, not rewritten. A missing binding
or conflicting owner stays blocked; this patch is not a migration provisioner.

Shared-source public owning tests, final combined deployment gates and any
required native verification are pending parent integration. No prior native
result is relabeled as proof on ce75. RCA archive schema/index validation is
also pending integration: this is an ignored canonical-format draft, not a
tracked case or a claim of archive-validator execution.

### Cleanup finding318-319 is not a safe relaxation

The related suggestion to treat pending issued-card evidence as reclaimable was
not adopted. Closed card + consumed/unreleased transfer + empty/lagging ledger
is ambiguous: it can be paid evidence not yet reflected in the ledger, or a known
release stall. It is not positive proof of unused/recoverable money. No causal
owning source defect was proved for changing that branch, and neither
`purchaseCleanup.ts` nor `purchaseIssuedEvidence.ts` is changed by ce75.

Companion test-only delta SHA256
`db14ac3624b482e839527e08cb113f0d7292f2a545a5ebf9372686de2a18df1e`
applies after root compensation patch951, not over the original test file.
Combined27 existing/extended cases passed. Its `retry-empty` case preserves
FUNDING_RECLAIM_FAILED/RECLAIM_FAILED and asserts zero close/reclaim/refund/mint
mutations; `retry-released` supplies exact reclaimed/full-release proof and
finishes through the existing allowed path. Those are safety controls supporting
the refusal, not cleanup-source fail-before/pass-after or new financial evidence.
No stalled card/transfer was touched and no recovery call was sent.

## Human feedback

Standing user scope requires preserving legacy cleanup and distinct v2 user
identity, keeping secrets server-side, and forbids live financial/provider
operations in this worker's repair. No new human product-policy feedback was
recorded for this code-only change. Parent coordination, separately from human
feedback, required the missing-org read/close negative, preservation of strict
ambiguity/manual reconciliation, no automatic remint/OTP, and private-only
application under the source/image freeze. Those review findings are recorded
above without treating them as new user approval or deployment authority.

## Reusable lesson

Select an external operation's API and owner from its exact durable purchase provenance, and refuse ambiguous or missing ownership instead of inferring identity from current enrollment or identifier shape.

## Shared-source validation

Applied in commit08e06669220cd78b2dc25872a92c0e8de80b160e. The actual shared full v2 domain, default last4 unit, all27 issued-ledger cases and full backend TypeScript check pass. Receipt: `.context/agentcard-stability/review1-backend-public-20261111T044004Z-0e363f7c/receipt.json` SHA25627a97d494d8e07ed1ce2555d7c7b6349d60c6ee63634c5a63dbc60b87d4d395f. All2581 backend source/config members retain exact hashes, sizes and physical modes. Ten denied socket attempts remain explicitly recorded; their IPC interpretation is limited to source/pattern evidence, not original callsite capture. No external provider or financial send was admitted.

The case remains OPEN for the remaining deployment/native verification and final evidence-preservation scope. Original failing/private artifacts are retained; no skipped or unexecuted test is converted to PASS.
