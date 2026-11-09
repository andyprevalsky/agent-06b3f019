---
id: 2026-11-02-prisma-client-stale-after-comment-only-schema-sync
date: 2026-11-02
title: Generated Prisma client freshness failed after a schema comment changed
surface: harness
component: backend-coverage-dependency-preflight
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The unchanged freshness predicate compared newly formatted schema bytes against a client generated before the main merge
symptoms:
  - Prisma client is stale or unavailable
  - All four coverage phases exited before tests
tags:
  - prisma
  - generated-client
  - dependency-preflight
sources:
  - commit 55e86d4b85240654797187d423a50862216edaab
  - plan:/project/rose-speed-comparison-20261028/nov2-prisma-refresh-rca/HANDOFF.md
repro: node back-end/scripts/assert-prisma-client-current.mjs
status: fixed
---

## Problem

The merged-source backend coverage run stopped all four phases before any tests because the generated Prisma client did not match the current formatted schema. Client and CLI versions both remained5.22.0. No database/runtime failure was established.

## Diagnosis

Gate: INTRODUCED at dependency preparation. The installed schema exactly matched prepared parent1ded38790, while merge55e86d4b8 changed only the Agent.projectId documentation comment. The unchanged predicate passed with the parent schema and failed with the merged schema. The separate synchronization fingerprint was absent; the predicate itself compares formatted schema bytes rather than that marker. Commands, hashes and preserved original phase logs are in the linked handoff.

## Solution

After frontend/shared-client readers became terminal, run the existing serialized sync-prisma-client.sh helper. It generated the matching client and its own fingerprint without changing source, schema or the database. The unchanged actual-root predicate then passed in0.715s. The backend coverage rerun progressed into its real unit/API tests, confirming the original preflight boundary is cleared. Later test failures are separate; this setup repair does not claim their success.

### 2026-11-08 recurrence: final-source TypeScript used the pre-sync client

PR1708 quick attempt 33 on 74311e0479c97a8ba770646fa83bf84ba5893081 produced nine missing-property TypeScript errors for `CodeSession.closingTaskId`, `CodeSession.closingEpoch` and `ClaudeCodeSession.closeResult`. Its original receipt remains native exit 2, FAIL, complete false, case UNVERIFIED, occurrence 561b82326b80465b9900a8a382342fd4.

The generated schema hash 72d725af6e00a7b5187eedd74f3413bf95f5a902bde96c3a3b7c94b161e1fa96 exactly matched commit 436727a0e6bde5e77d4463f246d8bf87618ca15b. Commit 02fb9a4993d3a80b5bbd0e8b87384a3339f68818 added precisely the three nullable fields. That schema is unchanged in incoming main 6b505755463d2ef066abdf50978f25616659da02 and final 74311; its hash is bb6d376e8bbb531b5fc8799791995c7b5b281c54da61801e469c2eded03c9939. CLI/client versions both remained 5.22.0. Package/lock inputs did not change in the sync, so dependency-install freshness did not imply generated-client freshness. The separately completed DB setup was not proof of generated-client refresh.

Gate: INTRODUCED at the main-sync environment completion boundary, not an original browser4f source defect. The current checkout schema was right; generated installed declarations were stale. Repair was only `node /home/boxes/rose/node_modules/prisma/build/index.js generate --schema prisma/schema.prisma` from back-end (exit 0, 2.636 seconds). No source, assertion, schema, DB, service or credential changes were made. Generated schema then exactly matched source, and the existing assert-prisma-client-current.mjs passed.

Exact same TypeScript argv/cwd and the same reconstructed environment failed before (exit 1, 9.349 seconds; nine error lines byte-identical to the original native log) and passed after (exit 0, 22.092 seconds). The reconstructed environment fingerprint does not equal the original request fingerprint; its values were not retained, and this gap is explicit. Original native exit 2 is never replaced by the diagnostic exit 1. The direct pass is causal local proof, not a native gate receipt. Parent must run the normal focused/native gate progression; no waiver or positive admission was written.

All raw proof, schemas, declarations, hashes and command metadata are under `.context/rca-browser-4f77/final-prisma-generation-rca-20261108-2121/`. The private triage proposal preserves UNVERIFIED and routes blocking repair to the parent. Reuse existing generated-client freshness checks; no new test or source edit is needed for this setup-only repair. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

For the 2026-11-08 recurrence the delegated RCA scope authorized only installed local client generation after Root quick producers were terminal, prohibited worker/source/DB/service changes, and required the original 321 failures and 18-entry review ledger to remain untouched. Preserve active test runs and original failure evidence. Do not regenerate shared dependencies while readers are active, weaken the freshness guard or claim a zero-test failure as coverage success. Freedom and native leases remain untouched.

## Reusable lesson

Strict generated-client freshness can change after documentation-only schema edits. Refresh generated dependencies with the normal lock-owning helper at a reader-free boundary after integrating source, then prove the unchanged predicate before rerunning tests.
