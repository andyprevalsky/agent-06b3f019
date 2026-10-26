---
id: 2026-10-26-trace-archive-per-run-work-scaled-with-user-history
date: 2026-10-26
title: Trace-archive per-run capture, finalize delete and late-file indexing scaled with user history, not with the run
surface: back-end
component: trace-archive
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/traceArchiveFixture.ts collectFixtureWithClient read every Person/MessageRecord/Cookie/CookieBundle/BrowserPassword/AgentPhoneMessage row of the user per run; traceArchiveSearchIndex.ts replaceArchivedRows deleted by rootAgentId with no index leading on it; traceArchiveLifecycle.ts storeWorkerArtifact re-indexed the whole bundle for every late llm/ file"
symptoms:
  - DELETE FROM "public"."AgentTrajectorySearch" WHERE ("public"."AgentTrajectorySearch"."rootAgentId" = $1 AND "public"."AgentTrajectorySearch"."archivePath" IS NOT NULL)
  - SELECT "public"."Cookie"."id", "public"."Cookie"."userId" FROM "public"."Cookie" WHERE "public"."Cookie"."userId" = $1 (20,372 calls, 113M rows)
  - pg_advisory_xact_lock( hashtextextended($1, $2) ) trace-archive-manifest 4.1 s average, 120 s worst
  - Could not read 1 LLM artifacts for <root>: llm/<file>.json.gz.enc
tags:
  - trace-archive
  - scalability
  - 10k-agents
  - agent-trajectory-search
  - db-fixture
sources:
  - PR #1577
  - commit b3679ea7b
  - memory:scalability-audit-100-seats-20261024
  - plan:docs/plans/completed/trace-capture-and-eval-authoring.md
repro: back-end/src/tests/blackbox/archive-run-cost.helper.ts (registered in archive.blackbox.ts)
status: fixed
---

## Problem

The 2026-10-24 100-seat audit found that every root run's trace-archive work
grew with the owning user's lifetime history. Re-measured read-only on prod
(2026-10-26, latest main `b3679ea7b`):

- The per-run start and end fixture read every `Cookie` of the user: 20,372
  calls returned 113,107,565 rows. The same fixture read every `Person` and all
  of their `MessageRecord`s (about 190k rows per call for the heaviest user;
  108.6M rows in total per the audit) inside a REPEATABLE READ transaction with
  a 30 s budget. Downstream readers (search index, planner memory, WMH
  initial state) only use `Agent`/`Message` rows and row counts.
- Each finalize ran `DELETE FROM "AgentTrajectorySearch" WHERE "rootAgentId" = $1 …`:
  20,754 calls, 177 ms average, 30.9 s worst. Every index on the 9 GB table
  leads with `userId`, so the predicate walked the 610 MB
  `AgentTrajectorySearch_user_root_time_idx` in full.
- Each `llm/` artifact arriving after finalization started reconciled the
  manifest and then re-read and re-indexed every llm file of the run under the
  manifest advisory lock — quadratic in the number of late files and the main
  holder of the `trace-archive-manifest` lock (165,841 acquisitions, 4.1 s
  average wait, 120 s worst).

## Diagnosis

Step 0.5 searches: "trace archive fixture MessageRecord full history per run"
and "AgentTrajectorySearch delete rootAgentId index scan finalize slow". Relative,
not recurrence: `2026-10-09-hub-index-repair-scanned-archive-inside-writer-lock`
is the same class (O(history) work inside a per-key lock) on a different store.

1. `collectFixtureWithClient` scoped run tables by the agent tree, but user
   tables by `userId` with no bound, so capture cost and restore scope were the
   user's whole account. The canonical base image (`base:victoria-prod-sync-v1`,
   plan `trace-capture-and-eval-authoring.md` Requirement 4: fixture = base +
   delta) already carries lifetime user history.
2. `replaceArchivedRows` built its delete from `rootAgentId` only. PostgreSQL
   accepts a non-leading-column qual as an `Index Cond`, but then scans the
   whole btree; the plan never seeks.
3. `storeWorkerArtifact` called `indexArchivedTraceFromR2` (list + read every
   `llm/` object + delete/replace every row) for each late `llm/` file.

Local reproductions (`ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=s4lane
CONDUCTOR_PORT=4710 bash back-end/scripts/run-blackbox-tests.sh archive`), on
the buggy revision:

```
FAIL  run fixture excludes the user's lifetime history -- per-run fixture read the user's lifetime Person history
FAIL  finalize search-index delete seeks by root -- finalize delete cannot seek by (userId, rootAgentId): … "Index Name":"AgentTrajectorySearch_user_root_time_idx" … Index Cond rootAgentId only
FAIL  late llm artifact indexes only itself -- late llm artifact re-read the finalized bundle: {"error":"Could not read 1 LLM artifacts for <root>: llm/early-dump.json.gz.enc (Archive ciphertext SHA-256 mismatch)"}
```

The late-file case makes the earlier, already-indexed llm file unreadable
after finalize; any late write that re-reads the run fails, proving the
per-late-file whole-run read.

## Solution

- `traceArchiveFixture.ts`: per-run fixtures no longer capture the lifetime
  user-history tables (`Person`, `MessageRecord`, `Cookie`, `CookieBundle`,
  `BrowserPassword`, `AgentPhoneMessage`). New fixtures persist a
  `table_order` without them and `restore.user_history: "base-image"`, so
  `restoreFixture` leaves that history to the base image. Older fixtures keep
  their own `table_order` and restore exactly as before. Run-bounded tables and
  the user's small configuration rows (User, Integration, credentials,
  identity, SMS session) are unchanged. The REPEATABLE READ start snapshot now
  reads only run-scoped rows, so it no longer approaches its 30 s budget.
  Restoring a base-image fixture keeps the existing `User` row (insert only
  when missing): deleting it cascades to `CookieBundle`, `AgentPhoneMessage`
  and other history the fixture no longer carries (CodeRabbit, PR #1577).
- `traceArchiveSearchIndex.ts`: the finalize delete is
  `deleteArchivedBundleRowsSql(userId, rootAgentId)`; the owner equality makes
  it a seek on `AgentTrajectorySearch_user_root_time_idx`. Rows are only ever
  written with the bundle owner's `userId` (the upsert refuses owner changes).
- `indexLateArchivedLlmArtifact`: a late `llm/` file reads the manifest, the
  fixture and that one file, and inserts its rows with `ON CONFLICT DO NOTHING`
  (same dedupe digest as the whole-bundle index; earlier content keeps its
  original path). N late files now cost N reads, and the manifest lock is held
  for three object reads instead of the whole run. A rewritten late path
  deletes that path's rows and re-inserts in one transaction (CodeRabbit).

10k-agent behaviour: per-run fixture rows and reads are O(agents, messages and
tools in that run) plus O(1) user configuration rows; zero rows from user
history. The finalize delete touches O(rows of that run) index entries. A late
llm file costs O(1) object reads and one batched insert. No new locks, channels
or shared rows; lock hold time per late file falls from O(run files) object
reads to three.

Regression: `back-end/src/tests/blackbox/archive-run-cost.helper.ts`, registered
in `archive.blackbox.ts` (backend blackbox Step 5a); five consecutive passes.

Not changed here (follow-ups): the manifest advisory lock is still an
interactive transaction around R2 I/O (a lease that does not pin a pooled
connection is the structural fix); `AgentTrajectorySearch.agentGoal` is copied
onto every row (~2.4 GB); the fixture's `ToolSideEffect operationKey LIKE
'%<id>%'` scan is O(table) but the table holds ~2k rows today; restoring any
fixture still deletes `Integration` rows, which cascades to `PlaidItem`
(pre-existing, bounded per user).

## Human feedback

None recorded.

## Reusable lesson

Scope every per-run capture, delete and re-index by the run's own keys through an index whose leading column is bound, and never re-read a whole bundle to absorb one new file.
