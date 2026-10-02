---
id: 2026-10-01-seed-memory-ratchet-required-a-prior-benchmark-run
date: 2026-10-01
title: The seed memory ratchet failed on any deploy box that had not run a benchmark yet
surface: infra
component: deploy-gates
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/measure-seed-memory.sh only looked for a dump already present in .context/benchmarks/seed-cache
symptoms:
  - no cached prod dump in .context/benchmarks/seed-cache
  - deploy stage seed-memory-ratchet exit=1
tags:
  - deploy
  - seed-cache
sources:
  - PR #1364
repro: scripts/tests/seed-cache-decision.test.sh
status: fixed
---

## Problem

`/deploy` Step 4r (`measure-seed-memory.sh 5 0 0 --enforce-budget`) exited 1 in about a second on a Cursor Cloud VM with "no cached prod dump in .context/benchmarks/seed-cache". No seed run was measured.

## Diagnosis

The measurement restores a cached production dump into a throwaway source database and cold-seeds from it. It only looked for a dump that was already in the local seed cache. That cache is filled by `setup-db.sh` after a `/sync`, or by `run.sh` when an isolated benchmark pulls the canonical base fixture from the shared R2 cache. A cloud VM is set up by `cloud-init.sh`, which seeds the workspace database without publishing a dump, and Step 4r runs before any Step 6 benchmark. So the gate could never pass on a fresh box, although the reviewed canonical base fixture was available in R2 the whole time (30 MB, fetched in about a second).

## Solution

`scripts/lib/seed-cache.sh` gains `pull_canonical_benchmark_seed_dump`, exposed as `scripts/benchmark-seed-cache pull-canonical <schema> <cache-dir> <pg-major>`. It fetches the shared-cache token `run.sh` uses into the exact path `agents/benchmarks/local.py` restores, under the same per-dump lock, and writes both sidecars. A valid pair is reused without a fetch, and a miss leaves no partial pair. `measure-seed-memory.sh` calls it when no dump is cached, requesting the archive major that its restore path can read. `seed_cache_path.py --canonical-path` keeps the canonical path in one place.

`scripts/tests/seed-cache-decision.test.sh`, which runs as `/deploy` Step 4s, drives the real CLI through a fake `npx` and covers four cases: the pulled path matches what `local.py` restores, the fetched token matches `run.sh`'s, a valid pair is reused, and a miss leaves no lock or temp state behind. It also asserts that the measurement uses the pull. The suite was red without the pull (6 failures) and is green with it (38/38). The real gate then passed five fidelity-verified cold seeds, with a 170 MB maximum against the 230 MB budget.

## Human feedback

None recorded.

## Reusable lesson

A deploy gate that needs a fixture should fetch the same reviewed artifact the rest of the pipeline uses, not depend on some earlier step having happened to leave it on disk.
