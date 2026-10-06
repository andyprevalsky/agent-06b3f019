---
id: 2026-10-06-fresh-image-checkout-recopied-identical-dependencies
date: 2026-10-06
title: Fresh image checkouts recopied identical dependency bytes before every stack startup
surface: infra
component: cloudbench-dependency-hydration
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: sync_tree materialized every matching baked dependency tree into an empty checkout before it could declare dependencies usable
symptoms:
  - dependency hydration took 350 and 481 seconds in two actual canary guests
  - both guests had already verified their exact source checkout
  - locked donor dependencies still needed private writable checkout state
tags:
  - cloudbench
  - startup
  - dependencies
  - overlay
  - prisma
sources:
  - commit cb9fb73b9c58f84ebde0561ae75e4211185df7d1
  - fleet run 20261006-034242-91262
  - plan:.context/native-rollup-installer-repro/runtime-native-readonly/20261006T105221Z-milestones.safe.json
  - plan:.context/dependency-hydration-speed-20261006
  - plan:.context/independent-frontend-overlay-review-20261006/hydration-replays.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fresh_dependency_overlay_prisma_client_preserves_checkout_and_copy_boundaries
status: open
---

## Problem

After full authenticated Git fetch and exact checkout, two actual image-backed
canary guests spent 350 and 481 seconds hydrating their dependencies. Root,
workspace and Python dependency trees were already present in the image at the
matching fingerprints. Each empty fresh checkout nevertheless triggered a full
`rsync` materialization followed by Python relocation, Prisma freshness work and
recursive runtime ownership updates.

The surrounding campaign failed later at the frontend's SWC loader and earned
zero task execution credit. Its measured hydration delay is runtime evidence of
this separate repeated-copy cost, not proof that removing the delay resolves the
frontend failure or makes the fleet usable.

## Diagnosis

Path: matching immutable image dependencies → fresh exact-source checkout lacks
dependency markers → `sync_tree` copies every byte → relocation/schema/ownership
work → stack startup.

Archive search found the prior parallel-image-install copy case and the fresh
workspace-Prisma case. Their owning boundaries are image construction and
dependency layout, respectively; neither removes the per-guest materialization
of matching dependencies.

The unchanged new owning control fails with the original helper because fresh
matching trees invoke the copy path. A real installed AMD64/Linux donor fixture
also reaches the full-copy sentinel on the original helper. That sentinel
prevents a large unnecessary local copy; it is not a measured old-helper speed
baseline. Actual baseline durations come from the original canary guests.

## Solution

For a matching empty Linux checkout running with mount permission, mount each
baked dependency tree as a lower directory with private writable upper/work
directories on the checkout volume. Require `metacopy=on`: the real driver
recursively changes ownership, and an ordinary overlay could copy every lower
byte during that operation. Unsupported platforms or mounts retain the original
copy behavior. Fingerprint mismatches retain the existing explicit rebuild or
failure boundary.

Preserve relative workspace links to current checkout source, writable generated
Prisma clients and activated Python relocation. Never share writable dependency
state with the donor. Cancelled or failed hydration retires only its own newly
mounted targets; completed mounts remain available to the owning guest. Rebuild
materializes only its exact owned overlay when an explicit central install needs
the original copied-tree rollback semantics. A failed Python replacement keeps
the prior healthy venv; a failed npm install preserves the prior generated client
while invalidating its readiness receipt. An unreadable venv refresh copies from
the immutable donor rather than reading the damaged old tree. Stopped guests
cannot reuse metacopy upper state against a replacement image.

Five bounded owning controls cover matching reuse, unsupported platform,
permission failure, fingerprint mismatch and cancellation, including repeated
matching use and checkout-relative links. They join the five existing Prisma
controls in the registered blackbox and the existing compact deploy command.
There is no new paid verification suite.

The unchanged real Linux fixture passed with the candidate: actual recursive
ownership changes, installed Prisma generation, temporalio/pip imports,
activated `python3` subprocess prefixes and fresh workspace source all worked.
The large lower-file metadata copy had zero upper data blocks; donor schema
hashes remained unchanged and every test mount retired. An independent reviewer
reproduced original red and candidate green, with local hydration 1.960 seconds,
ownership 2.066 seconds and Prisma 2.398 seconds. These are local mechanism
diagnostics, not Fly speedup percentages. Native fifty-copy validation and the
exact-source deploy gate remain required; this case remains open.

At 10,000 guests, writable state and four dependency mounts remain private to
each guest; this introduces no shared mutable lock or admission service. The
existing fixed-tree scan, relocation and schema work remain. Task source,
models, prompts, evaluators, results and execution budgets are unchanged.

## Human feedback

Prioritize the largest actual delay and prove optimizations through the supported
CLI. Do not replace full source with a sparse or truncated checkout, relax task
results, or present a fixture timing as a native fleet measurement.

## Reusable lesson

Reuse immutable dependency bytes at the filesystem boundary while preserving
private mutable runtime state. Include the next ownership/schema consumer in the
proof so metadata operations do not silently erase the intended benefit.
