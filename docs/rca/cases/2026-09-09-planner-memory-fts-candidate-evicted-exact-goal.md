---
id: 2026-09-09-planner-memory-fts-candidate-evicted-exact-goal
date: 2026-09-09
title: Candidate SQL ranked a different objective than final memory scoring
surface: back-end
component: planner-memory-store
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/plannerMemoryStore.ts searchPlannerMemories candidate ordering
symptoms:
  - "coverage-perfect stored goal must survive the bounded candidate query"
  - "seeded goal must be retrieved"
  - "fixture row must be retrievable"
tags:
  - planner-memory
  - postgres-fts
  - candidate-recall
  - lexical-coverage
  - performance
sources:
  - plan:.context/test-runs/1788984199-453494-21542/runner.log
  - plan:.context/test-runs/1788986766-539673-8783/runner.log
repro: back-end/src/tests/blackbox/planner-memory.blackbox.ts
status: fixed
---

## Problem

On a 17,005-row local history corpus, four backend blackboxes could not retrieve
their exact seeded or fixture rows. A read-only query showed 25 verbose
documents tying at FTS rank 3.2 and filling the bounded set while the exact goal,
whose trigram similarity was 1.0, was absent. A stronger permanent reproduction
now inserts one long, coverage-perfect constrained goal plus 30
higher-trigram partial goals that each omit a required term; the perfect row
must survive the candidate limit.

The path was `goal -> POST /api/planner-memory/search -> FTS candidate bound ->
Python scoring -> injected hits`. Data first became irrecoverably wrong at the
SQL bound: the final scorer never saw the best candidate. Archive searches for
`seeded goal must be retrieved`, `ts_rank candidate limit`, and `planner memory
candidate recall` found no prior matching cause; this was novel.

## Diagnosis

The database ordered candidates by `ts_rank_cd`, while the selected retrieval
strategy depends on stemmed query coverage and reverse coverage. Repeated words
can raise FTS rank, and trigram similarity alone also favors close partials, so
neither was a recall-safe proxy for the downstream objective. Computing coverage
by tokenizing every raw goal in SQL preserved recall but took about 1,194 ms at
17,005 rows. The deepest owned cause was not persisting the features required by
the bounded retrieval contract.

## Solution

PlannerMemory now stores `goalTokens`, produced by an exact TypeScript port of
the Python tokenizer/stemmer at upsert. One indexed FTS query filters matches,
ranks them by stored-token lexical and reverse coverage, and computes trigram
only for the bounded top set. Python consumes the backend coverage value rather
than recomputing a divergent one. The migration retains the FTS GIN index; no
second search request or trigram-wide scan was added.

`cd back-end && npx tsx src/tests/blackbox/planner-memory.blackbox.ts` passes the
coverage-perfect-versus-30-partials regression as part of the planner-memory
blackbox. On the populated local corpus, `EXPLAIN (ANALYZE, BUFFERS)` showed the
GIN FTS index and 12.276 ms execution, versus about 1,194 ms for the rejected
raw-token SQL design. The backend run in
`.context/test-runs/1788986766-539673-8783/runner.log` passed in 14,182 ms.

## Human feedback

None recorded.

## Reusable lesson

Persist the features that define downstream relevance and rank by them before applying a bounded candidate limit.
