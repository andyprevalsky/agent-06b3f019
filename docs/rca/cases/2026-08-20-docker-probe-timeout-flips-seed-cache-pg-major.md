---
id: 2026-08-20-docker-probe-timeout-flips-seed-cache-pg-major
date: 2026-08-20
title: A busy Docker daemon silently downgrades an isolated benchmark to system Postgres, which flips the seed-cache pg major and makes the canonical base fixture unfindable
surface: harness
component: benchmark-seed-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run.sh:936 _SEED_DUMP_CLIENT_MAJOR — it derives the seed-cache token's pg major from whichever Postgres the run happened to fall back to, so a transient Docker probe miss silently changes the identity of the artifact being looked up
symptoms:
  - "canonical base fixture is unavailable for this schema/revision"
  - "Benchmarks require the canonical base fixture; refusing a slow production cold-sync substitute."
  - "run.sh exited early with code 1"
  - "System Postgres already running on port 5432"
tags:
  - benchmarks
  - seed-cache
  - docker
  - postgres
  - deploy
sources:
  - commit e7dd96c1f
repro: not yet reduced to an automated test — see Reusable lesson
status: open
---

## Problem

`scripts/run-predeploy-local` refused to boot during `/deploy`:

```
🐘 System Postgres already running on port 5432
🔎 Checking shared seed-dump cache (cc104a3f…-pg18-victoria-prod-sync-v1-whatsapp-v2)...
   ℹ️ canonical base fixture is unavailable for this schema/revision
❌ Benchmarks require the canonical base fixture; refusing a slow production cold-sync substitute.
RuntimeError: run.sh exited early with code 1
```

The identical command succeeded ~6 minutes later with no code change, resolving
`…-pg16-…` instead and restoring the fixture immediately.

## Diagnosis

The branch changes no `back-end/prisma/schema.prisma`, so the schema half of the
token (`cc104a3f…`) is main's and was never in question. Probing the cache
directly proved the artifact exists — under a different name:

```
pg16: PRESENT (30M)
pg18: MISSING
```

Causal chain:

1. `docker_available_for_workspace_db` (`scripts/run.sh:124`) is
   `docker_info_quick || <container already in docker ps>`. For an **isolated**
   benchmark the DB container does not exist yet, so the name check cannot
   rescue it — the decision rests entirely on `docker_info_quick` meeting its
   startup budget.
2. This deploy ran coverage, semantic, an E2B sandbox smoke and a live
   browser-provider ladder concurrently. Docker Desktop was busy enough that
   `docker_info_quick` missed its budget, so `DOCKER_OK=false`.
3. That falls through to the "System Postgres fallback (no Docker)" branch
   (`scripts/run.sh:794`), even though Docker was in fact healthy.
4. `_SEED_DUMP_CLIENT_MAJOR` (`scripts/run.sh:936`) is `16` when the pinned
   `postgres:16-alpine` container writes the archive, but on the system-PG path
   it reads the host client — PostgreSQL **18.0** on this Mac.
5. The token therefore becomes `…-pg18-…`, an artifact nobody has ever
   published, and `BENCHMARK_REQUIRE_SEED_DUMP=1` correctly refuses to cold-sync
   a substitute — so the whole gate hard-fails.

The pg-major key itself is deliberate and correct in one direction: it exists so
a newer client's archive cannot be handed to an older `pg_restore` that cannot
read it. The defect is that it is applied as an **equality** match. `pg_restore`
is backward compatible — an 18 client reads a 16 archive — so the pg16 artifact
sitting in the cache was perfectly usable by the very run that declared it
missing.

Deepest owned cause: the fixture's identity is derived from an incidental
property of the host (which Postgres this boot happened to land on) rather than
from the artifact contract (which clients can read it). A transient,
unrelated resource condition silently repoints a content-addressed lookup.

## Solution

Not yet implemented — captured deliberately rather than patched mid-deploy,
because the seed-cache decision path is covered by its own gated suites
(`seed-cache-decision`, `seed-dump-toolchain`) that must be re-run with it.

Two changes, in order of value:

1. **Make the pg-major key a floor, not an equality.** A run with client major
   N should accept any published artifact whose major is ≤ N, preferring the
   highest available. That matches `pg_restore`'s actual compatibility contract
   and makes the existing pg16 artifact serve every host, which kills the whole
   class rather than this instance.
2. **Do not let a probe timeout change artifact identity.** If Docker is
   genuinely available but merely slow, the isolated benchmark should wait or
   retry rather than silently switching database backends — the fallback exists
   for Cloud VMs where Docker cannot create containers at all, not for a busy
   Docker Desktop.

Workaround used for this deploy: re-run once the machine is quiet so
`docker_info_quick` passes and the pinned pg16 container path is taken.

10k-agent behavior: unchanged; this is local benchmark provisioning with no
per-agent cost.

## Human feedback

The user's instruction throughout was "fix all issues then /deploy" and later
"finish" — i.e. drive the deploy to completion rather than stopping at each
environmental obstacle. This case is the durable capture required by CLAUDE.md
rule 1b for a defect too large to safely land inside the deploy that found it.

## Reusable lesson

Key a cache by what makes an artifact USABLE, not by an incidental property of
the machine that happens to be looking it up — and never let an unrelated
resource timeout silently change which artifact a run asks for.
