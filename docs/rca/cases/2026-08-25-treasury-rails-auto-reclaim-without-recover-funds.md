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
  - recover_funds
  - harness-contract
  - deploy-gate
sources:
  - /workspace/back-end/coverage/blackbox-run/treasury-rails.log (deploy coverage 2026-08-25)
repro: cd back-end && npx tsx src/tests/blackbox/treasury-rails.blackbox.ts
status: fixed
---

## Problem

`/deploy` backend coverage failed on `treasury-rails` after mint → close → wait:

- `recoverAllCardholderResiduals` returned `settledCents=0` / `pendingCents=0` for ~240s
- Diagnostic `list_transfers` at timeout showed the mint transfer already
  `status=reclaimed` with `released_cents` equal to the mint amount
- Assertion required a `recover_funds` yield, so the suite failed even though the
  race-free money invariant (THIS card's transfer reclaimed in full) was already true

Solo retries sometimes passed via the residual path; under the full coverage suite
AgentCard more often settled by reclaiming the mint transfer directly without
exposing cardholder residual.

## Solution

`waitForRecoverable` now succeeds when either:

1. `recover_funds` yields residual headroom, or
2. THIS card's mint transfer reaches `reclaimed`/`released` with full `released_cents`

The subsequent `waitForTransferReclaimed` assertion remains the race-free money check.

## Evidence

Pre-fix (coverage run): transfer JSON at timeout
`status=reclaimed`, `released_cents=1300`, sweep still zero → FAIL.

Post-fix (same blackbox):
`(transfer already reclaimed with $13.00 on attempt 13; recover_funds not needed)` → PASS.
