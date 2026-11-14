---
id: 2026-10-27-fresh-volume-depth1-fetch-transferred-whole-tree
date: 2026-10-27
title: Fresh REAL volumes fetched the whole 3.3 GB tree from GitHub (~230 s per copy) because nothing seeded a negotiation base
surface: infra
component: cloudbench-fetch-ref
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/cloudbench-fetch-ref.sh fresh-volume branch — `git fetch --depth=1 origin <sha>` into an empty repository has no HEAD to negotiate from, and the warm image carries dependencies but no Git objects
symptoms:
  - git-fetch 98-307 s (median ~232 s) on every REAL fresh-volume copy despite a warm dependency snapshot
  - "[cloudbench] git-fetch" dominating startup
tags:
  - fresh-volume
  - git-fetch
  - warm-image
  - startup-latency
  - descend
sources:
  - benchmark run descend-polar k2 iteration 2 (cluster I11, 20/20 copies, source b08532144)
  - commit b08532144 (descend/polar-k3-recovery, measured source)
  - commit b98835cbf959e7e944981c79738df86dd0f22ee2 (unintegrated native-import candidate)
  - agent ph74rex3pescaywbxyjn3njr158h3pp9 (independent safety review)
repro: scripts/tests/cloudbench-fetch-ref.test.sh (image seed block); agents/benchmarks/cloudbench_image_build_test.py::test_cloudbench_image_build_stages_an_exact_git_seed_and_removes_it
status: mitigated
---

## Problem

All 20 REAL copies of Polar k2 iteration 2 spent 98–307 s (median ~232 s)
fetching the exact source commit `b08532144`. That happened even though their
dependencies came from the warm image.

## Diagnosis

`cloudbench-fetch-ref.sh` initializes an empty repository on a fresh volume
and runs `git fetch --depth=1 origin <sha>`. With no local commit there is
nothing to negotiate from, so GitHub sends the whole tree.

At `b08532144` that tree is 3.26 GB, of which 2.75 GB is
`agents/benchmarks/history` ledgers. The warm image does not help:
`Dockerfile.cloudbench-warm` bakes only dependencies, and `.dockerignore`
excludes `.git`.

Measured from a devbox with the same command, exact SHA:

| Fetch | Time | Pack |
|---|---|---|
| Unseeded | 236 s | 330 MB |
| Seeded with a 2026-10-13 base offered as a negotiation "have" | 86 s | 36 MB |

The unseeded figure matches the guests. At about 1.4 MB/s, GitHub's pack
generation dominates, not bandwidth.

Rejected: dropping the archived span shards from the primary.
`span_history` reads every `span_durations.*.jsonl`, so that would change what
guests compute.

## Solution

- **Image build** (`run-bench-cloud`): stages a git-ignored depth-1 bare
  repository of the build commit as `.cloudbench-git-seed` in the context.
  `COPY . /app` bakes it read-only once. Atomic directory creation refuses an
  occupied context rather than replacing its seed. A random invocation token
  and sole cleanup parent bind removal to its own seed after publisher join.
  Failed entrants and pre-stage exits cannot delete another builder's seed.
  A context with no Git HEAD builds without it. Unproven leftovers fail closed.
  Setup interruptions retain the seed because that mode has no equivalent
  publisher-tree join owner; normal setup completion still removes its seed.
- **Fresh REAL primaries only** (`cloudbench-fetch-ref.sh`):
  - Validate the manifest schema and commit matching the shallow boundary;
    import with native Git rather than trusting the source pack/index mapping.
  - Import the seed through Git (`git fetch --depth=1 file://<seed>`), so
    index-pack re-hashes every object and Git records the shallow boundary.
    The checkout has no dependency on the image path. The first candidate
    hand-copied the pack and its `.idx`. The independent review reproduced a
    swapped-offset index that checked out wrong file bytes while reporting
    "verified", and the test now covers that case.
  - Offer the seed commit as the only negotiation tip.
  - GitHub still serves the exact requested SHA, and checkout and verification
    are unchanged.
  - A missing, stale or corrupt seed is ignored and the ordinary unseeded
    fetch runs. A seeded GitHub fetch that fails retries once unseeded.
  - Claim rollback custody only for an initially empty, ref-free object store
    held by this invocation's repository lock. HEAD-less stores with earlier
    objects skip the optional seed; rollback never deletes those objects.
- **Unchanged:** worker-runtime fetches and retained volumes.

Offline red/green, against a local `file://` origin through the real script:

- **Seeded:** 683 of 3,083,460 bytes transferred.
- **Controls:** a corrupt pack, a swapped-offset index, a stale manifest, and
  a seed commit unknown to the server each fall back to the full transfer with
  the exact checkout.
- **Earlier candidate:** the index control is red against the hand-copy
  version.

The speedup needs an authorized image rebuild and activation.

Scaling: local work is linear in the seed's size, including Git's native
index-pack validation. The image gains about 308 MB of packed source. Net cold
image pull plus local validation/import plus fetch startup latency remains
unmeasured; transfer savings are not proof of a net startup or task-outcome
improvement. This candidate remains mitigated pending an authorized image
rebuild, activation and unchanged Polar outcome proof. No such operation was
performed by the safety follow-up owner.

## Human feedback

The follow-up must preserve the native Git import, swapped-offset regression,
ordinary exact-fetch retry, exact-SHA checks and existing publisher process
ownership; fix context custody without applying runtime repairs before an
independent exact-snapshot GROUNDED review. No provider/image operation, paid
benchmark, deployment, task-definition edit or Freedom change is authorized.

## Reusable lesson

A depth-1 fetch into an empty repository negotiates nothing. Give fresh workers a verified local base commit that the server knows, instead of expecting caches of unrelated layers to help.

## Candidate safety follow-up

On d6f998075 and b98835cbf, the real image-build CLI with a controlled local
publisher reproduced two custody failures: a concurrent entrant and an entrant
cancelled during pre-stage client resolution deleted the active owner's seed.
The original one-owner control passed; both new cases failed (2.10s on b988).
The assertions preserve the original publisher, seed inode and pack bytes,
prevent a second publisher, and require cleanup after the owning CLI joins.
Only exact fixture-created process trees are terminated.

The original hand-copy candidate also accepted a byte-intact pack/index that
omitted a reachable blob, then failed the exact target fetch with `missing
blob object` / `remote did not send all necessary objects`. b988's native import
and ordinary retry are preserved. Added controls check that missing-blob
source, a damaged index checksum (native Git may repair its correct mapping),
a partial failed native import and a once-only seeded-origin failure all end
at the exact requested tree and file bytes. Another b988 counterexample starts
HEAD-less with a valid unrelated pack: rejecting a stale seed deleted that
preexisting pack. The repair admits destructive rollback only after proving
initially empty object/ref storage under the existing fetch lock.

The registered image CLI suite exposed extraction fixtures that loaded only
build_warm_image and omitted its newly required seed helpers. Fixtures now
include the real contiguous helper block; provider/context/cache/receipt
assertions and all limits are unchanged. No benchmark task is altered.

Opened references: Codex `codex-rs/core-plugins/src/startup_sync.rs:206-224`
imports from a local source through Git and verifies exact HEAD; lines110-124
fall back after a cache transport failure. Prime
`scripts/release/assemble_source.py:251-261` scopes staging to its own lifetime
and cleanup. Hermes `tools/environments/file_sync.py:361-376` serializes shared
mutation and `apps/desktop/electron/desktop-plugin-install.ts:315-337` uses
unique owned staging/cleanup. OpenClaw
`src/gateway/worker-environments/project-seed-script.ts:137-153` validates
native pack import, exact commit and closure before publishing a seed. Our
context-directory guard adds no inheritable lock descriptor or publisher PID
boundary. Unverified drain and unproven stale custody retain the seed for
explicit diagnosis rather than deleting input an active publisher may read.
