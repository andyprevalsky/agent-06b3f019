---
id: 2026-10-31-r138-it32-canonical-seed-schema-key-miss
date: 2026-10-31
title: It32 new-schema canonical seed key was unavailable before task admission
surface: harness
component: canonical seed cache / campaign preflight
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: canonical full GET for the source71548b68 PG15 schema key failed before any child task was admitted
symptoms:
  - It32 ended after 44 seconds with all 20 jobs cancelled and zero attempts
  - configured seed readers reported that the specified key did not exist
  - native strip-types fallback separately reported R2 not configured
tags:
  - canonical-seed
  - schema-migration
  - pg15
  - preflight
  - r138
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - commit 158efd7c536cc285a68a55ff000c3e55867e0abc
  - benchmark run campaign-20261031-041209-2919885
repro: original It32 seed-preflight receipt and offline exact seed-dump-cache runner comparison
status: mitigated
---

## Problem

It32 on source `71548b68172df23752d1ec866d7a8395baa3366c` stopped at the canonical seed full-GET gate, before task admission. Its original summary remains failed: all 20 jobs were cancelled with no attempts. This is not a task/model failure or a benchmark pass.

## Diagnosis

The exact schema bytes select
`a7c48e4f351c50bc4e00b11ffe55a7b104230d8b-pg15-victoria-prod-sync-v1-whatsapp-v2`.
The prior source158 key starts `68699529995f06d1aea04680f7164a71cbc08f1f`.
The identity helper and base revision did not change; Agent.speed and project-folder schema additions changed the schema hash. The preflight correctly refused the unavailable new artifact instead of using an old-schema seed or production cold sync.

The original GET log repeats missing-key, unconfigured fallback, missing-key messages. An offline exact-CLI replay with dummy credentials and intercepted S3 calls separates them: tsx loads the fixture `.env` and reaches its mocked GET; Node22 strip-types has no `__dirname`, so the caught `.env` load failure leads to “R2 not configured” without an S3 call. That fallback message does not establish that the configured readers lacked credentials. The original log does not independently establish absence across every bucket or endpoint.

The prior poisoned-canonical-seed case and its schema-only refresh describe the applicable preservation contract. The seed-preflight extraction case concerns test ownership, not this actual cache miss. Original campaign custody was checked against 203 regular-file hashes without mismatch.

## Solution

No runtime patch was made. Following the standing canonical-seed procedure, the owner restored the reviewed old PG15 fixture into an isolated PG15 container and applied the five checked-in migrations: trajectory trigger lock avoidance, user-pause replay index, Agent.speed, project folders, and folder ordering. The three latter files implement the Prisma schema delta; the former two preserve current runtime SQL behavior.

The supplied owner/root receipts report 96 old tables and 34,824 old rows with identical old-column stream hashes/counts after migration and dump/restore round-trip. Old column/FK metadata and new schema checks passed. Both canonical validations retained 3,825 WhatsApp messages, 241 archived trajectory rows across three runs, and the required profile/integration. Old/current/round-trip Prisma shape comparisons were empty. Root verified 131 supplied checksums and the complete new dump.

The old dump SHA256 is `aab319653964c8499eabb386a031384f890c94f0647f6d597c9704cb6d6f55f3` (31,141,545 bytes). The prepared new dump is `eb50d88bb9b15ea93f3a56d722d710bdc0cb19dbec77054130a3dc1aa57957c3` (31,144,906 bytes), bound to preparation manifest `4245b47ddb011676c355a25ecde07ec3b041268b9577568a308facec834a00a4` and image `pgvector/pgvector@sha256:47af0b65960b14f1c6945aa4ccae37836c632e9a6fe0eea9160936e616e5b2e9`.

The subsequent original publication receipt records a fresh new-key HEAD exit3 (absent), standard PUT exit0, and full GET exit0. The read-back is 31,144,906 bytes with the same `eb50d88b…` SHA256 as the prepared input; root verified the full packet. The old key and source715 bytes are unchanged. This observed HEAD/PUT/GET sequence is not an atomic conditional-write guarantee. The raw receipt's `existing_object_not_overwritten=false` is preserved: that field is defined as the inverse of publication being performed, not evidence of an observed overwrite.

Status is mitigated for the demonstrated missing-artifact boundary. The subsequent It33 normal campaign seed preflight completed its full GET with exit0 and 31,144,906 bytes, SHA256 `eb50d88bb9b15ea93f3a56d722d710bdc0cb19dbec77054130a3dc1aa57957c3`. Its recorded interval was epoch1793421072.3556857–1793421073.8520935 (about1.50 seconds); root verified original proof `e592e5e6742ef4b9f9cc9a46aadbd5d9f6da11b824b957d17bfd46df39a136da`. This establishes repaired normal fixture retrieval before canary admission, not task success or guest source provenance. No warm snapshot change, original campaign repair, or resource-release result follows; isolated-container cleanup was authorized separately and is not claimed complete here.

## Human feedback

None specific. The migration and evidence requirements above are technical scope from the coordinator and existing repository policy.

## Reusable lesson

A schema merge changes the canonical fixture key even when the seed revision is unchanged. Prepare and validate that exact PG-major artifact before admission; distinguish a runner's missing configuration from another runner's genuine cache response, and preserve the reviewed rows across schema migration.
