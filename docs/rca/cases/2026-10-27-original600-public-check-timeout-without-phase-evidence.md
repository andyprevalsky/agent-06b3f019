---
id: 2026-10-27-original600-public-check-timeout-without-phase-evidence
date: 2026-10-27
title: Original600 public check repeated the same pinned catalog reads for every shard
surface: harness
component: original600-portable-operator
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: read-only check classified the same immutable task catalog twice per shard, launching 80 Git reads to render 20 placement rows under its unchanged 10-second child deadline
symptoms:
  - "Portable.test_public_check_is_path_independent_read_only_and_creates_no_state"
  - "subprocess.TimeoutExpired disabled-policy child timed out after 10 seconds"
tags:
  - deploy
  - read-only-check
  - subprocess
  - observability
sources:
  - commit 46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277
  - plan:.context/deploy-fresh-20261027/original600-portable-operator-batch2-failure.log
  - plan:.context/deploy-fresh-20261027/rca-original600-timeout/findings.json
  - commit af4cde0458152c76e2ea9fea8d177ba5e9e01344
  - plan:.context/deploy-fresh-20261027/rca-original600-recurrence/REPORT.md
  - plan:.context/deploy-fresh-20261027/rca-original600-recurrence/full83-receipt.json
repro: scripts/tests/original600-portable-operator.test.py::Portable.test_public_check_is_path_independent_read_only_and_creates_no_state
status: fixed
---

## Problem

At source46bfbfb5, the 82-test native structural suite timed out in the disabled-policy subprocess at line2068. Its temporary fixture was subsequently removed. The original ten-second guard and all read-only/no-state assertions remain unchanged.

## Diagnosis

The initial diagnosis was unresolved. Two correctly located focused native observations passed; disabled-policy children completed in2.164s and2.065s. The traced command performed173 subprocess launches including168 local Git reads. Eighty reads arose from duplicated per-shard catalog interpretation. This work is observed, but there is no evidence locating the original timeout within it. It must not be presented as a causal fix or host-load diagnosis.

## Solution

Before the recurrence, no repair was claimed. Scratch observers retain each native child's stdout/stderr, argv, duration, function/subprocess trace and an eight-second stack capture while retaining the original ten-second guard. The remaining proof is an actual failing native invocation with that phase evidence, followed by a justified correction and unchanged-command green. Details and source hashes are in REPORT.md and findings.json beside this draft.

## Coordinator constraints

Preserve the native command, all assertions, the ten-second deadline, path independence, read-only provider behavior and empty state directory. A baseline pass is not a repair. No shared source, archive/index or production mutation was authorized to this worker.


## Human feedback

No additional user feedback was recorded. The coordinator retained the original ten-second deadline and the unresolved classification; a later passing gate is not a causal repair of the missing original phase evidence.

## Reusable lesson

Retain child timeout streams and phase evidence before temporary fixture cleanup; an isolated green rerun cannot identify a lost slow operation.

## Recurrence with retained native phase evidence

The af4cde045 canonical67-command stage failed the same original disabled-policy child at10s, with82 owning tests/one error. Capture8c4180ae1eee4864ad7e55d538b7002e records10.080768744s and an8s stack in subprocess._execute_child, called from shard_simulate_tasks92 through shard_placement_env99/operator2574. The prior9.066s pass was in the same local Git/catalog phase at8s. No stdout had yet been emitted; stderr was only the normal validated fixture provider-registry notice. The original first incident's exact slow phase remains unrecorded; the recurrence now locates an active phase.

One20-row read-only checklist classified the same pinned catalog twice per shard:80 real Git reads of tasks.json/polar_tasks.json. The coordinator applied reviewed proposal5c6ddeb12b35d646cbceb803efd75c841f0c7db98592d6ce2e6df0246dc433c5: classify the ordered union once with the existing canonical helper and common exact task ref, then project each shard's ordered simulate subset and identical fresh placement dict. This makes2 reads per check, uses no global cache, and preserves source/private-input/freshness/eligibility checks and actual --run behavior. Independent review found no semantic counterexample under the current common-ref plan contract. Future per-shard refs would require partitioning by ref; the current planner has no such field.

A controlled125ms latency only before real placement-catalog Git reads reproduces the original unchanged10s error; the identical native command passes4.920s after correction. The permanent regression adds no delay: original80-vs2 reads fails3.351s; candidate passes1.807s. It also compares full placement output to native policy, exact two GETs, no provider-write marker and empty state under the same10s bound. All82 original test/module ASTs remain;83 owning tests now run. MixedSIM/REAL siblings and arbitrary manifest/refusal controls pass. Full owning native83 passed106.953s/exit0 on the exact applied controller7f1b18fd1b7e782ea606f1f6c1964e11da4ec137ff91d20f86b506c0f6956969 and test ed85bcd6dc2f10b062f2214e7526b61f4f2b2f4128be4ffa7022f49737b8f78d, without delay/timeout observer. The existing canonical gate discovers the regression; no new selector is required.

This fixes proven redundant work at the captured public-check phase. It does not establish each historical Git latency, the initial lost timeout's phase or total observer overhead. Measured observer parent setup0.193ms precedes the timed call, child arm0.144ms, launch-to-arm92.689ms includes interpreter/imports, and capture3.305ms occurs after expiry. No generic host-load attribution is made. Known processes/tempfixtures are gone; the original observer did not record every historical descendant. Combined canonical67/full-source gates and deployment remain separate acceptance.
