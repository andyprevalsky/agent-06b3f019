---
id: 2026-08-25-treasury-rails-auto-reclaim-without-recover-funds
date: 2026-08-25
title: treasury-rails false-failed when AgentCard auto-reclaimed mint transfer without recover_funds yield
surface: back-end
component: treasury-rails-blackbox
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/treasury-rails.blackbox.ts waitForRecoverable — required recover_funds residual yield even when THIS card's mint transfer was already reclaimed in full
symptoms:
  - recovery reported nothing within the settle window after closing a funded card
  - unused value never became recoverable headroom
  - transfer status reclaimed with released_cents full while sweep stayed at 0
tags:
  - treasury-rails
  - agentcard
  - recover-funds
  - harness-contract
  - deploy-gate
sources:
  - memory:treasury-rails-auto-reclaim-2026-08-25
repro: cd back-end && npx tsx src/tests/blackbox/treasury-rails.blackbox.ts
status: fixed
---

## Problem

`/deploy` backend coverage failed on `treasury-rails` after mint → close → wait
because the assertion required a `recover_funds` yield even when AgentCard had
already reclaimed the mint transfer in full (`status=reclaimed`).

## Diagnosis

Under full coverage concurrency, AgentCard often settles by reclaiming the mint
transfer directly without exposing cardholder residual. The blackbox treated
"no residual yield" as failure despite the money invariant already holding.

## Solution

Accept full reclaim of THIS card's mint transfer as success in
`waitForRecoverable`, not only a residual `recover_funds` yield.

## Human feedback

Deploy coverage flake: suite failed while the race-free money invariant was
already true via auto-reclaim.

## Reusable lesson

Harness assertions must accept every provider-valid settlement path that
satisfies the money invariant, not only the residual-yield path observed in
solo retries.
