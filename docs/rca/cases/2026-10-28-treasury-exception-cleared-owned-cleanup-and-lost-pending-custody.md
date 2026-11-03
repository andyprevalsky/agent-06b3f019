---
id: 2026-10-28-treasury-exception-cleared-owned-cleanup-and-lost-pending-custody
date: 2026-10-28
title: Post-close cleanup masked a treasury credential error and settlement exceptions bypassed pending custody
surface: back-end
component: treasury-rails-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the settle await throws before pending journaling and finally performs redundant list_cards despite a confirmed CLOSED card
symptoms:
  - "Invalid or expired organization token"
  - "list_cards rate limit exhausted"
  - "an interrupted settlement must retain the exact known closed-card transfer"
tags:
  - treasury-rails
  - agentcard
  - cleanup
  - pending-custody
  - exception-masking
sources:
  - commit 48ccad7bb3e56a889d9294e46f57448991d3145a
  - PR #1580
repro: node --import tsx back-end/src/tests/blackbox/treasury-rails-pending-mints.blackbox.ts
status: fixed
---

## Problem

The deploy's native treasury proof minted 1300 sandbox cents and confirmed the
unused card CLOSED. A subsequent settlement poll failed with an invalid
organization token. Unconditional finally cleanup queried the shared cardholder
again, exhausted three list_cards429 attempts and replaced the original error.
The known transfer was not in the deferred journal because recording followed
the await that threw. These are harness bugs; the provider authentication and
rate-limit origins remain open.

## Diagnosis

Original native artifact:
.context/test-runs/backend-coverage-failed-20261028-015455-2423332/treasury-rails.log.
The exact card card_d82856f596e59eef47e1fc3d had issuance amount1300,
transferred1300 and released0. Strict close succeeded at01:48:25.385 UTC.
list_recoveries failed with invalid token at01:50:16.914 UTC. Finally list_cards
failed429 three times afterward. Its last attempt still had22274ms of retry
budget; neither a larger retry cap nor new timing allowance is justified.
The original summary omitted transfer ID/created_at, so none was synthesized.

A later guarded read-only sandbox query found exact transfer
owt_d77721f7349cbe3c7490ed5a, created2026-10-28T01:48:22.426Z, still consumed
with1300transferred/0released. Canonical append-only accounting now retains its
real metadata. No new card or recover operation was used for reconciliation.

## Solution

Remove only strictly confirmed CLOSED cards from this test's cleanup set; an
empty owned set needs no provider query. Preserve cleanup for uncertain owned
cards and leave foreign cards untouched. Record an already observed exact
closed-card transfer before waiting for settlement. Validate debit bounds
before marking an observed full reclaimed/released amount resolved. Partial
returns, failed status, exceptions and invalid debit retain pending custody.

Registered native helper controls reproduce each boundary: removing the empty
cleanup guard exposes429 instead of the original error; moving the journal
write after the await leaves it empty; removing the debit check clears a
reclaimed1300/debit1301 result before the original caller can reject it.
Each identical native copied owning-test command fails with the mutation and
passes when restored. Timestamped argv, test/helper/log hashes and durations
are in .context/deploy-fresh-20261027/treasury-batch11-recovery2/native-control-receipts.json.
The actual registered tests and affected lint pass. Full native backend coverage
is a separate deploy gate, not inferred from these controls.

All preexisting financial assertions, sandbox guard, provider retry caps,
240000ms settlement wait and8000ms polling remain. No429skip, lost-funds waiver,
provider fix, financial recovery or production behavior change is claimed.
Known1300sandbox-cent return remains unverified and pending; separate earlier
1300-cent overdue entries and4396-cent payment warning remain historical.

## Human feedback

The user instructed the deploy owner to fix blockers and finish /deploy.
Preserve original failed runs and financial exposure; no new gate override or
provider-spend authorization is inferred. The snapshot-scoped Golden review
is recorded in the deploy packet and PR after its final verdict.

## Reusable lesson

Journal exact owned obligations before fallible observation and retire confirmed cleanup ownership before finally runs, validating all settlement invariants before clearing custody.
