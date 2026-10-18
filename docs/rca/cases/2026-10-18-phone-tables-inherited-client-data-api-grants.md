---
id: 2026-10-18-phone-tables-inherited-client-data-api-grants
date: 2026-10-18
title: Phone migrations inherited direct client CRUD under legacy Supabase grants
surface: back-end
component: iphone database privileges
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Phone table creation omitted explicit client ACL revocation and row level security
symptoms:
  - Client CRUD exposed under legacy default grants
  - anon and authenticated can select private phone tables without HTTP ownership checks
tags:
  - phone
  - security
  - rls
  - migrations
sources:
  - commit 67b9c92806a44404020c57f97e15706e93d207f3
  - plan:.context/phone-harness/iphone-rls-red.log
  - plan:.context/phone-harness/iphone-rls-green.log
repro: back-end/src/tests/blackbox/iphone-rls.blackbox.ts
status: fixed
---

## Problem

Read-only inspection of explicit loopback victoria found all four IPhone tables
with RLS disabled and null ACLs, but no anon/authenticated roles or default ACLs.
That database does NOT prove current client exposure, and production was neither
queried nor modified. The actual migration files nevertheless omitted defenses
against legacy Supabase projects' documented default client grants.

## Diagnosis

Archive searches: new tables row level security default privileges anon; Supabase
authenticated direct database grants. Existing JWT and preview-endpoint cases are
relatives, not this database boundary. Official reference:
https://supabase.com/docs/guides/api/securing-your-api documents legacy grants and
separate ACL/RLS controls; newer projects need not inherit those defaults.

The registered normal blackbox creates an exact-owned loopback database, applies
real phone migrations after isolated legacy default grants, inserts synthetic
private rows, and executes actual role-switched SQL with a same-user JWT subject.
Before the fix all 32 anon/authenticated SELECT/INSERT/UPDATE/DELETE permission
probes succeeded. SELECT reaches actual private rows; zero-row INSERT probes
exercise privileges, while UPDATE/DELETE execute normally. No mock policy or
production exposure is inferred. Missing pg module and initial invocation-path
errors were setup errors, not the causal red; the final red log records the
actual PostgreSQL assertion and 0/32 denied.

## Solution

Migration 20261018212000_iphone_private_acl enables RLS without client policies,
revokes PUBLIC and existing anon/authenticated table/associated-sequence grants,
and preserves table-owner/privileged backend access. Missing local Supabase roles
are guarded. No schema-wide grants, defaults, existing roles, Prisma fields,
HTTP services or Zod schemas change. This reuses PostgreSQL default-deny and
removes inherited access rather than duplicating HTTP ownership policies in SQL.

## Verification

Identical red/green command from back-end:
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria node --import tsx src/tests/blackbox/run.ts iphone-rls`.
Red: actual SQL reports all 32 probes exposed, exit 1. Green: 1/1 normal runner
domain passes; 32 client CRUD denials, all four RLS flags, no policies, privileged
owner insert/read/update/delete and cascade preserved. The test always drops only
its owned database; transactional role creation rolls back, restoring roles.
Normal *.blackbox.ts auto-discovery registers the test without new infrastructure.
Existing migration-drift structural gate now also guards phone RLS/ACL migration
presence; ESLint, Prettier and migration drift pass. Logs are under
.context/phone-harness/iphone-rls-{red,green,drift}.log.

This is a migration-boundary security fix, not a claim of a production incident
or a live phone benchmark pass. Per-command cost is unchanged at 10k agents:
PostgreSQL ACL checks, no application queries, polling, channels or fan-in.
The privileged HTTP regression suites remain owned by the other backend worker.

Canonical seed warning: Prisma schema hash is unchanged; db push cannot install
RLS. The old private canonical dump therefore needs this SQL applied explicitly
before any next live benchmark, or selection of the separately validated private
RLS-updated dump. Never overwrite/publish the shared cache under the same key.
A new private PG16 artifact is now available at
`.context/phone-harness/canonical-seed/71351c10420fff9aa69b1a920a1ff3258759156f-pg16-victoria-prod-sync-v1-whatsapp-v2-iphone-rls-v1.dump`,
SHA256 `78f72f94942efb1df72e11ebb5561c45fa6096f8c4ff858eb44a4ff9de2189b4`.
Only this migration was applied to an isolated restoration of the prior dump;
all 77 table row fingerprints match the original and roundtrip (73 prior tables,
four empty phone tables). Restored phone RLS flags are all true. WhatsApp remains
3825 messages plus its connected integration. Matching original-compatible
.cachetoken/.schemahash sidecars and rls-provenance.json accompany the artifact.
Initial fingerprint SQL quoting failed; it was corrected and all three datasets
were recomputed against a separately restored original, not empty failed output.
All three exact-owned databases were dropped. No shared cache was published.
After parent review, select the new artifact with BENCHMARK_SEED_DUMP before the
next benchmark. Parent owns artifact review and archive reindex; INDEX remains
intentionally unchanged in this task.

## Human feedback

User required executed local role semantics before any security claim, no
production access, no active-worker/shared DB interruption, no commits or source
changes outside migration/test ownership, and explicit canonical-seed handoff.
Freedom and protected instructions remain untouched. No real credentials used.

## Reusable lesson

Declare client ACL and RLS defenses in private-table migrations independently of HTTP ownership and ciphertext storage.
