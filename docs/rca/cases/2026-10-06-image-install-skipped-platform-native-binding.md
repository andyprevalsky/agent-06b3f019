---
id: 2026-10-06-image-install-skipped-platform-native-binding
date: 2026-10-06
title: Successful image dependency installation left Rollup's native binding unavailable
surface: infra
component: cloudbench-image-dependencies
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the image installer accepted npm success without loading the frontend compiler's declared native binding
symptoms:
  - the task-free canary failed frontend bootstrap before any of fifty copies executed
  - Rollup could not load its Linux x64 GNU native optional dependency
  - source checkout and Prisma generation had already progressed
tags:
  - cloudbench
  - image-build
  - native-dependency
  - npm-workspaces
  - rollup
sources:
  - commit e845150de788c572a935b6e7bba34038eb7a519b
  - fleet run 20261006-025437-62250
  - plan:.context/benchmarks/campaigns/campaign-20261006-095345-47794/cli-validator-result.safe.json
  - plan:.context/native-rollup-installer-repro
repro: agents/benchmarks/cloudbench_image_installer_test.py::test_cloudbench_image_build_loads_actual_rollup_native_without_version_or_manifest_changes
status: open
---

## Problem

A fresh-context agent used only the ordinary CLAUDE/CLI workflow to launch fifty
cached copies on sealed source `e845150d`. The mandatory task-free canary failed
before any copy allocated a task guest or executed. Its real frontend loader
could not find `@rollup/rollup-linux-x64-gnu` from
`front-end/node_modules/rollup/dist/native.js`. Both guest Git HEADs were verified
against the sealed source. Logs were retained privately before exact cleanup.

This is a bootstrap infrastructure failure, rather than a benchmark task failure.
The rejected campaign lasted 1,121.711 seconds; all fifty copy controllers exited.
Both exact canary Machines and Volumes were observed absent at 10:14:40 UTC,
before their 1,200-second allocation cutoffs. Its original cleanup failure and
missing finish epochs remain intact. A separate recovery-array case owns the
remaining audit claim. No task, cache, evaluator or LIVE-query credit is awarded.

## Diagnosis

Path: installed dependency image → complete workspace dependency mirror → real
frontend compiler loader → missing platform-native module → stack startup failure
→ no task execution.

The installer treated successful npm and Python exits as sufficient dependency
readiness. It did not load the installed frontend compiler. The permanent owning
test runs the actual installer with real Rollup 4.62.2 and its compiled native
artifact. The unchanged source fails at the real loader on both Darwin and an
owned AMD64/Linux fixture; the Linux error selects exactly the observed GNU
package. The known cached Linux image supplying fixture artifacts has different
provenance from ff89 and is not evidence of ff89's complete installed inventory.

Archive searches for `rollup optional dependency native package npm 4828 platform
package` and `MODULE_NOT_FOUND Mac lock host lockfile image dependency` found the
related workspace-Prisma and image dependency cases, but no owning Rollup case.

An isolated real npm 10.8.2 installation with Rollup's unchanged optional
dependency declarations and host-only native lock metadata exited successfully
in 419 ms; importing Rollup then failed for the same Linux package. This is a
reproduced mechanism, not proof of the exact historical ff89 build context. The
current ignored Mac root lock has only Darwin native metadata. Its historical
build hash is unknown, and the retired guest's donor tree was unavailable for
inspection. The [npm issue](https://github.com/npm/cli/issues/4828) documents the
related cross-platform lock inconsistency; incident provenance remains qualified.

## Solution

Load the installed Rollup native loader during ordinary image installation. Its
own loader selects the operating system, architecture and libc. A healthy binding
causes no extra installation. Only a genuinely missing native package declared
at the exact installed Rollup version is eligible for repair.

Install that exact package in a temporary isolated directory without lifecycle
scripts, lock mutation or version re-resolution. Verify package identity and
version, copy it into Rollup's private dependency tree, and load it again before
Prisma generation or dependency readiness markers. Broken native libraries,
unrelated errors, unavailable packages and mismatched identities fail the build.
Both existing installer branches still join, and cache cleanup stays unchanged.

The same owner is green on Darwin and AMD64/Linux. Nine focused cases cover the
five native scenarios plus four existing installer-join controls. Successful
paths preserve manifest/lock bytes and the installed Rollup version. The
existing normal `cloudbench_image_build` predicate selects all nine; this adds no
large deploy suite or benchmark/model call. Independent review and a fresh native
image/fifty-copy validation remain required, so the case is still open.

At 10,000 agents the healthy build adds one native import, with no per-agent
installation or provider call. Missing-package repair occurs once in the image
build and its artifact is mirrored by the existing workspace dependency helper.
Task definitions, prompts, models, evaluators, results and time budgets are
unchanged.

## Human feedback

The user asked for compact permanent verification, parallel repairs, a fresh
CLAUDE-only CLI validation and candid stage timings. A successful build command
must not be reported as a usable benchmark fleet.

## Reusable lesson

Verify the consumer's real native loader before publishing dependency readiness.
Preserve installed versions and classify the actual failing boundary separately
from a plausible package-manager history.
