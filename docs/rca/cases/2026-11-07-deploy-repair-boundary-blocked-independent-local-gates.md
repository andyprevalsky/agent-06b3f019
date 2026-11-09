---
id: 2026-11-07-deploy-repair-boundary-blocked-independent-local-gates
date: 2026-11-07
title: Diagnosed deployment repairs prevented independent local full observations
surface: harness
component: staged-deploy-coordinator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: quick validation returned needs-focused-plan but independent observation accepted only unresolved triage, making unrelated local gates wait for cloud admission
symptoms:
  - "repair-independent rejected with exit 2"
  - "KeyError: needs-focused-plan"
tags:
  - deploy
  - isolation
  - scheduling
  - cloud-admission
sources:
  - PR #1708
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle
status: fixed
---

## Problem

After source repair and quick validation, the original cycle legitimately sat
at `needs-focused-plan`. Cloud cleanup and shared capacity still required work,
but the existing independent observation command accepted only unresolved
TRIAGE. The full focused command included cloud smoke, so that boundary also
blocked unrelated prepared local workers.

## Diagnosis

Owning regressions reproduced two rejected local-observation commands and a
`KeyError` when a newly observed nonblocking failure returned to the repair
boundary. These were lifecycle representation defects. Dropping smoke from the
selected plan, fabricating a TRIAGE occurrence, raising a capacity limit, or
calling old results current would not fix them.

## Solution

Add the normal `repair-independent` action at a quiescent diagnosed repair
boundary. It preserves the complete source/plan/environment/input checks,
ownership fences, original repair set and selected inventory. Its optional
`--include-repair-local` observes complete original local repair contracts as
well as full siblings. It never runs narrowed substitute commands.

Only `local-isolated` transports outside the cloud-smoke category are eligible;
native cloud is always excluded. A fresh independent review found that merely
excluding the `native_cloud` flag admitted a valid legacy cloud transport. A
registered harmless marker regression reproduced that candidate defect before
the transport/category restriction and passed after it. No provider was called.

Full receipts append to the same cycle. New failures enter real TRIAGE; waived
independent failures return to the required repair boundary. A successful local
observation leaves `ready=false` and retains all cloud and other required gates.
Existing exact full-pass binding rules remain unchanged. The unchanged paid
smoke still requires fresh native source/profile/capacity/ownership admission.

The original 193 owning assertions remain intact. Added controls cover full
sibling and repair inventories, real failure routing, stale/running/unresolved
boundaries, complete native and legacy cloud exclusion, retained debt, and
return from qualified disposition. The combined 203-test suite passed before
the final legacy-transport correction. The final204-test owning suite then
passed after that correction. Actual local full execution remains separate under
`.context/rca-browser-4f77/independent-repair-observation/`.

## Human feedback

Continue the original deployment autonomously while preserving its clock,
failures, all sixteen selected gates, original nine smoke checks, width four,
and provider limits. Independent work should wait only for actual conflicts.

## Reusable lesson

Represent deferred work explicitly without deleting it from the plan. Local-only
admission must validate the transport boundary, not rely on an optional flag.
