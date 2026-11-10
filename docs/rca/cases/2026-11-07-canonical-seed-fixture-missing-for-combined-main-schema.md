---
id: 2026-11-07-canonical-seed-fixture-missing-for-combined-main-schema
date: 2026-11-07
title: seed-memory-ratchet and every cloud smoke task failed because two schema PRs merged to main without a canonical seed fixture for their combined schema
surface: infra
component: canonical-seed-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: PR #1721 (Agent.lastUserMessageAt) and PR #1750 (Integration usage columns) each edited back-end/prisma/schema.prisma and merged separately, so main's combined schema hashed to a canonical seed key that nobody had published for pg16
symptoms:
  - "canonical base fixture is unavailable in the shared cache: 837587eba5fb5d6e8b5908b4f0357cdc6556fde0-pg16-victoria-prod-sync-v1-whatsapp-v2"
  - "seed-dump-cache: The specified key does not exist."
  - "no cached prod dump in .context/benchmarks/seed-cache"
  - "INFRA STOP: 1/15 scheduled jobs are confirmed infrastructure failures"
tags:
  - seed-memory-ratchet
  - cloud-smoke
  - schema-change
  - canonical-seed
  - infra-stop
sources:
  - PR #1751 deploy gates seed-memory-ratchet and smoke at source 3288396770
  - memory:schema-change-needs-canonical-seed-republish
repro: bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget
status: fixed
---

## Problem

After PR #1751 merged main (which carried PR #1721 and #1750), the `seed-memory-ratchet` gate and all 15 cloud smoke
jobs failed at startup with `canonical base fixture is unavailable in the shared cache: 837587eb...-pg16-victoria-prod-sync-v1-whatsapp-v2`.
The smoke campaign INFRA-stopped within a minute (1/15 >= 5%). PR #1751 does not edit `schema.prisma`; main itself had
the broken key.

## Diagnosis

The canonical seed key is `<sha1(schema.prisma)>-pg<M>-victoria-prod-sync-v1-whatsapp-v2`. Each schema PR republishes
the key for its own schema, but two such PRs merged separately produce a third schema whose key nobody published. pg15
was already published when checked; pg16 was absent. The only difference to the last published pg16 base (16a0373942) was
one added column, `Agent.lastUserMessageAt`.

## Solution

`bash scripts/migrate-canonical-seed.sh 16 <base-schema.prisma> back-end/prisma/migrations/20261106120000_agent_last_user_message_at/migration.sql`
migrated the last published fixture, validated it, round-tripped the dump and published it in 21.9 s (31,149,660
bytes; WhatsApp history preserved: 3,825 messages, 241 archived trajectory rows). An independent restore of the base and
the published object showed 99 tables and 34,824 rows in both, with the new columns present, for pg15 and pg16. Main
changed the schema again while the deploy ran and another thread published that key (checked with `seed-dump-cache.ts
head` before rerunning).

## Human feedback

None.

## Reusable lesson

Before a long gate sweep, check `seed-dump-cache.ts head` for the current schema key on pg15 and pg16; after every sync
that brings a schema change, recheck. A main-branch check that fails when the current schema's canonical keys are
absent would catch the combination at merge time.
