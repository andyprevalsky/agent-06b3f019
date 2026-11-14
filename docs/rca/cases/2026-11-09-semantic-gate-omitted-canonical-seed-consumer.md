---
id: 2026-11-09-semantic-gate-omitted-canonical-seed-consumer
date: 2026-11-09
title: Native semantic gate omitted the required canonical seed dump consumer
surface: infra
component: semantic-stack-startup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-deploy-semantic-stack.sh starts run.sh --benchmark without BENCHMARK_SEED_DUMP, selecting cold production sync instead of the reviewed canonical fixture
symptoms:
  - remote run existing gate deadline exhausted
  - LocalStorageOrigin source COPY failed
  - canceling statement due to statement timeout
tags:
  - deploy
  - canonical-seed
  - startup
sources:
  - PR #1881
  - commit bfa2941f72a052c4379f6131b2eb4860ee3d3ff7
  - PR #1881 Actions run 42690191178
repro: scripts/tests/run-deploy-semantic-stack.test.sh
status: mitigated
---

## Problem

The focused semantic aggregate remained UNVERIFIED after the launcher's existing work budget expired. The immutable artifact recorded 56 UI passes and four complete latency paths; the last path was interrupted before its final sample. Setup took 398 seconds, including a LocalStorage source COPY statement timeout followed by a successful retry. UI also ran more slowly than the prior passing attempt. No assertion failure or third-party outage was inferred from this incomplete execution.

## Diagnosis

The native semantic runner omitted BENCHMARK_SEED_DUMP, so the existing seed-cache selector chose cold-sync even though the exact schema/PG/revision-bound canonical fixture existed. The same narrow launch-environment repro fails on the original runner and passes on the repair. The automatic cancellation boundary was separately replayed: the 1800-second outer budget reserves 180 seconds for cleanup, leaving 1620 seconds for work. Why the source COPY and UI were slower than the prior attempt remains unproven; the fixture-wiring defect is independently reproduced and owned.

## Solution

For the existing native semantic token, configure the existing canonical dump consumer and require it. Preserve an explicitly configured dump path and leave manual invocation behavior unchanged. Missing or invalid canonical data fails closed; no cold-sync substitute, timeout increase, cooldown/sample change, assertion change or coverage reduction is allowed. The owning suite covers native/default/configured/manual cases and passed five unchanged runs. Parent review checked the fixture and call boundaries. The exact PG16 artifact downloaded in 1.36 seconds and restored through the unchanged restore helper in 4.395 seconds. The unchanged canonical validator confirmed 3825 WhatsApp messages, a connected integration, 241 archived trajectory rows across three runs, and the required named bench profile. The isolated validation database was removed. Full unchanged semantic execution on the integrated source remains required; this case is mitigated until that outcome is witnessed. This coordinator-only fixture wiring adds no per-agent production query, channel or hot-path state at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Wire every ephemeral benchmark consumer to the reviewed canonical fixture and fail closed when that fixture is unavailable.
