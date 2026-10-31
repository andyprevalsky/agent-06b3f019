---
id: 2026-10-31-folder-move-assumed-unique-ranks
date: 2026-10-31
title: Folder range moves changed unrelated relative order when stored ranks tied
surface: back-end
component: projects-folder-order
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: folder move derived insertion position from numeric ranks instead of the displayed rank/name/id order
symptoms:
  - "moving within tied ranks preserves the existing relative order"
  - "move C before B must not pull C ahead of A"
tags:
  - projects
  - folders
  - ordering
  - rolling-deployment
sources:
  - commit 7b83bc8fd159802cb9b8d2e1ddc8ebac329abc02
repro: back-end/src/tests/blackbox/projects-folder-order.cases.ts
status: fixed
---

## Problem

A development candidate for single-folder moves assumed distinct sortOrder
numbers. Existing writers omit the new field during a rolling deployment and
can create default-zero rows; the display contract still orders ties by name
and ID. In the local HTTP regression four folders A/B/C/D all had rank zero.
Moving C before B returned C,A,B,D instead of A,C,B,D. This candidate was never
pushed or deployed. The source above identifies its follow-up baseline, not a
claim that the intermediate range algorithm was present in that commit.

The buggy source was retained as
.context/project-folders/followup/repo-ties-before.ts, SHA256
828ffeeb00fe79f6b4eec534ed66f6900db002911b433dc5ec833f65864542f7.
The registered HTTP regression was run through
ROSE_USE_SYSTEM_PG=true bash scripts/run-blackbox-tests.sh projects:
22 tests passed and the tied-rank test failed (runner
.context/test-runs/1793407200-1345597-7145/projects.log).

## Diagnosis

The path is persisted ranks -> rank/name/id display order -> relative move
request -> rank-range arithmetic -> persisted ranks -> returned display order.
The first wrong boundary treated rank equality as an insertion ordinal.
For source and target rank zero it assigned source -1, moving C ahead of A
even though the requested target was B. Missing schema-uniqueness guarantees
and old writers make ties valid input, so raising limits or repairing one row
would not correct the algorithm's contract.

The earlier full-permutation candidate also capped requests at 1,000 while
folder creation had no matching capacity. The independent review reproduced
that schema refusal. A constant-size relative-move request eliminates that
capacity mismatch rather than introducing a second product capacity policy.

## Solution

Under the existing owning-project lock, read the same ordered collection used
by the UI, remove the source and insert it before the scoped target (or at the
end). Persist its dense ordinal ranks with one parameterized JSONB
WITH ORDINALITY update. The statement has two bound parameters regardless of
folder count, avoiding PostgreSQL's per-value parameter limit. Return the
ordered rows inside the transaction. Owner, source, target and self-reference
validation remain explicit; concurrent create/delete/rename share the same lock.

This unifies mutation semantics with displayed order, removing assumptions about
dense or unique numeric ranks. Work scales with that project's folders, not its
agents. There is no extra agent scan, global lock or unbounded request-ID list.
No prompt, benchmark definition, evaluator or timeout changed.

The identical test file (SHA256
473de1a0c9d2f6cd9bbde98d06379e90d93d88ceee3603d28580df4dcdbb9545)
then passed unchanged: 23/23 project HTTP/DB cases, runner
.context/test-runs/1793407264-1362597-30586/projects.log.
Coverage includes gaps, tied ranks, more than 1,000 folders, cross-project and
stale targets, concurrent membership changes, embedded DTO ordering and migration.
The existing projects suite imports this case file, and the normal deploy
backend blackbox runner discovers it. Backend architecture also passed all
2,067 invariants. Golden reference: not applicable to this ordinary code repair;
the new request schema receives its own scoped approval review.

## Human feedback

The user requested drag or menu ordering and required this work in the next
deploy. They also required auditing previously skipped failures and repairing
any caused by the folder change. The capacity issue was found by independent
review; the tied-rank case was reduced and proven before the candidate shipped.

## Reusable lesson

Implement relative moves against the exact displayed order instead of assuming persisted ranks are unique or contiguous.
