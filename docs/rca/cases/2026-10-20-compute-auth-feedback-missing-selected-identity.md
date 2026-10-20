---
id: 2026-10-20-compute-auth-feedback-missing-selected-identity
date: 2026-10-20
title: Auth feedback omitted selected account identity before multi-row invalidation
surface: cross
component: compute-credential-feedback
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Candidate unproven: mark_compute_token_rate_limited_activity sends user-source feedback without selected account or integration identity
symptoms:
  - GPT auth_error invalidation updated=2 accountId=null integrationId=null
  - Claude auth_error invalidation updated=3 accountId=null integrationId=null
  - Marked compute token rate-limited during auth invalidation
tags:
  - compute-auth
  - credential-scope
  - account-identity
  - open-triage
sources:
  - PR #1552
  - commit 64e5cc2dd83dfc346797b97e7c0f5fd749713250
  - agent 915ab997-c174-4297-80ac-15347120342f
  - benchmark run 6a650338-5a33-41fa-9e7d-32530efe8315
  - agent f46a9439-f0f6-4796-935a-3618eecfc651
  - task agent-payment-setup-resume
repro: none-recorded
status: open
---

## Problem

The complete browser-auth-warning-triage records backend.log:813 GPT updated=2,
:839 Claude updated=3, with null accountId/integrationId; repeat GPT feedback at
:912 updated=0. Source artifacts are in browser-deploy/.context/benchmarks/
1792462235-437737-75262/. The triggering request 71894f66 recovered via Foundry,
and the affected task later locally passed in 274.8 s. That does not verify the
validity or intended treatment of every integration row touched.

## Diagnosis

helpers/llm.py:7120-7145 accepts provider/source/user plus optional pool-token ID,
but no selected user account/integration identity. gptCredentials.ts:371-385 and
claudeCredentials.ts:515-529 add those filters only if present. Thus multiple rows
can match the observed feedback. Auth invalidation sets EXPIRED/isActive=false,
not an ordinary temporary rate limit; generic worker wording hides that distinction.
Sibling validity and intended selected identity are unproven; do not claim known-good
credentials were disabled. No local multiple-account failing/passing regression exists.

The auth family's literal/behavior searches and matching Solution/Human feedback were
read. October 14 codex-permanent-revocation-feedback-treated-as-exhaustion is a close
relative but fixes Codex persistOutput's exact-identity path; this is Python runtime
feedback. No evidence proves recurrence of that repaired path.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

## Solution

No changes. Proposed proof: use the existing compute-credentials boundary with two
accounts, feed one selected token's rejection, and check exactly which stored rows
change. Preserve canonical failure classification and unrelated-account state.
Do not propagate guessed identities or create a new auth policy from this observation.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Carry verified selected credential identity through failure feedback before treating a multi-row invalidation as correctly scoped.
