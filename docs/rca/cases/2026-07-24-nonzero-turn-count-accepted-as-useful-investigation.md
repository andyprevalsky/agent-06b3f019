---
id: 2026-07-24-nonzero-turn-count-accepted-as-useful-investigation
date: 2026-07-24
title: Auto-RCA retried on a different Claude account and scored its one-turn internal error as a green investigation
surface: harness
component: auto-rca-investigator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the Auto-RCA investigator result validator — it accepted any nonzero turn count as useful work, so `success` with `is_error:true` rendered green
symptoms:
  - Auto-RCA continuation attempt returns is_error true with one turn and $0 spend
  - retry rendered green despite an internal provider error
  - continuation used the generic Claude account instead of the dedicated RCA account
tags:
  - auto-rca
  - claude-oauth
  - validator
  - false-green
  - retry
sources:
  - PR #888
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

In production Auto-RCA run 30070018445 the continuation attempt came back with
`success` alongside `is_error: true`, exactly one turn, and $0 of spend — i.e. the
model never investigated anything. The pipeline nevertheless reported that retry
as green, so a failed investigation was published as a completed one.

## Diagnosis

Two defects compounded. First, the retry did not reuse the known-working dedicated
RCA Claude account; it silently switched to the generic account, whose credential
path returned an immediate internal error (one turn, zero cost). Second — and the
deeper owned cause — the result validator's definition of "the investigator did
useful work" was `turns > 0`. A one-turn error response satisfies that predicate
just as well as a real multi-turn investigation, so the validator could not
distinguish an unusable execution from a legitimate max-turn run whose work was
checkpointed. A liveness proxy (turn count) was standing in for a correctness
signal (`is_error`, spend, artifacts), which is what let a $0 error masquerade as
success.

## Solution

The continuation attempt now reuses the dedicated RCA Claude account rather than
falling through to the generic one, and the validator rejects
`success + is_error: true` one-turn executions outright while still accepting a
genuine max-turn investigation whose checkpointed work is proven by trusted
artifact gates. Validated by `scripts/tests/auto-rca-workflow.test.sh` and the
Auto-RCA lifecycle blackbox. The same shape applies to any agent-result gate:
score the artifacts and the error flag, not the turn/step count.

## Human feedback

None recorded.

## Reusable lesson

Never accept a turn/step count as proof an agent did useful work — gate on the
error flag, spend, and produced artifacts, and never let a retry silently swap to
a different credential than the one known to work.
