---
id: 2026-10-02-stack-funded-key-cooldown-leaked-into-coverage-db
date: 2026-10-02
title: A local stack's real funded-key cooldown persisted in the shared test database and failed backend coverage
surface: back-end
component: blackbox-test-harness
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/run-coverage.sh database preparation reused the stack's Postgres without clearing process-global funded-key cooldown rows
symptoms:
  - "Error: Rose shared-openai-priority route is on GPT_API_KEY cooldown"
  - "FAIL  rose-stream-abort.test.ts"
  - "FAIL  llm-stream-contract"
  - "openai_apikey.skipped_cooldown"
tags:
  - coverage
  - blackbox
  - postgres
  - test-isolation
  - funded-key-cooldown
sources:
  - PR #1401
repro: back-end/src/tests/unit/coverage-script.part2.test.ts
status: fixed
---

## Problem

The deploy Group 3 backend coverage run failed `rose-stream-abort.test.ts` and the `llm-stream-contract` blackbox domain with `Rose shared-openai-priority route is on GPT_API_KEY cooldown` (log `.context/deploy-runs/20261002-160904-22776/logs/backend-coverage-blackbox-20261002-225041-772704.log`). Both had passed on the previous HEAD an hour earlier. Neither test changed, and the branch diff does not touch the cooldown code.

## Diagnosis

Coverage logged "Using local Postgres (system) at localhost:5432", which is the same `victoria` database the deploy Step 5 stack uses on a Docker-less host. At 22:34:49 that stack received a real OpenAI 402 and persisted `Funded GPT API key backed off reason=RosePaymentRequiredError until=2026-10-02T23:04:49Z` (`.context/deploy-smoke.log`). Coverage started at 22:50:41. `rose-stream-abort` failed at 22:53:01, before any coverage process had marked a cooldown (the first in-run mark is at 22:53:52 in `coverage/server.log`). `isGptApiKeyOnCooldown()` read the stack's row and skipped the funded route the test exercises.

Local repro: `markGptApiKeyOnCooldown('RosePaymentRequiredError')` against `victoria`, then the unchanged `npx tsx src/tests/unit/rose-stream-abort.test.ts` exited 1 with the same error. After running the harness's new preparation SQL, the same command exited 0. Archive searches for the error string and for a shared local test database found `2026-07-11-shared-local-db-concurrent-schema-mutation` (per-workspace isolation) and the 2026-10-01 positive-cache cases. Neither covers runtime provider state written by a stack into the test database.

Isolating the database does not remove the cause. A Docker workspace shares one container between `run.sh` and coverage. The isolated `victoria_<workspace>` database also receives real cooldowns from the Step 6c Codex smoke. The deepest owned cause is that the harness's database preparation established schema and stale-row hygiene but not a provider-neutral funded-key state.

## Solution

`run-coverage.sh` and `run-blackbox-tests.sh` now delete the process-global `gpt_api_key_cooldown` and `anthropic_api_key_cooldown` rows (the all-zero user) in their existing pre-test SQL block, before the schema push and before any test starts. `coverage-script.part2.test.ts` asserts that both harnesses clear both rows ahead of `Syncing Prisma schema`. It failed against the old harness and passes against the new one. This also prevents the sibling Anthropic funded-route failure. It is test-harness-only, with no runtime cost at 10,000 agents; the local stack at worst makes one extra funded-key call before re-marking the cooldown.

## Human feedback

None recorded.

## Reusable lesson

A test harness that reuses a database a live stack writes to must reset the process-global provider state its tests assume, not only the schema.
