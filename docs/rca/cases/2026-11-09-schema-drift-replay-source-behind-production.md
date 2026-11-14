---
id: 2026-11-09-schema-drift-replay-source-behind-production
date: 2026-11-09
title: Schema drift check replayed a pre-merge checkout and reported an intentionally dropped index as production drift
surface: back-end
component: schema-drift-check
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/schemaDrift/index.ts compareCatalog (replayed only local migrations the database recorded as applied, silently skipping applied migrations the source lacked); scripts/deploy_prod.py lane_backend_probes ran the smoke from the pre-merge deploy checkout
symptoms:
  - "❌ schema             migration-declared objects"
  - "missing indexes: ImessageQueue_phoneBrowserTaskId_key (20261019071000_cloud_phone_message_intents)"
  - "Schema drift: objects were removed or changed after their migrations were recorded applied. Restore them with a new idempotent migration; never with an ad-hoc db push."
  - "14/15 production checks healthy."
  - "prod-endpoint-smoke exited 1"
tags:
  - prisma-migrations
  - schema-drift
  - prod-endpoint-smoke
  - deploy-production
  - source-binding
sources:
  - PR #1872
  - PR #1803
  - PR #1698
  - PR #1860
  - PR #1877
  - commit 21a16288d6f59e44884392c30ba7d727ed72fb71
  - commit 59347a669716541c8b3ed4c0572f9cdb5af17cf4
  - commit a05625208a
repro: back-end/src/tests/unit/schema-drift-check.test.ts
status: fixed
---

## Problem

The PR #1803 `scripts/deploy production` backend-probes lane (2026-11-09
08:09Z, Render live on 21a16288d6) failed `prod-endpoint-smoke` with
`missing indexes: ImessageQueue_phoneBrowserTaskId_key
(20261019071000_cloud_phone_message_intents)` and the hint to restore it with a
new idempotent migration. A repair goal was dispatched to do exactly that.

Read-only production evidence (08:17Z, `BEGIN READ ONLY`): `_prisma_migrations`
records 20261019071000, 20261105233000 and 20261105233001 finished, and
20261105233002 finished after one rolled-back 40P01 attempt. `ImessageQueue`
holds valid `ImessageQueue_phoneBrowserTaskId_unresolved_key` (partial unique),
`ImessageQueue_phoneBrowserTaskId_idx` and `ImessageQueue_phoneSendOperationId_key`.
`ImessageQueue_phoneBrowserTaskId_key` is absent because 20261105233001
(`DROP INDEX CONCURRENTLY`) intentionally dropped it; `schema.prisma` declares no
such unique. Production schema equals the committed history: there was no drift.
Restoring the index would have re-imposed the uniqueness PR #1698 removed so a
browser task can keep historical queue rows.

## Diagnosis

1. The production lane runs `prod-endpoint-smoke.ts` with `cwd` in the deploy
   checkout (`lane_backend_probes`), which is the PR head, not the merge Render
   serves. PR #1803's head 59347a669 has 131 migrations and lacks PR #1698's
   20261105233000..2; the merge 21a16288d has all 134.
2. `compareCatalog` replays `loadMigrationObjects(dir, applied)`: local migrations
   filtered to those the database recorded. Applied migrations missing from the
   directory were silently ignored, so the replay kept 20261019071000's
   `CREATE UNIQUE INDEX ..._key` and never saw 20261105233001's drop.
3. The comparison then reported the dropped index as missing and printed the
   restore-with-a-migration hint.

Repro (watched fail, then pass): replaying the live production catalog against
`git archive 59347a669 back-end/prisma/migrations` produced exactly the failing
line; against 21a16288d it produced zero problems (480 objects). The unit
regression copies the real 20261019071000 / 20261105233000..2 migrations, models
the production catalog, and asserts the pre-merge source reports a replay gap
(no `..._key` drift, replay hint only), the merged source is exact, and a lost
partial unique index is still drift.

Absence alone is not the signal: production also records 54 pre-squash names with
no directory (subsumed by `00000000000000_init`). Every one was recorded before
the baseline row (2026-07-07 00:46Z); the three PR #1698 migrations were recorded
after it. Duplicate check for a unique index: 0 of 4 queue rows carry a
`phoneBrowserTaskId`.

Deepest owned cause: the checker assumed its migrations source was at least as
new as the database, and the deploy lane bound it to the pre-merge source.
Related: 2026-06-27-stray-db-push-from-another-worktree-dropped-a-prod-column
(the drift this check exists to catch); this case is its false-positive relative.

Recurrence: the PR #1860 production lane (checkout 15a52d6e, merge cd0d894)
failed identically; its repair PR #1877 (lane binding only) was closed as
superseded by #1872 after its owner re-ran that lane from a 510655ee5 checkout
(`backend-probes` ✅ schema, replay source e34666de8).

## Solution

- `compareCatalog` now reads which applied migrations were recorded after the
  squashed baseline (`appliedAfterBaseline`). Any of those missing from the
  replay source is `unreplayedMigrations`; declared objects are then not compared
  and `replayGap` reports `unverified: the database recorded N applied
  migration(s) this migrations source lacks (...)` with `SCHEMA_REPLAY_HINT`,
  never the restore-with-a-migration hint. The CLI, smoke and hourly cron share it.
- `verifySchemaObjects` / the smoke accept `SCHEMA_MIGRATIONS_DIR`.
  `deploy_prod.production_migrations` extracts `back-end/prisma/migrations` at the
  Render live commit (the merge, or its verified descendant; one `git fetch origin
  main` for an unknown commit) and passes it to the smoke.
- Regressions: `schema-drift-check.test.ts` (unit) and
  `scripts/tests/deploy-prod.test.py` (structural gate) lane tests.
- Shipped in PR #1872 (merge 510655ee5). Production lane: `schema replay
  source: back-end/prisma/migrations at d9e2adf4a602 (Render live commit)`,
  `✅ schema migration-declared objects`, 15/15 healthy; the original command
  from main 932c9e087 also reports 15/15.
- Review follow-ups deferred (fail-loud, non-security): a prod row whose
  migration directory was later renamed would keep the check `unverified`; the
  hourly cron on an old replica during a Render migrate/cutover window could
  raise one `unverified` alert for a just-added migration.

10k-agent behavior: unchanged — one bounded catalog read per smoke run / hourly
tick, plus one `git archive` of the migrations directory per deploy.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded. The dispatch prescribed restoring the index with a new
migration; the read-only evidence showed that would reverse an intentional,
applied migration, so the checker and its source binding were fixed instead.

## Reusable lesson

Before restoring a "missing" migration-declared object, confirm the replay source contains every migration production recorded after the baseline; a source behind production cannot see later drops.
