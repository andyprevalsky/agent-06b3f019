---
id: 2026-11-09-native-system-database-name-exceeds-postgres-identity-limit
date: 2026-11-09
title: Long native benchmark IDs exceeded PostgreSQL ownership identity bounds
surface: harness
component: scripts/run.sh system PostgreSQL naming
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run.sh concatenated an unbounded native run ID into LOCAL_DB_NAME before PostgreSQL truncated it while the manifest retained the original spelling
symptoms:
  - provider verification database is not the owned local stack
  - exact payment ownership was not established
  - owned cloud evidence finalization failed
tags:
  - agentcard
  - benchmark
  - cleanup
  - postgres
sources:
  - commit a4ac03379bde803157bfb106b776f8043fab1c52
  - agent 7b09d979-4bb6-4b0e-a3d0-fd9595e7d1d8
  - plan:.context/agentcard-stability/owned-db-identity-rca/red-green.json
repro: agents/benchmarks/cloud_batch_cleanup_test.py native_system_database_identity_agrees and exact_database_proof regressions, auto-registered by benchmark.blackbox.py
status: fixed
---

## Problem

Partial11 round01's unchanged agent-payment-setup-resume ended native ERROR,
not PASS, after a sandbox 4396-cent CLEARED/CONSUMED payment. Its manifest database
name was 74 ASCII characters; services.log records PostgreSQL truncating it to
63. Ownership finalization then refused the longer identity. Preserve original
ERROR1/cancelled10, confirmed infra0/unclassified1 of11, and the separate invalid
pre-cleanup PASS card. Evidence: plan:.context/agentcard-stability/owned-db-identity-rca/runtime-evidence.json
and plan:.context/agentcard-e2e/stability-proof-20261109/partial11-round01-final-packet.json.

## Diagnosis

Run ID -> unbounded system-PG name -> createdb truncation -> runtime DSNs and
services.json retain the longer name -> strict SAFE_DATABASE guard rejects
before ownership SQL. Distinct late world suffixes also shared the truncated
prefix, so accepting an alias at the consumer would create a collision hazard.
The bad producer, rather than URL normalization or the strict guard, owns the bug.

Archive searches used the literal ownership error and database identity cleanup
symptoms. The relative case 2026-09-30-semantic-runner-loses-stack-database-port
loses an existing identity across shells; this producer violated its platform
bound first. No duplicate of this boundary was found.

## Solution

Commit a4ac03379 adds one canonical shell naming producer: short valid names
stay unchanged; long identities use a readable 46-character prefix plus an
underscore and16 hex characters hashing the full original identity. Create,
restore, drop, DSNs, manifest and retained WMH recording use the same bounded
name. Exact ownership guards and Docker/ordinary workspace behavior remain strict.

Identical causal command, old producer red versus repaired producer green:

```bash
agents/venv/bin/python -m pytest .context/agentcard-stability/owned-db-identity-rca/candidate/agents/benchmarks/cloud_batch_cleanup_test.py -k 'exact_database_proof or native_system_database_identity_agrees' -q
```

The receipt records exit1 ->0, two failures -> four passes, with the same test
hash. The tests capture external commands while executing native naming,
create/drop/restore/DSN/manifest fragments and the real ownership guard. They
cover63/64-character boundaries, late-suffix and punctuation distinctions,
determinism, short-name compatibility, and foreign ownership refusal before SQL.
Parent public checks report131 owning tests plus workspace-env, setup-db
concurrency and syntax PASS. Registration is the cloud_batch_cleanup_test
function discovery in agents/tests/blackbox/benchmark.blackbox.py; deploy's
agent blackbox gate owns that domain.

Native outcome evidence is distinct: the original setup task ERROR was followed
by the same unchanged task PASS on f61b9e939, canonical file
agents/benchmarks/runs/20261109_215643_d59324e5-d0c0-4924-9ed3-23a69d3f9ef8_agent-payment-setup-resume.json.
Rounds02..04 were separately qualified with exact resources and recordings.
Round05 later contained an unrelated signup timeout; neither this repair nor
those earlier passes establish the requested five-round stability proof.

The registered full-domain command is `cd agents && venv/bin/python scripts/run_blackbox_tests.py benchmark`. It was not rerun for this documentation-only task; recorded historical checks and their limits are stated above.

## Human feedback

Keep strict ownership checks; fix the identity producer, hash the complete owner,
and preserve original failures. Do not substitute a shorter run ID, truncate an
alias at cleanup, change task criteria, or credit a completed stage as PASS.

## Reusable lesson

Bound and disambiguate resource names before platform truncation can split runtime and ownership identities.
