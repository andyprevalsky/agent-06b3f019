---
id: 2026-08-18-stripe-prefersteel-waits-kernel-direct
date: 2026-08-18
title: Stripe preferSteel recovery waited ~93s on kernel_direct which always provider_blacklists
surface: back-end
component: browser-challenge-recovery
classification: our-bug
problem_class: other
first_bad_boundary: browserRecoveryCandidates(preferSteel) included kernel_direct; runParallelBrowserConfigSearch Promise.allSettled waits for all probes before promote
symptoms:
  - steel_managed stablePasses=2 title Stripe Checkout in ~8s
  - kernel_direct still challenged text:provider_blacklisted ~93s
  - promote delayed until kernel_direct finishes
  - agent-payment-production-purchase Timeout after ~900s with purchase HELD
tags:
  - stripe
  - challenge-recovery
  - kernel
  - steel
  - production-purchase
sources:
  - agent 152153bd-5b39-4250-a9b6-20201f1790a3
  - commit f4cec59755d9e4d08a3f6ae790c48725afa425dc
repro: back-end/src/tests/unit/browser-challenge-recovery.test.ts (testSteelPreferredForKernelBlacklistedHosts)
status: open
---

## Problem

After Steel city-drop retry (#983), Stripe challenge recovery correctly cleared
`steel_managed` in ~8s (`stablePasses=2`, title `Stripe Checkout`). Each cycle
still waited ~93s for `kernel_direct` to finish failing with
`text:provider_blacklisted` before promoting, because probes use
`Promise.allSettled`. Three recovery cycles burned ~4+ minutes of the 900s
purchase budget; Place order reached `cs_live` but settle never completed.

## Diagnosis

`browserRecoveryCandidates({ preferSteel: true })` returned
`[kernel_direct, steel_managed, steel_fixed]`. Prod shows Kernel blacklists
`checkout.stripe.com` even with `omitManagedProxy` (stealth/direct egress).
Including that candidate cannot win and only delays the Steel promote.

## Solution

preferSteel returns Steel-only candidates. Cemented in unit test.

## Human feedback

User `alowed` to continue deploy/gates after held-disambiguation; purchase still
red until Stripe recovery latency fixed.

## Reusable lesson

Never include a known-impossible probe in a Promise.allSettled recovery race —
a guaranteed loser still gates promote on its full timeout.
