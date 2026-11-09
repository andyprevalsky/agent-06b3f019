---
id: 2026-11-09-committed-retirement-rechecked-current-gate-inventory
date: 2026-11-09
title: Committed native debt retirement was reinterpreted against a refreshed catalog
surface: harness
component: scripts/deploy_test_round49_retirement.py
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: recognized passed the refreshed current gate to the historical witness validator after certificate issuance
symptoms:
  - 'round49 retirement: same logical root and exact footprint'
  - full independent dispatch refused before native requests were written
tags:
  - deploy
  - source-refresh
  - cleanup
  - custody
sources:
  - commit 8914dd02e1f424c0345ce70752d791f8426070a6
repro: python3 scripts/tests/deploy-test-cycle.test.py Round49RetirementCertificates
status: fixed
---

## Problem

After preserving main and refreshing the normal 17-gate plan, quick validation
passed all four gates. The next normal independent dispatch refused before
launching native work with `round49 retirement: same logical root and exact
footprint`. Six old launch-debt retirements were already committed. The backend
catalog now included three additional required domains, and selection metadata
had changed; the original retirement witnesses and worker identities had not.

## Diagnosis

`recognized()` passed today's gate to `validate()`, whose witness check requires
exact equality with the sealed historical gate. That predicate is appropriate
when issuing a certificate from a genuine later execution. Reapplying it to
recognize an already committed retirement made an immutable old-debt fact depend
on a future test catalog. The deterministic owning test reproduced the failure
after valid issuance and then only a current-selection or inventory refresh.

This is an introduced coupling in the retirement implementation. No baseline
execution or old PASS was borrowed. The original six missing outer receipts,
UNKNOWN execution flags, old journal, all 64 artifact seals and original failed
results remain unchanged. Searches for round49 retirement, certificate/catalog
binding and completed-source refresh found no same first-bad boundary. The
November 3 refresh lifecycle case describes a different phase-transition refusal.

## Solution

Recognition first authenticates the existing committed certificate and historical
journal, then obtains the sealed original gate. Current worker root, cwd and
transports must still match. The unchanged certificate validator authenticates
that original gate, genuine later native receipt, producer bytes, anchors, root
and admission-lock incarnation, and fresh quiet observation under one lock.
Issuance and reconciliation remain strict against the current gate; a changed
catalog without an existing certificate cannot issue or recognize retirement.

Five added owning methods fail against the original and pass unchanged with the
recognition correction. The complete 28-method certificate class passes. Negative
controls reject missing certificates, foreign roots/transports, malformed native
proof and producer drift. All six retired old debts plus a newer backend cleanup
failure still block; retirement never grants a reusable full PASS. Full canonical
coordinator and final-source gates are recorded separately in the deploy evidence.

## Human feedback

No new human feedback. Independent agent review cleared only the exact correction.

## Reusable lesson

Authenticate a committed retirement against its immutable issuance witness.
Validate today's execution independently, and keep every newer owner obligation
active. A historical cleanup fact must not become current test credit.
