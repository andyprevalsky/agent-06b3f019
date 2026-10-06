---
id: 2026-10-05-setup-activated-env-before-quiescing-live-donor
date: 2026-10-05
title: Image activation injected the environment before stopping a live donor
surface: infra
component: cloudbench-image-activation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-cloud setup called inject_secrets before quiescing its existing warm donor
symptoms:
  - warm source must be stopped for strict environment activation
  - image-activate failed before warm-source preparation after canceled maintenance
tags:
  - cloudbench
  - image-activation
  - maintenance-ordering
sources:
  - agent /root/fresh_cli_validation exact donor parking CLI reproduction
  - agent /root unchanged owning blackbox reproduction
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_activation_quiesces_existing_donor_before_environment
status: fixed
---

## Problem

A canceled dependency refresh left the exact warm donor started. The documented
image-activate CLI then failed in 10.15 seconds while attempting to park it
through normal setup. The actual output matched the strict stopped-state guard
and the environment activation failure branch; neither a timeout nor a dirty
checkout explained this failure. Private original output and native identity
receipts remain under .context/fresh-cli-validation-20261005/.

## Diagnosis

Setup injected environment secrets before its later prepare_warm_source call.
Strict skip-start activation correctly rejected a started donor, so setup never
reached the existing stop operation that could establish its prerequisite.
Archive searches for the exact activation error and donor/image terms found
related image publication and environment cases, without this ordering defect.
The shared app lock must cover both donor quiescence and environment mutation.
An owned shlock control also proved a second acquisition by the same live PID
fails; adding a second outer acquisition would therefore introduce a deadlock.

## Solution

Within the existing single lock acquisition, setup now obtains the authoritative
unique named warm target, proves its current state, and strictly stops that donor
when necessary before injecting the environment. Stopped donors incur no extra
stop. Pool machines are excluded from this operation. Other maintenance modes
retain their original strict activation checks; ordinary fleet execution remains
read-only against the shared environment. Stop or identity failures release the
lock and fail before environment updates. Existing stop/readiness budgets and
image, task, evaluator and model inputs are unchanged.

## Verification

The three permanent controls execute the actual injection wrapper and strict
activation function at an isolated provider boundary. Old source failed the
started-donor and failed-stop cases, while its stopped-donor inverse passed
(2 red, 1 green in 0.10 seconds). Unchanged controls and all existing activation
controls passed the repair (15/15 in 0.25 seconds). They verify lock-before-stop,
stop-before-injection, zero mutation after a failed stop, no stop for an already
stopped donor, and exclusion of the pool target. The existing compact deploy
selector owns cold_image controls, adding no paid or large verification gate.
Independent review and actual exact-image activation are recorded separately;
synthetic proof alone does not establish the live repair.
Independent review passed 21 focused activation, target, pool and maintenance
controls, including malformed or ambiguous target rejection and exclusion of
active pool members. Original canary allocations and all canceled owner claims
were retired normally before the new exact-image activation was authorized.
The existing structural lock-scope assertion initially treated every failure
release as the normal-path release. It now compares injection with the final
normal release; the actual failed-stop control separately proves release before
any injection on failure. The required lock and read-only fleet policy remain.

## Human feedback

The user requested a clean stable CLI, safe interruption, rapid stage overlap,
compact regressions cemented in deploy and independent fresh-context validation.

## Reusable lesson

Maintenance must establish a downstream strict activation prerequisite before
calling that activation, within one shared ownership lock.
