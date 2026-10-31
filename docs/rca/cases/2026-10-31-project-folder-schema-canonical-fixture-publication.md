---
id: 2026-10-31-project-folder-schema-canonical-fixture-publication
date: 2026-10-31
title: Project folder schema changed the canonical fixture key without publishing its migrated seed
surface: harness
component: benchmark-seed-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: schema-keyed canonical fixture publication was omitted before the PR1648 smoke launch
symptoms:
  - "canonical base fixture is unavailable for this schema/revision"
  - "Benchmarks require the canonical base fixture; refusing a slow production cold-sync substitute."
  - "seed-dump-cache: The specified key does not exist."
tags:
  - projects
  - schema
  - canonical-seed
  - smoke
sources:
  - PR #1648
  - PR #1651
  - commit ea781111ef13ae3ca677e993c1a3aead61edeefa
repro: scripts/benchmark-seed-cache pull-canonical and scripts/run-predeploy-local
status: open
---

## Problem

Both original predeploy smoke launches stopped during setup, before any of the
nine selected tasks began. The coordinator incorrectly classified the canonical
fixture miss as unrelated to the project-folder change and waived the smoke lane.
The user permitted unrelated failures, provider credit exhaustion and AgentCard
issues; causality had not been established for this schema-dependent prerequisite.
Original services logs are retained under `.context/benchmarks/1793399773-221176-81671`
and `.context/benchmarks/1793399910-273968-44312` on the deployment machine.

## Diagnosis

The path is schema.prisma bytes -> schema SHA1 / PostgreSQL major / reviewed
fixture revision -> shared object lookup -> isolated restore -> smoke tasks.
PR1648 changed the schema from `dd7ca9461a0a8e7befd0216b931c2555c3cd5682`
to `186adbceb64981a45d9d471571b3aa00ab0ddbec`; the PostgreSQL major remained 16.
The old canonical object was present before the smoke failure (R2 LastModified
2026-10-30T17:51:29Z). The new key was missing in both original launch receipts.
At the follow-up audit its replacement existed, LastModified
2026-10-31T00:14:06Z, after the deployment. This receipt does not identify its
publisher; the follow-up must not claim credit for that prior upload.

The ordering follow-up demonstrated the same boundary independently: its new
schema key `a7c48e4f351c50bc4e00b11ffe55a7b104230d8b` had no object. The exact
command below failed with exit 1 and `The specified key does not exist` before
publication, then passed unchanged after migration/publication:

`bash scripts/benchmark-seed-cache pull-canonical back-end/prisma/schema.prisma .context/project-folders/followup/repro-cache 16`

The existing consumer correctly fails closed; no cold-sync fallback, cache-key
bypass or weaker benchmark assertion is warranted. This was an omitted
schema-change deliverable and incorrect skip decision, not a proven cache outage.
Archive searches used the literal error and `schema seed migration cache`.
The August pg-major fallback case is a relative, not this cause: both of these
original tokens used pg16, and this PR actually changed the schema hash.

The independent non-smoke audit reproduced the missing-lsof failure on both
base and merged runners before tests were scheduled. Quota refusals are explicit
provider responses. Six production exclusions are unchanged local-fixture-only
predicates, with the six cases passing locally. No folder-dependent browser or
local-device path was identified, but original Tilion rotate-IP state and device
registration history remain observational gaps; neither gets a speculative fix
or a claim of native execution success.

## Solution

Use the existing `scripts/migrate-canonical-seed.sh` publication workflow for
schema changes. The ordering migration was applied to the reviewed previous
fixture in a uniquely owned pgvector:pg16 container. The script validated 3,825
WhatsApp messages, a connected WhatsApp integration, 241 archived trajectory rows
and the named benchmark profile, dumped and restored into a second database,
compared all exact table counts, then uploaded and downloaded the new immutable
key and compared archive bytes. No production database or existing cache object
was overwritten. The same cache consumer then passed. Test-owned migration
container cleanup is part of the script's EXIT trap.

Regression protection already exists in the consumer and seed-cache decision /
canonical content suites; preserve those assertions. The operational failure
requires publishing the fixture, not adding a redundant fallback or changing task
definitions. The exact unchanged nine-task predeploy cohort was rerun from
2026-10-31T00:31:41Z through 00:50:03Z: seven passed and two were explicitly
skipped, with no task failure and no fixture startup failure. The wrapper exited
0 and labels itself passed; that is NOT a claim of nine passing tasks.

The first batch passed payment, child spawning, browser biometrics, browser
smoke, parallel calls, background messaging and chat. Claude Code was skipped
before agent creation because its fresh production-token lookup found no usable
credential. The final cached mass-agent root ran, but its declared evaluator
could not acquire a Codex compute token (pool exhausted or cooling down), so its
outcome remains unverified. Neither skip is reported as credit exhaustion or a
pass. These credential/evaluator paths are unchanged from the pre-folder base,
run outside project/folder writes, and use fresh token overlays rather than
credentials altered by this additive fixture migration. Both benchmark-owned
cleanup receipts are state=clean with started/completed cleanup confirmation;
cloud root provider cleanup was verified by the runner.

The cache publication defect is repaired at its owning boundary. This case
remains open only for the two unverified benchmark outcomes under the user's
unrelated-failure skip instruction. The full failing and terminal receipts remain
under .context/project-folders/followup and their native benchmark directories;
no evaluator, prompt, task definition or timeout was changed. An independent
reviewer also audited original PR1648 and the follow-up, with no remaining
code finding; PF-ORDER-ZOD-2 grounds only the new relative-move input schema.
Golden reference: not applicable (no approval-gated cache repair hunk).

## Human feedback

The user challenged the smoke skip, asked exactly which failures had been
permitted, and required checking whether this change caused any skipped issue
and fixing attributable issues in a follow-up PR. A missing schema-keyed fixture
must not be called unrelated without checking the schema change and publication.

## Reusable lesson

Publish and verify the reviewed fixture for every changed schema key before running smokes, and establish causality before applying an unrelated-failure override.
