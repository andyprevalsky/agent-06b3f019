---
id: 2026-10-06-treasury-rails-reclaim-proof-shared-payment-cardholder
date: 2026-10-06
title: treasury-rails reclaim proof minted on the shared payment-benchmark cardholder
surface: back-end
component: treasury-rails-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/treasury-rails.blackbox.ts cardholder selection picked the first idle cardholder, which was the one every payment benchmark mints on
symptoms:
  - an unused card must reclaim/release, not stay consumed
  - unused mint never reclaimed after 27 attempts
  - Recovered cardholder residual into the org wallet
tags:
  - treasury-rails
  - agentcard
  - sandbox
  - shared-fixture
  - deploy-gate
sources:
  - PR #1416
  - commit db6426820 (Step 4a backend coverage failure, 2026-10-06 04:46 UTC)
repro: back-end/src/tests/blackbox/treasury-rails-cardholder.blackbox.ts
status: fixed
---

## Problem

`/deploy` Step 4a backend coverage failed on `treasury-rails`. The test minted
an unused $13.00 `company_flow` card, closed it, and polled for 240 seconds.
Its own transfer stayed `consumed` with `released_cents=0`, so the
reclaim/release assertion failed. During the wait, the test's own
`recover_funds` sweep recovered $37.21 from the same cardholder. This test
never minted that amount.

## Diagnosis

The sandbox org has two cardholders. Payment benchmarks in every workspace
resolve the KYC-verified one through `resolveBenchmarkCardholderId`. The
treasury test took the first cardholder with no OPEN card, which was that
same verified holder. $37.21 is $43.96 minus `test_charge`'s simulated $6.75,
so it was the residual from another workspace's payment lifecycle card.
Cardholder headroom is fungible. A foreign mint or `recover_funds` on the
same cardholder can absorb an unused card's release, so our transfer stays
`consumed`.

A sandbox-only simulator reproduced this. It ran a 4396-cent lifecycle
(mint, `test_charge`, close, recover) on the verified holder 20 seconds after
the treasury card closed. The unchanged test then failed the same way after
25 attempts. As a control, the test was pointed at the other cardholder
(KYC pending, but `company_flow` mints succeed). There it passed, reclaiming
$13.00 on attempt 17. That cardholder's recent transfers were all 1300-cent
treasury mints, and every one was reclaimed in full.

## Solution

`selectTreasuryRailCardholder` checks every other idle cardholder before the
payment-benchmark cardholder. It uses the shared one only when it is the sole
idle choice, and it still never picks a cardholder with an OPEN card. The
fixed test passed with the simulator running a foreign lifecycle on the
verified holder: $13.00 was reclaimed on attempt 15.
`treasury-rails-cardholder.blackbox.ts` covers the selection order, the
fallback, and OPEN-card exclusion; it runs automatically as a backend
blackbox domain. The change is test-only, so there is no 10k-agent runtime
effect.

Still open: the sandbox org has only one KYC-verified cardholder. A
dedicated verified cardholder for treasury-rails needs human KYC. Until
then, runs that fall back to the shared cardholder can still contend.

## Human feedback

None recorded.

## Reusable lesson

When a live sandbox proof depends on fungible per-account state, run it on an
account that concurrent benchmarks do not use, not merely one idle at selection.
