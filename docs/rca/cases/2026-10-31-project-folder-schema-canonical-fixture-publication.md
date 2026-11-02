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


### November 2, 2026 recurrence — comment-only schema key

Release 6ff4bcae6d0da979e8c6feb24c011f2698935108 changed the raw schema key from
main a3c4929f3's a7c48e4f351c50bc4e00b11ffe55a7b104230d8b to
049dc6b64d546bc8969fc864fcaf891ca82568d0 through projectId documentation alone.
The complete datamodel was identical after removing full-line comments, and the
actual Prisma migrate diff was empty. Both smoke and AgentCard native startups
failed before task creation; target cache HEAD returned 3 and GET NoSuchKey,
while the reviewed main fixture was present. Gate: INTRODUCED against main;
6ff itself shares the same key with its a959 parent.

The reviewed main archive SHA256
67d45c14e5fc949b76f44cd28bee9fa7ef494562cd73c1d6f1c2d710451a8d8e
was restored twice in exact-owned PostgreSQL16 databases. Both native content
validations passed, all97 table counts matched, and only the definitely absent
new immutable key was published. The identical failed canonical consumer then
passed and returned byte-identical data. Both databases were dropped. Evidence:
.context/deploy-boxes-default-20261102/seed-rca/{report.md,operational-recovery.log}.
Independent review found and corrected cleanup ownership/publication ordering
before execution. This repairs the prerequisite, not yet the pending complete
smoke or AgentCard outcomes; no cold sync, migration, timeout or benchmark edit.


### November 2, 2026 missing-lsof recurrence — PR1662

Occurrence 761cdfb859e54c82a65900dd42e18a77 repeats the environment prerequisite
noted in this case's deployment followup. The full original native log (SHA256
fb091ee4e1bb28d7487b0319a7df929cbf3438929f1b488f82121f2b0c8ac955) names exactly
three failed cleanup assertions, with 123 of 124 domains passing. The two earlier
observer/listener checks and the reparented portless worker check all fail when
lsof is unavailable. This is not a recurrence of the main planner-data defect.

The worker's original post-run, pre-install probe recorded lsof ENOENT, and its
package state was not installed. A private actual-process fixture extracted the
unchanged owning functions and tests from main
6f3f53201faac3a3e70de099e7c211cee6770fad and PR1662 frozen
 e99c91f55b9444f01a90bd4e8efc18315faeb51b. Both revisions failed all three exact
assertions with lsof absent; both passed the identical assertions with only
lsof added to the fixture PATH. Production code, test definitions, coverage
runners, run-deploy-stage and cloud-init.sh are byte-identical at those boundaries.
Gate: NOT_INTRODUCED. The original command environment was not captured; the
later native probe and controlled reproduction are distinguished from an
in-run environment snapshot.

The deploy owner authorized lsof installation on the recorded worker; apt
installed 4.95.0-1build3 with zero removals and a clean source tree afterward.
The existing cloud-init.sh already declares and installs this prerequisite.
No application change or weaker cleanup assertion is needed. The original
aggregate remains UNVERIFIED, exit 1; full coverage has not been reexecuted by
this investigator. Parent retains deployment and aggregate-verification
ownership. Detailed proof is retained in /var/tmp/rca761-agents-coverage.

## Human feedback

The user challenged the smoke skip, asked exactly which failures had been
permitted, and required checking whether this change caused any skipped issue
and fixing attributable issues in a follow-up PR. A missing schema-keyed fixture
must not be called unrelated without checking the schema change and publication.

## Reusable lesson

Publish and verify the reviewed fixture for every changed schema key before running smokes, and establish causality before applying an unrelated-failure override.


### November 2, 2026 PR1662 cloud/PG15 integration prerequisite

The new staged deploy integration made cloud smoke mandatory where base
bf92cbd98ab436af20f9a8d647c32e748c67e93a documented local smoke by default.
The earlier comment-only rekey repair above published PG16 only; the matching
PG15 key remained absent. The schema SHA1 was already 049dc6b64d546bc8969fc864fcaf891ca82568d0
on base6f3f53201, bf92cbd98 and frozen7be0644bb164763af1526ead7b426e2d5e909f4a.
Gate: INTRODUCED applies to omitted preparation of the newly mandatory cloud
fixture, not to a newly authored schema change. Independent review confirmed
that scope in /var/tmp/pr1662-pg15-seed-review.json.

Native campaign f9d1709a9c89c45ae901d7684e1a0dd9d4e6b046a8827fad4531ac41f5d8161b
stopped after r001-j0013 failed its PG15 seed preflight. The fixed-total 1/17
infrastructure predicate then cancelled the other members; no task assertion
was exercised. The target native HEAD returned3; reviewed predecessor
 a7c48e4f351c50bc4e00b11ffe55a7b104230d8b-pg15-victoria-prod-sync-v1-whatsapp-v2
returned0 and downloaded an authentic pg_dump15.19 archive.

The unchanged native migrate-canonical-seed.sh ran in a private fixture with an
owned pgvector:pg15 container. Prisma reported an empty schema migration. Both
restores passed the canonical validator (3825 WhatsApp messages, connected
integration,241 archived trajectory rows across3 roots, and named profile), all
table counts matched, and the absent target was uploaded and downloaded with
byte-identical verification. Final PG15 archive:31144906 bytes, SHA256
 e1439aed8adda5cca62f5c1e7834c24b756fe65a75efb0362700a0fc48c0e275.

The unchanged native cloudbench-seed-get.sh now exits0 in1.24s with that same
SHA256; HEAD changed3 to0. The publication process exited0 and exact container
canonical-seed-pg15-3210543 was confirmed absent after its cleanup trap. All16
original fleet cleanup receipts show empty clone IDs and verified provider
release; the central viewer retains its explicit native owner transfer policy.
No task definitions, thresholds, schema, provider settings or parent source
changed. The full17-task smoke remains UNVERIFIED until the deploy owner reruns
it. Evidence: /var/tmp/pr1662-pg15-seed-repair/report.json, publication.log,
native-consumer-receipt.json and original-campaign-cleanup.json.
