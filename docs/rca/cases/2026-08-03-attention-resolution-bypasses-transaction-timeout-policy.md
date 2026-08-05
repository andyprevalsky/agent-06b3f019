---
id: 2026-08-03-attention-resolution-bypasses-transaction-timeout-policy
date: 2026-08-03
title: Attention resolution bypassed the canonical interactive-transaction timeout policy and returned 500 under load
surface: back-end
component: gate-resolution
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/gateResolution.ts resolveAndSignal — called raw prisma.$transaction with Prisma's 5-second body timeout instead of the repository's 10-second transaction wrapper
symptoms:
  - "Failed to respond to attention request"
  - "Failed to reject attention request"
  - "Transaction already closed: A commit cannot be executed on an expired transaction"
tags:
  - attention-requests
  - prisma
  - interactive-transaction
  - coverage
  - related-case
sources:
  - plan:.context/deploy-runs/20260804-010248-92487
  - plan:docs/rca/cases/2026-07-18-interactive-transaction-excluded-from-retry-extension.md
repro: back-end/src/tests/blackbox/attention-requests.blackbox.ts
status: fixed
---

## Problem

The full backend coverage gate passed 106 unit files and 114 of 115 blackbox
domains, but `attention-requests` failed its normal respond and reject cases.
Both endpoints returned 500. The instrumented backend log showed the responding
transaction expired at commit after 5.854 seconds and a rejecting transaction
expired during a query after 5.381 seconds; Prisma reported a configured
transaction timeout of exactly 5,000 milliseconds.

## Diagnosis

The routes mapped exceptions from `service.respond` and `service.reject` to the
observed 500s. Both service paths call `resolveAndSignal`, which updates the
attention row and finishes any associated in-progress tool messages atomically.
That provider invoked raw `prisma.$transaction`, inheriting Prisma's five-second
interactive-transaction body timeout. Under the deploy gate's concurrent
database load, otherwise successful query work crossed that ceiling and the
transaction rolled back. The repository already owns
`runTransactionWithRetry`, whose canonical policy gives interactive transaction
bodies ten seconds while retrying only provable pre-body acquisition failures.
Gate resolution bypassed that policy.

Archive searches for the endpoint errors, P2028, and `resolveAndSignal`
identified the closest relative in
`2026-07-18-interactive-transaction-excluded-from-retry-extension`. That case
introduced the canonical transaction wrapper after agent creation bypassed the
client-level query retry extension. This is a related policy-boundary failure,
not a recurrence of the same deepest cause: the earlier failure was an
unhandled, side-effect-free transaction-start timeout; this one was a mid-body
expiry caused by a call site bypassing the wrapper's body-timeout policy. The
shared lesson and boundary distinction are cross-linked from the prior case.

## Solution

`resolveAndSignal` now uses `runTransactionWithRetry`, aligning its maximum wait,
ten-second body timeout, and safe pre-body retry rules with other multi-query
mutations. The atomic response plus tool-message transition remains unchanged,
and Temporal signaling still occurs after commit. At 10k agents this adds no
queries or retries to the healthy path; it only gives an already-running
transaction enough bounded time to finish under transient database contention.
The structural architecture gate now discovers raw transaction callbacks from
the TypeScript AST, including aliased receivers, destructured calls, and
explicit generics. Each remaining exception freezes its owning scope and a
fingerprint of the complete call, so moving, replacing, or editing a raw call
fails the gate. Detection self-tests against aliased/destructured callbacks,
array transactions, and the canonical wrapper form.

Post-fix verification: the identical deploy command
`BLACKBOX_TEST_CONCURRENCY=4 CONTRACT_TEST_CONCURRENCY=4 BACKEND_UNIT_CONCURRENCY=6 npm run test:coverage`
passes 106/106 unit files and 115/115 blackbox domains under concurrent load;
`attention-requests` passes in 8.291 seconds and total line coverage is 88.62%.
The structural architecture suite also passes 1100/1100 checks.

## Human feedback

None recorded.

## Reusable lesson

Every interactive transaction must use the repository's canonical wrapper unless it has a documented, tested reason to own a different timeout policy.
