---
id: 2026-09-29-mac-relay-task-admitted-to-cloud-capability-proof
date: 2026-09-29
title: Cloud capability sampling admitted a Mac Messages relay benchmark
surface: infra
component: fleet-capability-selection
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: fleet_infra_sample.eligible_pool required a cloud agent root but did not exclude a task whose declared service was the macOS Messages bridge
symptoms:
  - "Live message-person benchmark requires a macOS controller for Apple Messages"
  - "guest shutdown without sealed runtime evidence"
  - "terminal runtime evidence remains incomplete"
tags:
  - cloudbench
  - selection
  - macos
  - linux
  - ownership
sources:
  - PR #1299
  - fleet run 20260930-003708-18185
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: open
---

## Problem

A ten-task cloud capability slice selected `message-person`. Its task contract
declares `macOS Messages bridge` and an authenticated Mac app as live services.
The Linux controller allocated and started a pool Machine, then
`run-bench-cloud` correctly refused to run the task without a macOS controller.
The guest acknowledged shutdown but had no run result or sealed runtime bundle.
This is an infrastructure selection failure. The slice has zero proof credit;
an evaluator `FAILED` result was never produced.

## Diagnosis

The first bad boundary was `fleet_infra_sample.eligible_pool`: its capability
mode excluded rootless SMS runners but treated every other ready catalog task
as cloud runnable. The task's platform requirement was already explicit in
`tasks.json`, and `run-bench-cloud` enforced it. The owning-boundary local
reproduction showed `message-person` in `eligible_pool(...,
require_cloud_root=True)` before the fix. It is absent after the fix. The
same regression test also proves that an explicit capability pool containing
the Mac relay task fails before any provider provisioning.

The archive searches were `macOS Messages bridge Linux cloud benchmark
selection` and `capability sampler unsupported platform runtime evidence
incomplete`. Related Mac/Linux environment cases did not cover this catalog
admission boundary.

## Solution

Capability sampling now reads the existing declared service list and excludes
tasks requiring the macOS Messages bridge. An explicit pool naming one is
rejected with an actionable error. Ordinary macOS benchmark execution and the
task's prompt, tools, model, evaluator, timeout, and success criteria are
unchanged. The canceled fleet retains its exact owner until guest cleanup and
runtime evidence are independently verified. The unsupported task stopped
during Git sync before stack startup, so a normal sealed runtime bundle could
not exist. Its exact stopped original volume contained an exited driver,
the owner-token clean acknowledgment, and no stack, backend, worker log, or
run record. A separate prestack receipt and the interrupted-pool archive
verifier bind those bytes to the original Machine and volume. Recovery grants
no proof credit.

The outcome remains open until the live owner is retired and ten consecutive
infra-clean, three-LLM-query slices finish on one clean commit.

## Human feedback

The user requires infra-only changes, ten sequential valid slices of ten
distinct tasks, at least three successful LLM completions per task, real
evaluation and verified teardown. A task verdict of `FAILED` is acceptable;
missing execution or runtime evidence is not.

## Reusable lesson

Filter cloud capability candidates by their declared platform services before
allocating a Machine, while preserving the task contract for its supported
platform.
