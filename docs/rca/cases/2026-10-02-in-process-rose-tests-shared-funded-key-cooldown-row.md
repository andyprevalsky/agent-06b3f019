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
  - "C15: a Claude usage limit backs that credential off and the inspection answers on Codex: actual usage_limited, expected answered"
tags:
  - test-isolation
  - funded-key-cooldown
  - shared-database
  - deploy-gate
sources:
  - PR #1341
  - PR #1770 backend repair handoff, failed source b544c29434ccbb5075952850b7701ffec14545c9
  - commit b544c29434ccbb5075952850b7701ffec14545c9, GitHub Actions run 42411735536
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

## Recurrence — 2026-11-08: code-session inspection and usage-limit fixtures

### Evidence and attribution

`Gate: NOT_INTRODUCED` for originating PR #1770. Its independent report
compared base `20f6e41`, failed `b544c294` and pre-sync parent `c8c25622`:
the complete backend tree was `50619c376dab9adab948ae3efa3c8479967e8d5c`.
Repair base `5066feea73da4a966aa7655ccbc40ea8c26529a8` contains the originating
merge and retains the exact inspector, credential-order, inspection service
and usage-limit service blobs. Later backend integration changes do not repair
this boundary. Attribution does not release this assigned repair.

The original command, from `back-end`, was `npm run test:coverage:sharded`:
two isolated shard databases, domain concurrency 4, case concurrency 30 and
900000 ms domain deadline. Native exit was **1**, with 247 domains completed,
246 PASS / 1 FAIL, no missing/aborted domains; units (368 files), FPS probe,
merged coverage threshold and separately run teardown passed. Its trailing
`&&` teardown did not run after the coverage failure. Those ancillary passes
do not convert the native gate failure to PASS.

The verified private backend packet SHA-256 is
`70ef72f6feb229b350452d97587f2f667ae83048feaf69355ea541203abfb547`.
It restored on the independent Bugs devbox without depending on the originating
machine. Its inspect log shows C15 returning `usage_limited` instead of
`answered` at original line 596. The usage-limit domain writes
`codex_funded_cooldown` at `20:35:58.178Z`; inspector availability resolves at
`.199–.205Z`; the writer deletes at `.210Z`. These logs do not record the row
value itself. The controlled replay below supplies that missing causal proof.

### First bad boundary and why the prior fix missed it

The credential-order case intentionally backs off funded Azure after exhausting
subscriptions. That row is global across users in its shard database.
`inspectCodeSession -> codeCredentialTiers -> usableCodexAzureFunding ->
codexFundedCooldownUntil` reads it and snapshots a Claude-only provider list.
The fake Claude CLI then reports its scripted limit, leaving no Codex attempt.
Later row cleanup cannot alter the snapshotted list.

This repeats the original case's private-fixture adoption gap: newer inspector
and usage-limit suites never adopted the existing isolation helper. The
inspector additionally saved/deleted/recreated the real Anthropic singleton,
which could destroy a sibling's mark. Startup database cleanup cannot isolate
rows written during a parallel sweep. Problem class remains
`fixture-environment-data-mismatch`; there is no live provider failure or
model-intelligence attribution, and no Rose agent self-report applies to this
hermetic backend test.

Archive searches were `usage_limited answered code-session-inspect` and
`parallel fixture cooldown credential shared isolation`. This case is a
recurrence; the stale-stack cooldown case is related.

### Repair and executed causal proof

The existing helper now exposes a lifecycle installer/restorer shared with its
callback API. Inspector and usage-limit hooks keep private GPT, Anthropic and
Codex cooldown rows for their complete in-process fixture lifetime. The
inspector's real-row save/delete/recreate logic is removed. User and pool
integration rows, HTTP subscription-marking cases, checkpoint storage and all
production selection logic still use their original paths. Matching is limited
to the three fixed singleton names, leaving unrelated sentinel state alone.
The callback helper restores delegates even if scope cleanup throws.

The permanent regression in `code-session-inspect.blackbox.ts` replays a competing
Codex row through the real Prisma read boundary in a child process, then runs
the existing C15 test unchanged. The replay never writes a competing global
Codex fixture. It lives in the existing inspection domain, preserving the
original domain inventory and shard assignment. Its owning replay fixture is
`code-session-inspect-cooldown.fixture.ts`. From `back-end`, the identical
pre/post command was:

```
BLACKBOX_TEST_CONCURRENCY=4 BLACKBOX_TEST_CASE_CONCURRENCY=30 npm run test:blackbox -- code-session-inspect-isolation
```

This initial fail/pass command used a separate replay domain during reduction;
the identical test callback was then consolidated into the existing inspection
domain so permanent regression coverage does not shift domain shard assignment.
Final proof used the identical command on both fixture versions:
`BLACKBOX_TEST_CONCURRENCY=4 BLACKBOX_TEST_CASE_CONCURRENCY=30 npm run test:blackbox -- code-session-inspect`.
The original fixture plus the final regression failed with the same C15
`usage_limited`/`answered` assertion at line 596 (8458 ms domain, exit 1).
The repaired fixture passed all eight tests, including original C15 and the
competing-cooldown replay (9234 ms domain, exit 0).

Before: exit 1; original C15 failed at line 596, actual `usage_limited`, expected
`answered` (568.97 ms C15 body; 1537.02 ms enclosing regression). After:
exit 0; the discovered regression passed (2326 ms domain). The assertions
still require Claude then Codex, correct Azure credentials, model, effort,
priority, catalog and teardown. The unit owner additionally checks private
Codex mark/read/reset, survival of shared marks and delegate restoration on
callback failure. The normal parallel inspector/usage-limit/replay sweep
also passed all three domains; the original complete sharded command remains
a separate required deployment gate, never inferred from these focused runs.

Delete/unify/guard choice: delete duplicated real-row restoration, unify on
the existing private-state helper, and constrain its singleton matching.
Serializing domains would remove the required overlap and leave other shared
writers exposed. Altering production cooldown selection would change correct
behavior to compensate for test data. No production code changes; at 10k
agents this adds no queries, subscriptions, shared locks or runtime cost.

Golden reference: not applicable (no approval-gated hunk).

### Recurrence acceptance and custody

The assigned repair retains responsibility for the original full sharded
coverage command, merge, production verification, cleanup and deploy scorecard.
The first full original command exited 0: 249/249 domains, all 374 unit
files, the isolated FPS probe, merged coverage thresholds and trailing teardown
passed (statements/lines 90.48%, branches 82.93%, functions 93.18%). That run
began before regression consolidation and stabilization, so the final frozen
snapshot still requires its ordinary full deployment gate. Focused proof above
is causal evidence; native gate and deploy receipts provide outcome proof. The two historical AgentCard cases remain no-retry
obligations with current financial state UNVERIFIED; this test repair grants
no authority to mint, reclaim, retry, release or reissue them. Freedom and
protected instructions are preserved.

## Reusable lesson

A singleton row that production uses as cross-process state is shared by
every process on the database, including deploy stacks that stopped minutes
ago. A test that only needs that state absent must give itself a private
copy. It must not read the real row, and it must not delete the real row to
reset it.
