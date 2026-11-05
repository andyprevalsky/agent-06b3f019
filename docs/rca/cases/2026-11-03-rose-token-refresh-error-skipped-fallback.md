---
id: 2026-11-03-rose-token-refresh-error-skipped-fallback
date: 2026-11-03
title: Token refresh exceptions bypassed remaining Rose routes
surface: agents
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: direct_auth.fetch_fresh raises before the fallback loop can continue
symptoms:
  - An acquisition RuntimeError escaped RoseClient.complete instead of trying the next route
  - fetch_fresh raises RuntimeError before waterfall fallback
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 review5748355636
  - plan:/project/rose-speed-comparison-20261028/nov3-final-review-fixes/python-cli/HANDOFF.md
repro: Existing Rose and CLI-login registered owner regressions
status: fixed
---

## Problem

An acquisition RuntimeError escaped RoseClient.complete instead of trying the next route.

## Diagnosis

The code awaited a fallible backend acquisition callback outside its failure boundary. The original subscription error was already classified, but the new exception escaped the whole call.

## Solution

Catch ordinary Exception only at acquisition, record error type without credential-bearing message, keep fresh=None and continue the existing fallback. Cancellation, rotation budgets, exclusions and original token error metadata remain unchanged.

## Human feedback

The user instructed completion of the deployment and correction of blocking issues. Preserve Freedom, credentials, cooldowns, leases and existing acceptance criteria.

## Validation

Actual RoseClient entrypoint before2FAIL1PASS, after3PASS includes refresh error fallback, successful fresh token, zero rotation budget and cancellation. Final controls enforce zero socket connections. Original incidental localhost trace attempts are disclosed in the handoff. Registered owner validation passed: Rose289/289; CLI-login9/9 and repo-onboarding passed in artifact1793691277-2805897-17819. Original failed fixture integration retained in1793691173-2766599-4969; exact quoted-ID expectations and Prisma delegate seam were corrected without weakening assertions. No production outcome is claimed.

## Reusable lesson

Validate the actual execution boundary and retain failure/cancellation semantics rather than testing only a formatting or helper function.
