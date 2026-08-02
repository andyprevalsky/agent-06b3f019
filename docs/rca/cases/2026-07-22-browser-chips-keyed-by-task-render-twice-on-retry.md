---
id: 2026-07-22-browser-chips-keyed-by-task-render-twice-on-retry
date: 2026-07-22
title: The frontend keyed browser chips by provider task, so a Temporal retry after a CAS conflict rendered a second chip for one logical tool call
surface: front-end
component: browser-agent-chip
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the frontend browser-panel derivation keyed chips by provider task id instead of the logical `toolCallId`
symptoms:
  - two browser chips visible for a single browser tool call
  - a replacement browser task appears after provider IP rotation
  - duplicate browser panel after a Temporal retry following a CAS conflict
tags:
  - browser-agent
  - chip
  - rotation
  - temporal-retry
  - toolcallid
  - dedup
sources:
  - PR #854
repro: front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts
status: fixed
---

## Problem

A single browser tool call rendered two browser chips in the UI. The duplicate
appeared when provider rotation was involved: the rotation kept the original
task, then a Temporal retry following a CAS conflict created a replacement task
for the same tool call.

## Diagnosis

Chip identity was derived from the provider _task_, not from the logical tool
call. A browser tool call can legitimately own more than one task over its
lifetime — provider rotation retains the original task while an activity retry
mints a replacement — so any task-keyed view of the world duplicates the chip
exactly when retries occur. The owned defect is the mismatch between the
frontend's identity key (task) and the only stable identity the backend
guarantees (`toolCallId`).

## Solution

New derivation logic supersedes older retries that share the same `toolCallId`,
so one logical browser tool call renders exactly one chip across retries and
provider rotation. Regressions in
`front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts` assert that
two panels are never rendered while one browser tool call is retrying, and that a
live retry task is not closed by an earlier sibling task's completion under the
same tool call.

## Human feedback

Within the same RCA batch, the human directed that premature challenge rotation
be left alone rather than changed (recorded as "intentionally skipped at user
direction").

## Reusable lesson

Render UI identity from the logical tool call, never from a provider/task handle
that retries and rotations are allowed to replace.
