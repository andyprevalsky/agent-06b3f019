---
id: 2026-10-06-seed-get-empty-runner-array-blocked-fallback
date: 2026-10-06
title: Empty seed runner candidates aborted before the supported fallback
surface: infra
component: cloudbench-host-seed-get
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-seed-get.sh expanded an empty runners array under Bash 3.2 nounset
symptoms:
  - runners array unbound before Node or npx fallback
  - an available canonical fixture was reported missing
tags:
  - cloudbench
  - seed-preflight
  - bash
  - empty-array
sources:
  - PR #1424 review comment 4202918178
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/c4-review-cycle1-owning-fixes.private/bash-final-guard-original-red.safe.json
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_seed_get_empty_runner_keeps_native_bash_fallbacks
status: open
---

## Problem

The shared host seed GET supports installed tsx, Node type stripping, then npx.
On macOS Bash 3.2, a legitimate empty installed-runner list aborts the function
under nounset before either fallback. The normal five attempts repeat this
shell error, even when the canonical fixture is available through a fallback.

## Diagnosis

The permanent owner executes the actual helper with `/bin/bash` 3.2.57 and
isolated local runner doubles. Unchanged source fails the Node, npx and missing
fixture cases at `runners[@]: unbound variable`; the installed-runner inverse
passes. The measured native command took 1.722 seconds. No external request,
controller allocation, model call or benchmark execution is performed.

Archive searches used `runners[@] unbound variable` and
`Bash 3.2 empty array fallback`. The existing empty recovery-PID join is a
relative: it owns final cleanup, whereas this first bad boundary precedes the
host GET. Its solution and human feedback support preserving an empty list
without changing strict shell options or real child ownership.

## Solution

Use the existing zero-element-preserving expansion when iterating candidates.
Installed runners keep their ordering. Empty candidates reach the unchanged
Node and npx fallbacks; genuinely missing fixtures still fail after the existing
five attempts. No retry, transport, execution or end-to-end budget changes.

The identical four owning states pass in 3.938 seconds. Assertions verify the
selected runner, complete fixture bytes, exact attempt count and absence of a
dump on a genuine miss. The native leaders were reaped and their groups were
empty. Existing campaign-inventory selection in the normal benchmark and
deploy compact gate discovers all four states. Final combined-source
qualification and deployment remain pending; this grants no LIVE50 credit.

At large fleet widths, this changes one host iteration before provisioning.
It introduces no per-task request, polling loop or shared agent lock.

## Human feedback

Preserve usable stage handoffs and native ownership, avoid narrow rejection
timers, cement compact owning regressions, and keep active trials immutable.

## Reusable lesson

An empty optional runner list must reach the supported next execution path
under every supported shell, while an actual missing fixture stays a failure.
