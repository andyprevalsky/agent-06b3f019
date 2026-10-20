---
id: 2026-10-20-shared-provider-funding-exhausted-during-recovered-call
date: 2026-10-20
title: Shared API funding failed while an independent Foundry route completed the call
surface: agents
component: rose-shared-provider-funding
classification: unresolved
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Candidate unproven beyond observed provider state: shared OpenAI reports exhausted credits; Anthropic payment classification lacks raw response body
symptoms:
  - insufficient_quota
  - credit_balance_exhausted
  - RosePaymentRequiredError
  - shared Anthropic HTTP 400
tags:
  - provider-funding
  - billing
  - fallback
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

browser-auth-warning-triage.txt records request 71894f66 after distinct OAuth 401s.
worker.log:107-110 captures OpenAI SSE insufficient_quota/credit_balance_exhausted;
:113-114 records shared Anthropic HTTP 400 classified RosePaymentRequiredError.
backend.log:865/:873 record shared-key cooldowns through 02:42:11.292/.610Z.
Foundry then completed the same request; later local report-card evidence records
agent-payment-setup-resume passed in 274.8 s. No keys were funded, rotated or probed.

## Diagnosis

OpenAI credit exhaustion is directly observed provider state. The Anthropic exact
billing message and credential/account identity are absent, so only its recorded
payment classification is asserted. Overall classification remains unresolved because
no owning-boundary reproduction/fix proof was executed. Direct OAuth failure is a
separate case; billing failure must not excuse or reclassify a 401.

Literal insufficient_quota/credit_balance_exhausted and behavioral funded-route credit
searches found August 3 agentcard-direct-gpt-routes-exhausted, July 20 Anthropic zero
balance, and October 1/14/15 quota-versus-revocation cases. Their Solution/Human feedback
were read. Same symptom class, but current account/key identity and historical state
continuity are not established; this is a related observation, not a proven recurrence
or evidence any old repair failed.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

Additional observation: passing run `2023ea15-dba3-4455-bc3e-4d104d3e4d96`,
agent `fad65dad-5d2c-4202-b1e4-37a4dd96101e`, request `69243b82`, again
recorded OpenAI `insufficient_quota` / `credit_balance_exhausted` at
04:11:38 UTC. Shared Anthropic was classified `RosePaymentRequiredError`,
without a retained full error body. Foundry completed at 04:11:42.389987 UTC.
Key/account continuity and the Anthropic cause remain unrecorded. This is an
additional external funding observation, not a local reproduction, restored
balance, or effect of the receipt repair. The case remains OPEN.

## Solution

No repair. Retain original provider payload and account/key attribution, reconcile
funding through its owner, and only then obtain authorized owning-path proof. Do not
claim a funding-only skip, new fallback policy, restored capacity, or full gate success.
No paid verification or approval request is part of this archival task.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Record exhausted provider funding independently from OAuth rejection and successful service by another route.
