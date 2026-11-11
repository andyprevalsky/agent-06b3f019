---
id: 2026-11-08-coverage-shards-shared-one-local-benchmark-hub-index
date: 2026-11-08
title: Concurrent backend coverage shards shared one local Benchmark Hub index across separate databases
surface: back-end
component: backend-coverage-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/benchmarkHubStorage.ts LOCAL_HUB_ROOT was one <repo>/.context/benchmark-hub for every process, while withIndexLock (benchmarkHubStore.ts) is a pg_advisory_xact_lock scoped to each shard's own database
symptoms:
  - "benchmark-share blackbox: scoped anonymous transcript visible"
  - "fixture cleanup failed: 404"
  - "DELETE /api/benchmarks/runs/<id> -> 404"
  - "backend-coverage-blackbox/blackbox:benchmark-share"
tags:
  - benchmark-hub
  - coverage
  - sharding
  - race
  - deploy-gate
sources:
  - commit 8edce49e3b4ab656967e9b31fdbd62046b6a9aae (failed source)
  - commit 617bb467fd75e3770d686e17aab9e519bded0f37 (PR #1784 originating merge)
  - PR #1784 (deploy gate GitHub Actions run 42516999277)
repro: back-end/src/tests/unit/benchmark-hub-storage-isolated.test.ts (BENCHMARK_HUB_LOCAL_DIR gives each local Hub process its own index); back-end/src/tests/unit/coverage-script.part2.test.ts (per-shard BENCHMARK_HUB_LOCAL_DIR export)
status: fixed
---

## Problem

The `/deploy` backend-coverage-blackbox gate (Blacksmith run 42516999277,
source 8edce49e3) failed `blackbox:benchmark-share` in shard 1. The domain log
reads `benchmark-share blackbox: scoped anonymous transcript visible` followed
by `fixture cleanup failed: 404`: the upload (201) and the shared-view
assertions passed, then the internal `DELETE /api/benchmarks/runs/85414e81-…`
returned 404 two milliseconds into the request, 26 ms after the upload.

`back-end/coverage/server-shard1.log:2855` logs shard 1 storing the
benchmark-share run at 19:50:53.651Z, and `back-end/coverage/server-shard2.log`
shows shard 2 (the benchmarks-hub pipeline poller) storing a run roughly every
110 ms throughout (lines 817-1154), including `hub-23b2646d-…` at the same
19:50:53.651Z (line 1667). The CI logs show the overlapping writers; the
read-before/rename-after interleaving itself is inferred and was reproduced
locally below.

## Diagnosis

1. `back-end/scripts/run-coverage-sharded.sh` runs blackbox shards 1 and 2 and
   the unit pass concurrently from one checkout. Each gets its own database
   (`_s1`, `_s2`, `_s0`), lock, artifacts, `USER_UI_STORAGE_LOCAL_DIR` and
   `DISPLAY_STORAGE_LOCAL_DIR` (`run-coverage.sh`), but no Benchmark Hub dir.
2. In local mode `benchmarkHubStorage.ts` writes every key under the fixed
   `LOCAL_HUB_ROOT = <repo>/.context/benchmark-hub`, so all three processes
   read-modify-write the same `index.json`.
3. `withIndexLock` serializes index mutations with
   `pg_advisory_xact_lock(hashtext(INDEX_LOCK_KEY))`. Advisory locks are
   per database, so the shards never exclude each other.
4. Shard 2's upload read the index before shard 1's write and renamed its copy
   over it afterwards, dropping shard 1's run; `deleteRun` then found no row
   and the route returned 404.

Local reproduction (scratch harness preserved with the deploy evidence:
`race.ts`/`run.sh`): two processes against the real `putRun`/`deleteRun`,
local Postgres only, `BENCHMARK_HUB_STORAGE=local`; one uploads then deletes
300 runs while the other re-uploads continuously for 45 s.

- shared dir, separate databases: `deletes=300 missing=152` (bug)
- per-process dirs, separate databases: `deletes=300 missing=0`
- shared dir, same database: `deletes=300 missing=0` (lock works within one DB)

The originating box's independent repro gave 214/935, 0/1885 and 0/575 for the
same three arms.

Deepest owned cause: the coverage runner made per-shard copies of every other
local store but left one process-global path whose only exclusion is a
database-scoped lock.

## Solution

`LOCAL_HUB_ROOT` now honours `BENCHMARK_HUB_LOCAL_DIR` (default unchanged), and
`run-coverage.sh` exports
`BENCHMARK_HUB_LOCAL_DIR="${BENCHMARK_HUB_LOCAL_DIR:-$ROOT_DIR/.context/benchmark-hub$SHARD_SUFFIX}"`
beside the other per-shard stores, so shards, the unit pass and its probe pass
each own an index whose writers share one database lock. Isolated benchmark
stacks still nest under `isolated-runs/<id>`. R2/production and normal dev
paths are unchanged (variable unset in both).

Regressions (both run in the backend unit suite of every `/deploy` coverage
gate, and both failed on the unfixed source):
`benchmark-hub-storage-isolated.test.ts` spawns two local-mode processes with
different `BENCHMARK_HUB_LOCAL_DIR` values and requires each index in its own
directory (pre-fix: ENOENT; both wrote the repo default and the second
overwrote the first). `coverage-script.part2.test.ts` evaluates the harness
export for `-shard1/-shard2/-units/-units-probe/""` and an inherited override.
The storage test proves the variable is honoured (pre-fix it wrote the real
repo `.context/benchmark-hub/index.json`); the harness test is the deterministic
guard that shards get distinct directories. The race itself is probabilistic:
the only outcome check is the unchanged `benchmark-share` blackbox in the
sharded coverage gate.

The standalone `run-blackbox-tests.sh` now also defaults
`BENCHMARK_HUB_LOCAL_DIR` to its per-run artifact directory, matching its
user-ui and display stores. Remaining limitation: an unsharded `run-coverage.sh`
or the dev `scripts/run.sh` stack still uses the default directory, so two such
stacks with different databases on one checkout can still race; neither runs
concurrently on the `/deploy` coverage path.

10k-agent behaviour: test-harness only; no runtime path, channel, query or lock
changes in production.

Golden-reference check: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When a test runner parallelizes processes with separate databases, give every
shared on-disk store its own per-process path, because database-scoped locks do
not exclude writers in other databases.


## Recurrence — November 10, inherited and unsharded Hub paths

During coding-agent rename validation, the full backend coverage run passed
391 unit files and 251 of 253 blackbox domains. `benchmark-share` failed with
`Hub directory /home/boxes/rose/.context/benchmark-hub is the shared worktree default`.
The other failure was a stale running server's old title-length limit during
parallel source edits, resolved by a fresh server on the frozen source.

The previous isolation fix preserved an inherited Hub path and still assigned
unsharded coverage to the shared default. The permanent harness regression had
encoded those exceptions as expected behavior, so it could not enforce the
stronger run-scoped storage invariant checked by the blackbox.

`run-coverage.sh` now exports a unique shard/timestamp/PID path for every
invocation before launching its children, even with an inherited developer
path. The developer's shared Hub remains intact; only the test harness's path
changes. Backend and blackbox consume the same exported directory.

Executed unchanged permanent regression:
`cd back-end && node --import tsx src/tests/unit/coverage-script.part2.test.ts`.
Before: exit 1, actual `/repo/.context/benchmark-hub-shard1` failed the unique
run-path assertion. After: exit 0, including all four lifecycle checks in
17.274s. It checks unsharded runs, repeat invocations, shard/unit/probe variants
and inherited shared/custom paths. Shell syntax, ESLint and Prettier passed.
The parent reruns full sharded coverage; a partial rerun or merged C8 raw data
alone is not represented as a newly passing full gate.

No production query/channel/lock behavior changes; one directory per test run.
No new human correction was recorded for this harness recurrence.


## Final combined validation — November 10

Source: commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265. Full frontend coverage passed 324 files,
4,732 tests passed and one skipped; line coverage 89.69%, branch coverage
81.87%. Full backend failed-first sharded coverage passed all 253 selected
blackbox domains and all 391 unit files (including the separately scheduled
browser-performance probe), with line/statement coverage 90.26%, functions
93.13% and branches 82.95%. Configured thresholds passed; backend teardown
checks also passed. The coverage runner intentionally excludes the separate
live credential-health domain. No production rollout or live account probe
is implied by these local validation results.

Commands: `cd front-end && npm run test:coverage`;
`cd back-end && bash scripts/run-coverage-sharded.sh --failed-first 2 && bash ../scripts/tests/blackbox-backend-teardown.test.sh`.
