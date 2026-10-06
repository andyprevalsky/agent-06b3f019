---
id: 2026-10-06-frontend-readiness-checked-only-one-native-compiler
date: 2026-10-06
title: Image readiness checked Rollup while the actual frontend configuration also needed SWC
surface: infra
component: cloudbench-image-dependencies
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: image installation declared frontend dependencies ready without loading the actual Vite configuration and compiler
symptoms:
  - a fresh documented fifty-copy campaign failed before task execution
  - the actual frontend reported Failed to load native binding from SWC
  - successful Rollup native loading during image publication did not establish frontend readiness
tags:
  - cloudbench
  - image-build
  - native-dependency
  - vite
  - swc
sources:
  - commit cb9fb73b9c58f84ebde0561ae75e4211185df7d1
  - fleet run 20261006-034242-91262
  - plan:.context/independent-cli-cb9fb73-20261006/final-independent-cli-receipt.safe.json
  - plan:.context/native-rollup-installer-repro/runtime-native-readonly
  - plan:.context/native-frontend-batch-repro-20261006
repro: agents/benchmarks/cloudbench_image_installer_test.py::test_cloudbench_image_build_loads_actual_frontend_compilers_without_version_or_manifest_changes
status: open
---

## Problem

A fresh-context agent read the source-derived credential-redacted CLAUDE and
ordinary CLI documentation, built an uncached image, activated its exact digest,
and launched fifty independent cached executions of the unchanged mass-agent
demo. Image publication took 289 seconds and exact-image activation took
159.209 seconds. The two task-free canaries consumed the same image and checked
out the sealed source. No outer task guest allocated or executed.

The actual frontend configuration imports `@vitejs/plugin-react-swc`. Its SWC
loader reported `Failed to load native binding`; the first canary's driver exited
with code 1. Rollup's GNU binding had loaded successfully during image
installation, so the existing loader check covered only one of the frontend's
native consumers. This is a bootstrap infrastructure failure, not an acceptable
benchmark task FAILURE.

The rejected invocation lasted 1,224.327 seconds. Its fifty controller durations
of 1,218.835–1,219.388 seconds are not allocated task E2E times. The two exact
Machines were absent at 11:02:33 UTC and their exact Volumes were detached,
pending destruction with accepted delete receipts at 11:02:51 UTC, before the
11:03:05 allocation cutoff. Later normal exact-owner recovery closed the
remaining nested claim; all fifty-one recorded owners had zero claims. Original
missing completion timestamps and the watchdog diagnostic remain archived.
Neither synthetic finish timestamps nor eventual physical volume disappearance
are required to reinterpret the original failure.

## Diagnosis

Path: published dependency image → complete exact-source checkout → dependency
hydration → real Vite configuration → SWC native loader failure → stack startup
failure → no task execution or evaluation.

Archive searches for `swc native binding optionalDependencies`, platform-native
installation and Vite startup found the earlier Rollup case, but no owning SWC
readiness case. That earlier fix established its specific native-loader behavior
and did not prove that all consumers in the real frontend configuration loaded.

The retired guest's SWC package inventory was not captured before teardown. The
public loader error alone does not distinguish an absent package from a corrupt
or incompatible binding. A later attempt to inspect the exact image manifest
with the available local credentials returned `NOT_FOUND`; that observation
does not establish image deletion or the historical package inventory. The
canaries' exact-digest consumption is independently retained. Local compiled
artifact fixtures have different provenance and must be described as owning
mechanism evidence, not reconstructed guest inventory.

## Solution

Verify installed native loaders and real JSX/TypeScript transforms during the
joined dependency installation. Repair only absent optional native packages at
the requesting package's exact installed version. After the complete source
copy, use the same probe in verification-only mode to load the actual Vite
configuration and compile a small virtual entry. The final phase performs no
installation. This preserves dependency-layer caching and supports valid
configuration imports from the complete source tree.

Present but broken binaries, incorrect package identities and unrelated
configuration errors fail loudly. Healthy compilers require no repair install.
The virtual compilation writes no application build output and launches no
application. It changes no application source, task, prompt, model, evaluator or
result.

The captured cb9 installer fails against the unchanged owning SWC-missing
scenario at the real Vite/SWC loader. All thirteen controls pass on Mac and the
owned AMD64/Linux compiled-artifact fixture. They cover the existing installer
joins, a batch of three missing bindings, SWC alone, healthy zero-repair behavior,
corrupt libraries, unavailable downloads, downloaded and installed version
mismatches, unrelated configuration failure and a valid source-relative config
helper. Manifests and locks remain unchanged.

An independent reviewer repeated original red in 2.59 seconds and all thirteen
green controls in 35.21 seconds on the Linux fixture, with zero open findings.
Its different artifact provenance remains explicit. The normal exact-input
compact gate and a new uncached documented CLI run with fifty actual cached
executions are still required. The case remains open and the failed campaign
earns zero acceptance credit.

## Human feedback

The user requested parallel work on the largest delays and a fresh-context agent
using only basic CLAUDE/CLI instructions to cross-check the speedups. They also
require concise permanent deploy verification rather than a growing second
harness. Image publication and activation timings must be reported separately
from usable fleet readiness and actual task execution.

## Reusable lesson

Test the application's real configuration and consumer behavior at the owning
readiness boundary. One repaired dependency loader does not prove its sibling
compilers are ready, and a generic native-loader error does not identify the
package manager's historical cause.
