---
id: 2026-10-02-archive-blackbox-leaked-planner-memory-rows-into-shared-corpus
date: 2026-10-02
title: The archive blackbox leaked one shared benchmark planner-memory row per run until they pushed planner-memory's own fixture out of the 20-row search limit
surface: back-end
component: archive-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/archive.blackbox.ts:cleanup — finalize with benchmarkTaskName writes a PlannerMemory row keyed by the root agent id, and cleanup deleted the Agent but not that row (PlannerMemory has no FK to Agent)
symptoms:
  - "❌ a paraphrase with no shared distinctive words retrieves the run semantically"
  - "with no floor every visible row is scored"
  - "169 passed, 1 failed, 170 total"
tags:
  - blackbox
  - test-isolation
  - planner-memory
  - archive
  - shared-database
  - deploy-gate
sources:
  - PR #1341
repro: cd back-end && bash scripts/run-blackbox-tests.sh archive && bash scripts/run-blackbox-tests.sh planner-memory
status: fixed
---

## Problem

`/deploy` Step 4a (deploy run `20261002-191915-1586598`, HEAD `8581aaf3c`)
failed one backend domain: `planner-memory`. Its case "a paraphrase with no
shared distinctive words retrieves the run semantically" asserted
`with no floor every visible row is scored`, because the unrelated fixture was
missing from a `min_similarity: 0` search. The same domain passed 170/170 on the
previous run in this workspace earlier the same day.

## Diagnosis

### Evidence

- Run alone, `bash scripts/run-blackbox-tests.sh planner-memory` failed the same
  case deterministically against the workspace `victoria` database.
- That database held 17 `PlannerMemory` rows with
  `benchmarkTaskName = 'archive-blackbox'` and goal `archive root goal`. They were
  created between 2026-10-01 15:06 and 2026-10-02 19:22, one per coverage run, and
  none had a surviving `Agent`.
- One standalone `archive` run raised the count from 17 to 18.

### Root cause

`POST /api/archive/agent-finalize` writes the planner-memory history row in
lockstep with the manifest. `archive.blackbox.ts` finalizes with
`benchmarkTaskName: 'archive-blackbox'`, and its cleanup deleted the agents,
messages, people, tool, and users but not that row. `PlannerMemory` deliberately
has no foreign key to `Agent`, so deleting the agent does not cascade.

Benchmark-tagged rows are visible to every user's search.
`searchPlannerMemories` returns at most 20 rows (default limit), ordered by
similarity. The planner-memory case's unrelated fixture (a Spanish resume
translation) scores lowest under the Tahoe-cabin paraphrase. Once the leaked
rows plus the domain's own fixtures exceeded 20, it fell off the end of the
results.

The previous Step 4a passed only because the count was still below the limit.

## Solution

- `cleanup` deletes the `PlannerMemory` row for the seeded root; its embedding
  cascades.
- Before its cases run, the domain purges `archive-blackbox` rows whose root
  agent no longer exists, so a database polluted by earlier or interrupted runs
  recovers on the next run.
- A new case, "cleanup leaves no planner-memory history rows", asserts that no
  root seeded in the run still has a history row. It failed against the old
  cleanup (`archive cleanup left 1 planner-memory history row(s)`) and passes
  with the fix.

After the fix, the next `archive` run purged all 19 leaked rows and passed 5/5,
and `planner-memory` passed again.

## Human feedback

None recorded.

## Reusable lesson

A blackbox that writes into a corpus that other tests search, and that has no
foreign key cascading from what cleanup deletes, needs its own delete and an
assertion that the delete happened. Leaks into a bounded, shared result set stay
invisible until they cross the limit, and then they break a different domain.
