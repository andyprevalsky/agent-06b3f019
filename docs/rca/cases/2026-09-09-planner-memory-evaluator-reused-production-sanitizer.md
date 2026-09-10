---
id: 2026-09-09-planner-memory-evaluator-reused-production-sanitizer
date: 2026-09-09
title: Compressor evaluator reused production sanitization as its privacy oracle
surface: harness
component: memory-compressor-benchmark
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_memory_compressor_bench.py privacy validation
symptoms:
  - "sensitive URL values passed the compressor evaluator"
  - "benchmark and production shared the same sanitizer"
  - "URL not in transcript: https://api.ipify.org?format=json\\"
tags:
  - planner-memory
  - benchmark-oracle
  - pii-redaction
  - independence
sources:
  - plan:agents/benchmarks/runs/memory-compressor-20260909T180703Z.json
  - plan:agents/benchmarks/runs/memory-compressor-20260909T184905Z.json
  - plan:agents/benchmarks/runs/memory-compressor-20260909T211210Z.json
repro: agents/tests/blackbox/planner_memory.blackbox.py
status: fixed
---

## Problem

The compressor benchmark validated sensitive-data removal with production-owned
redaction logic. That allowed a production bug and its evaluator to agree on an
unsafe result. It also searched JSON-serialized output for URLs, so an otherwise
grounded ipify URL acquired a trailing escape and failed as
`URL not in transcript: https://api.ipify.org?format=json\\`.

The evaluator path was `CriticalPath -> JSON serialization/shared sanitizer ->
privacy and URL assertions -> verdict`; the first bad boundary was conversion
away from structured fields and reuse of the implementation under test.
Archive searches for the exact URL error, `shared sanitizer evaluator`, and
`benchmark oracle independence` found no matching prior cause; this was novel.

## Diagnosis

The oracle was not independent: any omitted PII class in production was omitted
from its grader as well. Serializing before inspection additionally changed the
strings being graded. These are evaluator defects distinct from the production
sanitizer bug; combining them would leave future regressions self-certified.

## Solution

The benchmark now walks native record strings and implements an independent
security oracle for email, E.164/formatted phones, Luhn-valid PANs, credential
shapes, and decoded sensitive URL query values. Grounded URL checks operate on
the structured strings and strip punctuation without JSON escape artifacts.

The permanent blackbox proves the oracle rejects raw and percent-encoded email
query values and Luhn-valid cards while accepting the public non-Luhn TikTok ID.
`cd agents && python3 tests/blackbox/planner_memory.blackbox.py` passes that
regression, and the final production-path cp-v7 compressor run passed 74/74 in
`memory-compressor-20260909T211210Z.json`, including all 11 large traces.

## Human feedback

None recorded.

## Reusable lesson

Grade safety with an independent structured oracle that cannot inherit the implementation under test's blind spots.
