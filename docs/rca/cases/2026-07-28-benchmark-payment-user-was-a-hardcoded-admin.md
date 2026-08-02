---
id: 2026-07-28-benchmark-payment-user-was-a-hardcoded-admin
date: 2026-07-28
title: Payment benchmarks ran as a hardcoded admin user, so the asserted personal Stripe hold could never happen
surface: harness
component: purchases-issue-card
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "resolveAndIssuePurchaseCard — isAdminUser(userId) routes to issueAdminCompanyCard, which creates no personal Stripe hold and no payment_approval"
symptoms:
  - payment benchmarks assert "stripeHold: succeeded" but no hold is ever created
  - card mint takes the company-funded admin path with no payment approval step
  - "removing the benchmark user from ADMIN_USER_IDS_EXTRA does not help"
tags:
  - benchmarks
  - agentcard
  - stripe
  - admin-bypass
  - fixture-identity
sources:
  - memory:project_agentcard_benchmark_identities
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

Every payment benchmark asserted `stripeHold: succeeded`, yet no personal Stripe
hold was ever produced. The default benchmark user was Andy
(`1f85ff25-6e29-4c1b-8739-f917bd101a30`), and
`resolveAndIssuePurchaseCard` (`back-end/src/domains/purchases/issueCard.ts`)
routes `isAdminUser(userId)` to `issueAdminCompanyCard` — company-funded, no
personal Stripe hold, no `payment_approval`. The assertion was therefore
unsatisfiable by construction, not flaky.

## Diagnosis

The benchmark's identity, not the payment code, was wrong. Andy is a HARDCODED
entry in `ADMIN_USER_IDS`; `ADMIN_USER_IDS_EXTRA` only ADDS admins and cannot
remove a hardcoded one, so there was no configuration knob that could put the
default benchmark user on the non-admin path. The deeper cause is that a
production authorization shortcut (admin company card) silently changed the code
path a capability benchmark was written to exercise, and nothing pinned the
benchmark's user identity to the path it asserts.

## Solution

Dedicated non-admin benchmark identities, separate per environment because one
user holds exactly one `Subscription` (one `stripeCustomerId`) and one agentcard
`Integration` (one cardholderId), and prod needs LIVE-mode where sandbox needs
TEST-mode:

- sandbox `BENCHMARK_PAYMENT_LIFECYCLE_USER_ID = 00000000-0000-4000-8000-000000000106`
- prod `BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID = 00000000-0000-4000-8000-000000000107`

Both live in `back-end/src/domains/purchases/config.ts`, are mirrored in
`agents/benchmarks/run_benchmark.py`, and are pinned against drift by
`agents/tests/blackbox/benchmark.blackbox.py`. Provisioning is scripted
(`back-end/scripts/setup-benchmark-payment.ts --live`, run against `DIRECT_URL`
because the 6543 pooler reports `Can't reach database server`). One residual
manual step remains: saving a card on the live Stripe customer
(`cus_UyFG1IK2lLzyme`) — without it the non-admin mint 402s with
`User does not have a Stripe billing customer`.

## Human feedback

The human's standing instruction is to never ask for these credentials again:
every value needed to provision or repair these identities is already in
`back-end/.env` or on Render and must be read, not requested. Entering a card
number into a payment field remains a hard prohibition for the agent, so that
one step is explicitly delegated to a human.

## Reusable lesson

When a benchmark asserts an outcome that a privileged code path skips, fix the
test identity — an admin/bypass user makes the assertion unsatisfiable by
construction, and pin the identity so it cannot drift back.
