---
id: 2026-11-07-hub-pipeline-first-claim-path-not-retained
date: 2026-11-07
title: First Hub pipeline claim missed its bound without retained poller startup evidence
surface: harness
component: benchmarks-hub-pipeline
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Before first claim PATCH; poller startup or queue selection cause remains unproven
symptoms:
  - STUCK at stage "claimed by poller" — no progress within 25s
  - STUCK at stage "completes after snapshot cancel" — no progress within 60s
tags:
  - hub-pipeline
  - claim
  - observability
sources:
  - PR #1716
  - commit ed47d406bb5b17de8a4c5a291878edece7c64d61
  - commit 1c0a5e56c2ddeddf20802f337aaa8bf183a86e3f
repro: none-recorded
status: open
---

## Problem

The original backend full gate reported six Hub pipeline failures. First
dispatch succeeded at08:52:43.741; no claim PATCH arrived before the 27-second
observed deadline miss and dashboard deletion. Original receipt is terminal,
native exit1 and cleanup true. The coordinator's later exit143 is independent
and has no established cause.

## Diagnosis

Overall attribution remains UNKNOWN. Backend queue reads were fast/successful,
but logs omit query strings and caller identity. Original per-poller temporary
logs were deleted unconditionally; no startup-stage span survives. Direct
owning bytes match prior1c0a, main39 and candidate, except an unrelated full
schema addition with identical Hub models. Prior1c0a domain receipts pass.
An executed unchanged local domain using real Hub/Prisma/poller code with a
local HTTP adapter passed8/8 in18.905s. This is an unreproduced primary failure,
not evidence that integration cannot have affected its environment.

## Solution

No primary fix applied or claimed. Preserve startup/queue-read caller identity,
timestamps, exits and all per-poller logs before another original-domain
attempt. Scratch captures already retain local poller logs. Secondary stale
queue cleanup has separate causal evidence and a candidate; it cannot close
this primary cause. No full-gate rerun or provider call was made.

## Human feedback

User required a20-minute independent investigation, no canonical edits or
subdelegation, original deadlines/assertions/concurrency, exact existing worker
admission and a dedicated disposable DB. Parent owns deployment and no
additional gate is automatically waived.

## Reusable lesson

Retain first-poller startup and queue-read evidence before attributing a claim timeout or interpreting downstream legs.
