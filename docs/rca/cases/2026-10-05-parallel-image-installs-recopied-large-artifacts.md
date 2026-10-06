---
id: 2026-10-05-parallel-image-installs-recopied-large-artifacts
date: 2026-10-05
title: Parallel image dependency branches recopied large artifacts after installation
surface: infra
component: cloudbench-image-dependencies
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: final Docker image stage materialized HOME, node_modules, and venv through cross-stage COPY instructions
symptoms:
  - copying HOME took 121.4 seconds after dependency installation
  - copying node_modules took 152.5 seconds and venv took 55.5 seconds
  - npm download cache occupied most of the distributed user home
tags:
  - cloudbench
  - image-build
  - startup
  - dependency-installation
  - artifact-copy
sources:
  - PR #1299
  - agent /root/cold_image_startup owning reproduction and independent review
repro: agents/benchmarks/cloudbench_image_installer_test.py::test_cloudbench_image_build_joined_installer_keeps_artifacts_and_waits_both
status: fixed
---

## Problem

The native uncached diagnostic built separate JavaScript and Python dependency
branches, then copied their large outputs into a final runtime stage. Npm took
550.2 seconds and Python took 97.7 seconds in parallel. Final-stage copies then
took 121.4 seconds for HOME, 152.5 for node_modules, and 55.5 for venv: 329.4 seconds
of repeated materialization. HOME alone exceeded the maximum possible benefit
from overlapping that observed Python installation.

The build was separately disqualified as an original baseline by a context
selection bug. These stage timings still locate work performed by the submitted
candidate. They do not establish a matched baseline or a final live speedup.

## Diagnosis

Parallel BuildKit branches added a costly merge boundary for the installed
filesystem trees. The installers did not need separate runtime roots: their
outputs use disjoint node_modules and venv paths, and their cache stores are also
separate. The first bad boundary was the cross-stage artifact transfer after the
parallel installations, rather than task execution or provider latency.

An existing AMD64 donor image contained 334,112 KiB (326.28 MiB) under
`/home/rose/.npm/_cacache` and 648 KiB of npm install logs. These package-download
artifacts comprised 90.5% of that image's HOME tree. Its Prisma cache was 34,180
KiB and remains a separate retained asset. These are filesystem observations,
not a promise about another image's compressed size or startup time.

Archive searches used `image HOME node_modules copying slow runtime stage` and
`npm download cache package tarballs cold build parallel install`. Related
warm-image fingerprint cases require installed artifact parity. The
`2026-07-24-floating-prisma-cli-downloaded-incompatible-major` case demonstrates
that cached npx executables and workspace discovery must not be confused with
the npm tarball store; its installed-tool requirement remains intact.

## Solution

Both image recipes now install directly into their final dependency layer through
`scripts/cloudbench-install-image-deps.sh`. The helper starts the unchanged root
npm/Prisma and Python venv/pip commands as two Bash jobs, waits for both exact
children, and rejects either failed exit status. Runtime discovery markers are
published only after both installers succeed. Source remains the final copy,
with manifests, optional root lock, tracked workspace locks, Prisma schema,
requirements, and the owning helper preceding the install step.

At the end of that same successful install step, `npm cache clean --force`
removes only its `_cacache` store and the exact `_logs` directory is removed.
Inspection of the installed npm implementation confirmed that cache-clean
targets `_cacache`. Npm configuration, cached `_npx` executables, all other home
assets including Prisma/browser files, installed dependencies, and venv remain.
No unrelated cache, dependency version, task, prompt, model, or evaluator changes.

The owning shell controls execute the real helper with offline installer
executables. Peer handshakes require concurrent starts; success, either failed
installer, and both failed installers verify terminal statuses and disappearance
of both actual background shells. The successful case verifies exact installer
arguments, retained assets/configuration, removed download caches, and discovery
markers. Recipe controls verify source-last input boundaries and the absence of
cross-stage dependency copies. The unchanged controls failed in ten cases before
repair and passed all twelve afterward. The image/CLI set passed nineteen controls
in 2.28 seconds, and both actual Docker recipes passed BuildKit checks.

Separately, a network-disabled, read-only container of the existing AMD64 donor
hid its actual `_cacache` directory with an empty mount. Installed Prisma, tsx,
and Vite ran successfully with offline npx and their existing versions; Python
venv imports also succeeded. The underlying image and installed trees remained
unchanged. This proves the observed installed-tool boundary without claiming a
new complete image has been validated.

Independent review approved the joined installer and targeted cleanup and reran
all twelve image/installer controls. The new file is registered under
`cloudbench_image_build` in the existing compact benchmark deploy owner. Native
matched cold builds and complete fleet validation remain separate required
evidence. At fleet scale, installed package bytes and semantics stay the same;
package-download bytes are omitted from image distribution, with no per-agent
verification added.

Private evidence is retained at:

- `.context/acceptance/startup-speed-20261005/baseline-image/build.private.log`
- `.context/acceptance/cloudbench-image-cold-diagnostic-stages.safe.json`
- `.context/acceptance/cloudbench-image-joined-installer-red.private.log`
- `.context/acceptance/cloudbench-image-joined-focused-final.private.log`
- `.context/acceptance/cloudbench-image-empty-download-cache.private.json`
- `.context/acceptance/cloudbench-image-installer-independent.private.log`

## Human feedback

The user requested genuinely uncached startup measurements, meaningful parallel
work, compact permanent deployment controls, and unchanged benchmark results.
The controller owner required real shell exit/join controls rather than recipe
structure alone and preserved the submitted diagnostic while editing local source.

## Reusable lesson

Measure the merge of parallel build branches, not just installer overlap.
Install disjoint dependency trees concurrently in their final layer when copying
their completed outputs costs more than the overlap saves. Separate download
caches from installed executables and runtime assets before reducing distribution.
