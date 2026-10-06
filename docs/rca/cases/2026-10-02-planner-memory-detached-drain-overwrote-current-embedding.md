---
id: 2026-10-02-planner-memory-detached-drain-overwrote-current-embedding
date: 2026-10-02
title: The detached planner-memory embed drain overwrote embeddings unconditionally, re-embedding an unchanged goal and able to restore a superseded goal's vector
surface: back-end
component: planner-memory-embedding
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/plannerMemoryEmbedding.ts:upsertEmbedding — ON CONFLICT DO UPDATE always rewrote the vector, even when the row was already current for that goal or its goal had changed since the drain read it
symptoms:
  - "❌ embedding is idempotent, re-embeds on goal change, and cascades on delete"
  - "unchanged goal must not re-embed"
tags:
  - planner-memory
  - embeddings
  - race
  - idempotency
  - deploy-gate
sources:
  - PR #1341
repro: cd back-end && bash scripts/run-blackbox-tests.sh planner-memory (case "a late detached embed write never rewrites a current goal or restores a superseded one")
status: fixed
---

## Problem

`/deploy` Step 4a (deploy run `20261002-191915-1586598`, HEAD `7ce6c15bd`)
failed `planner-memory`. Its case "embedding is idempotent, re-embeds on goal
change, and cascades on delete" asserted `unchanged goal must not re-embed`.
The embedding's `updatedAt` moved 9 ms (`1790971142256` became
`1790971142265`) between two PUTs of the same goal. The case passed on every
other run that day.

## Diagnosis

### Evidence

- PUT embeds synchronously: `service.upsert` calls `embedPlannerMemory`, which
  skips the write when the stored model and goal hash are already current. The
  second PUT therefore did not rewrite the row itself.
- Every finalize also calls `scheduleFinalizeEmbedding`. That detached task
  embeds its own row and then drains up to 8 pending rows, meaning rows with no
  embedding for the current index. In coverage, the `archive` domain and
  `planner-memory`'s own finalize cases trigger it on the shared backend.
- The drain lists pending rows, calls the embedding API, and then runs
  `upsertEmbedding`. That write was an unconditional `ON CONFLICT DO UPDATE`
  that set `updatedAt = NOW()`.

### Root cause

The drain listed the fixture row in the window between its creation and the
synchronous embed's commit. It wrote its own vector 9 ms after the synchronous
one, so the test saw an unchanged goal re-embedded.

The same unconditional write is a product bug beyond the flake:

1. A drain reads goal A.
2. The goal changes to B and the synchronous embed stores B's vector.
3. The drain then writes A's vector and hash.

The row now has goal B but A's vector. The pending query only looks for rows
with a missing or outdated-model embedding, so it never revisits this one.
Search keeps scoring that row with the wrong goal.

## Solution

`writePlannerMemoryEmbedding` writes in one statement that:

- inserts only while `PlannerMemory.goal` still equals the goal the vector was
  built from;
- updates on conflict only when the stored model or goal hash differs.

It reports `written`, `current`, or `superseded`. `embedPlannerMemory` and the
pending drain both use it. The drain keeps each row's own goal for the check and
counts a row as embedded unless the write was `superseded`.

The new blackbox case writes a late vector for the current goal and expects
`current` with an unchanged `updatedAt`. It then renames the goal, writes the
stale vector again, and expects `superseded` with the new goal's hash kept. It
failed before the fix (`'written' !== 'current'`). The domain passed 14/14 on
two consecutive runs after it.

At 10k agents this is still one statement per write, with two primary-key
lookups. It removes redundant rewrites and adds no new queries.

## Human feedback

None recorded.

## Reusable lesson

An idempotent "embed if needed" check is not enough when a detached writer can
act on a read it made earlier. The write itself must re-check, in the same
statement, that its input is still current and that the work is not already
done.
