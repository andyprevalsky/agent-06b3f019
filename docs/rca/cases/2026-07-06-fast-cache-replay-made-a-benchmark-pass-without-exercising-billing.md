---
id: 2026-07-06-fast-cache-replay-made-a-benchmark-pass-without-exercising-billing
date: 2026-07-06
title: A benchmark PASS proved nothing about compute-token billing because every LLM call was fast-cache replayed
surface: harness
component: benchmark-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: fast-cache replay path — 27 replays served the run at $0, so no fresh provider call was made
symptoms:
  - "benchmark parallel-tool-calls PASS with $0 cost and 27 replays"
  - '"$0 direct compute token" worker log lines that are replayed artifacts, not live calls'
  - validation appears to prove a provider/billing fix that was never exercised
tags:
  - benchmark
  - fast-cache
  - false-green
  - compute-token
  - validation
sources:
  - memory:project_compute_token_tables_missing_prod
repro: none-recorded
status: open
---

## Problem

The `parallel-tool-calls` benchmark was run on 2026-07-06 to validate the
compute-token fix and reported PASS. It did confirm the specific thing it could
confirm — the backend executed `ComputeTokenLineageLease findUnique → status=ok`
with no 500 — but it did **not** prove that fresh compute-token billing worked,
because the whole run was served by fast-cache replay: $0 cost, 27 replays. The
`$0 direct compute token` lines in the worker log that looked like proof of a
free direct-auth path were replayed artifacts.

## Diagnosis

Fast-cache replay short-circuits the LLM call before the provider is contacted,
so a run can be green on a code path whose _external_ half never executed. The
run's own cost signal ($0) is ambiguous: it is exactly what a successful direct
compute-token call looks like _and_ exactly what a replay looks like, so the
metric that would have distinguished them is degenerate. Nothing in the harness
output flagged "this assertion was satisfied by replayed data", so a
provider-facing fix was one inference away from being declared validated on
evidence that cannot support it.

## Solution

Not fixed in the recorded session. The correct discipline recorded there: treat a
fast-cache-replayed PASS as proof of orchestration only, and require a run with
replay disabled (or a distinguishing signal separating replayed $0 from
direct-auth $0) before claiming any provider, billing, or credential path is
healthy. The same trap applies to every benchmark used to validate an external
integration.

## Human feedback

None recorded.

## Reusable lesson

Never accept a benchmark PASS as validation of a provider or billing path when
the run was fast-cache replayed — $0 from a replay is indistinguishable from $0
from a working direct-auth call.
