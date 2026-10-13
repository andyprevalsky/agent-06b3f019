---
id: 2026-10-12-planner-memory-visibility-probe-depended-on-paraphrase-recall
date: 2026-10-12
title: Planner-memory visibility assertion used a paraphrase below the search similarity floor
surface: back-end
component: planner-memory-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the internal visibility case used paraphrased goals despite the endpoint's default 0.70 similarity floor
symptoms:
  - benchmark runs are shared corpus
  - 190 passed, 1 failed, 191 total
tags:
  - planner-memory
  - blackbox
  - similarity-floor
  - visibility
sources:
  - task planner-memory blackbox run 1791841959-2940194-19979
repro: cd back-end && BLACKBOX_TEST_RUN_ID=1791841959-2940194-19979 BLACKBOX_TEST_CONCURRENCY=1 bash scripts/run-blackbox-tests.sh planner-memory
status: fixed
---

## Problem

The backend coverage gate failed the planner-memory case "private runs are rows
too, visible only to their own user" while validating an independent cookie
transfer repair. Its shared-corpus assertion expected a seeded benchmark row
from a shortened paraphrase, using the endpoint's default similarity floor.

## Diagnosis

Replaying the captured run ID through the unchanged local blackbox command
failed the same assertion. A temporary diagnostic used the existing search
client and embedTexts path with the exact failing paraphrase, then measured
cosine similarity against the stored goalVector. The score was
0.6909308455226585, below the unchanged 0.70 floor. The result set was empty.
An exact GOAL_BENCH search for the same other user returned the benchmark row.
The internal visibility predicate therefore admitted the row; the semantic
filter correctly rejected the paraphrase. No model or generation setting was
changed, and this is not a model-intelligence diagnosis.

Archive searches used "benchmark runs are shared corpus" and "planner memory
visibility similarity floor paraphrase". The October 2 archive-blackbox corpus
leak is a relative, not a recurrence: the local database had no leftover shared
benchmark rows after cleanup, and the failed probe had no returned candidates.
Neither the top-20 limit nor a leaked corpus explains the captured omission.

The first bad boundary was the test's coupling of two independent contracts:
requested visibility scope and semantic recall. The probe uses the internal
API key; it does not test JWT ownership or spoofed user_id rejection.

## Solution

Use the three exact seeded goals for the existing internal visibility probes.
All visibility assertions remain unchanged. The exact foreign private goal
also strengthens the negative assertion: a relevance miss cannot conceal a
scope leak. Dedicated paraphrase, ranking, exclusion and similarity-floor cases
remain unchanged. Production search code, limits, thresholds, credentials and
benchmark definitions remain unchanged.

The exact command above passed after the fixture correction: fourteen cases,
zero failures. The correction remains in the existing permanent planner-memory
blackbox domain, included in backend coverage. A temporary diagnostic was
removed after recording the score. This test-only change adds no production
work or coordination at 10,000 agents.

## Human feedback

None recorded for this independent deployment-gate failure.

## Reusable lesson

Visibility probes should use known exact matches; test semantic recall and its
threshold separately so a correct relevance rejection cannot masquerade as a
scope violation.
