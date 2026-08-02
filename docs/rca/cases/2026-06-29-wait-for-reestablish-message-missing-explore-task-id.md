---
id: 2026-06-29-wait-for-reestablish-message-missing-explore-task-id
date: 2026-06-29
title: The wait_for re-establish message omitted exploreTaskId, so latest-wins grouping unnested its explore agent
surface: agents
component: wait-for-tool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the re-establish "Waiting for ..." IN_PROGRESS metadata — emitted without exploreTaskId, and it is the latest message for that checkNum
symptoms:
  - explore agents spawned from a wait_for condition check render as separate top-level messages
  - explore agent under a wait_for check is neither nested nor hidden
  - "Waiting for ..." IN_PROGRESS message repeats per unmet check
tags:
  - wait-for
  - explore-agent
  - front-end-grouping
  - message-metadata
  - deduplication
sources:
  - PR #667
repro: agents blackbox regression asserting every per-check wait_for message carries exploreTaskId
status: fixed
---

## Problem

Explore agents spawned from a `wait_for` condition check rendered as separate
top-level messages in the UI instead of nesting inside the check they belonged
to.

## Diagnosis

After each unmet check, `wait_for` emits a re-establish `"Waiting for ..."`
IN_PROGRESS message. That message's metadata was missing `exploreTaskId`, which
every other per-check message carries. The front-end groups per-check messages
with latest-wins semantics (`buildWaitForChecks` in
`deduplicateToolMessages.ts`), and the re-establish message is by construction
the _latest_ message for that `checkNum` — so the grouping read it, found no
`exploreTaskId`, and had nothing to attach the explore agent to. It was therefore
neither nested under the check nor hidden. The deeper cause is a contract that
was implicit: the FE requires a correlation key on every per-check emission, but
only some emission sites carried it, and nothing enforced parity across them.

## Solution

Added `"exploreTaskId": task_id` to the re-establish metadata — a one-line
emission fix that restores parity with every other per-check message. Cemented
with a blackbox regression asserting that _every_ per-check `wait_for` message,
including the re-establish one, carries `exploreTaskId`; the test was verified to
fail without the fix. The invariant form of the test (all messages, not just the
one that broke) also protects any future per-check emission site.

## Human feedback

None recorded.

## Reusable lesson

When a front-end grouping uses latest-wins, any emission that can be the latest
message must carry the full correlation metadata — assert the key on every
message of the class, not just the one you fixed.
