---
id: 2026-10-02-in-process-rose-tests-shared-funded-key-cooldown-row
date: 2026-10-02
title: In-process Rose tests read and deleted the singleton funded-key cooldown rows that concurrent suites and the deploy stack write in the same local database
surface: back-end
component: backend-test-isolation
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: rose-stream-abort.test.ts, llm-stream-contract.blackbox.ts and rose.blackbox.ts call createStreamingCompletion in-process, so isGptApiKeyOnCooldown / isAnthropicApiKeyOnCooldown read (and their resets delete) the real `00000000-…` sentinel Integration rows on the local Postgres that the unit pool, the blackbox pool and the Step 5 stack all share
symptoms:
  - "Error: Rose shared-openai-priority route is on GPT_API_KEY cooldown (rose-stream-abort.test.ts)"
  - "llm-stream-contract: openai_apikey.skipped_cooldown, then RoseAllFailed: All 2 waterfall models failed for pool rose-1-ultra"
tags:
  - test-isolation
  - funded-key-cooldown
  - shared-database
  - deploy-gate
sources:
  - PR #1341
repro: seed live gpt_api_key_cooldown + anthropic_api_key_cooldown rows into a throwaway database and run rose-stream-abort.test.ts, llm-stream-contract.blackbox.ts and rose.blackbox.ts against it (first two fail and rose deletes both rows before the fix; all pass and both rows survive after); unit `funded-key-cooldown-isolation.test.ts`
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, backend coverage failed
twice. The unit `rose-stream-abort.test.ts` threw `Rose shared-openai-priority
route is on GPT_API_KEY cooldown` at 21:41:13. The blackbox domain
`llm-stream-contract` logged `openai_apikey.skipped_cooldown` at 21:42:13 and
then failed its assertion that the request was served by the OpenAI Responses
API. Neither test is about the cooldown.

## Diagnosis

### Evidence

- The funded-key cooldowns are singleton `Integration` rows under the sentinel
  user `00000000-0000-0000-0000-000000000000`. The unit runner, the blackbox
  runner and the Step 5 `run.sh` stack all use the same system Postgres
  database, `victoria`.
- `back-end/backend-logs.log` from the previous Step 5 stack recorded a real
  mark at 21:16:41: `Funded GPT API key backed off
reason=RosePaymentRequiredError until=21:46:41`. OpenAI rejected the funded
  key. The stack was stopped at 21:38, but the row it wrote stayed live, and
  `rose-stream-abort` read it at 21:41:13.
- The coverage server log shows that the `integrations` case
  `testGptApiKeyCooldown_markThenOnCooldown` marked the GPT cooldown at
  21:42:07.797 through `POST /api/integrations/compute-code/token/rate-limited`.
  That case keeps the mark until the server confirms the restore, which takes
  up to one 15s recheck. `llm-stream-contract`, running concurrently, read the
  live mark at 21:42:13.261.
- The opposite direction is also unsafe. `rose.blackbox.ts` calls
  `__resetGptApiKeyCooldown` / `__resetAnthropicApiKeyCooldown` around its
  cases, and both delete the shared rows. Against a database seeded with two
  live rows, the unchanged `rose` run left 0 of 2. A concurrent `integrations`
  case asserting "cooldown is persisted in DB" can lose its row the same way.
- Local repro in a throwaway database seeded with two live rows: the unchanged
  `rose-stream-abort` and `llm-stream-contract` failed with the coverage
  errors, and both passed with no rows.

### Root cause

Three in-process suites assert which provider serves a request. They read
real cross-process state, which they cannot own, through the production
cooldown helpers. Those rows are legitimately written by other processes on
the same database: the deploy stack after a real provider 402, and the
`integrations` cases that test the server's DB-backed cooldown. Whether these
suites pass depended on what else had touched the database in the last
30 minutes.

## Solution

`funded-key-cooldown.support.ts` now exports
`withIsolatedFundedKeyCooldowns`. Inside it, `prisma.integration.findUnique`,
`upsert` and `deleteMany` calls that target a sentinel cooldown row go to a
private in-memory copy. All other integration calls reach the database. Both
caches are reset on entry and exit.

`rose-stream-abort.test.ts`, `llm-stream-contract`'s provenance case and the
`rose` blackbox runner run inside it. The `integrations` cooldown cases still
use the real row, because they test the cross-process contract.

`funded-key-cooldown-isolation.test.ts` simulates a database whose shared rows
are both live. It requires that:

- isolated cases see neither mark;
- in-process marks persist and resets clear them;
- unrelated integration reads still reach the database;
- the shared rows are never written or deleted.

`2026-10-02-stack-funded-key-cooldown-leaked-into-coverage-db` (PR #1401)
fixed the stale-stack half separately: coverage's database preparation now
clears stack-persisted cooldown rows before the suites start. That does not
cover rows written while coverage runs, such as the concurrent `integrations`
case, or the `rose` resets deleting rows other cases assert, so both fixes
stay.

## Human feedback

None recorded.

## Reusable lesson

A singleton row that production uses as cross-process state is shared by
every process on the database, including deploy stacks that stopped minutes
ago. A test that only needs that state absent must give itself a private
copy. It must not read the real row, and it must not delete the real row to
reset it.
