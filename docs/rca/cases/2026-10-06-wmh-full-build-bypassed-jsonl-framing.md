---
id: 2026-10-06-wmh-full-build-bypassed-jsonl-framing
date: 2026-10-06
title: Full WMH build bypassed the JSONL framing contract
surface: agents
component: world-model-harness-build
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_world_model_from_otel_jsonl published upstream Step serialization without jsonl_line framing
symptoms:
  - "Invalid JSON: EOF while parsing a string at line 1 column 4899"
  - WMH server exited before becoming ready
  - full corpus built successfully but model refused to load
tags:
  - wmh
  - jsonl
  - unicode
sources:
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
repro: agents/tests/blackbox/world_model_harness.blackbox.py test_build_world_model_from_archives_runs_actual_upstream_build_with_fake_provider
status: open
---

## Problem

The complete uncapped build finished with 12,519 real trajectories and 179,169
eligible tool observations. The unchanged 1,800-second fundraiser command then
failed during startup, before creating an agent. The native server rejected an
indexed Step with EOF at column 4899. Evidence is retained under
`.context/benchmarks/1791316208-73095-68424/`, and the original top-level log is
`.context/wmh-startup-jsonl-failure.log`.

## Diagnosis

The path is archived completed observation → escaped OTel JSONL → upstream
Step ingestion → upstream retriever save → published index → splitlines loader.
Physical index record 1944 is valid JSON and validates as a native Step. It
contains two raw U+2028 characters. Splitting that valid record with the native
loader's splitlines produces three fragments; the first reproduces the exact
EOF at column 4899. Thus archive data and ingestion are correct, but the saved
index violates its downstream framing contract.

The earlier checked-in Unicode guardrail exercised only incremental refresh.
Full-build ingestion decodes the OTel escapes; subsequent upstream save
serializes raw separators again. This is a recurrence of the historical writer defect
outside the covered path. Archive searches for the literal EOF and behavioral
WMH Unicode/full-build terms found no matching case file; the existing owning
regression records the September 9 occurrence.

The existing real-upstream full-build blackbox now injects U+2028, U+2029,
U+0085, and ordinary Unicode. Its unchanged native retriever load failed before
the fix with the same EOF mechanism in `.context/wmh-full-build-jsonl-red.log`.
The hypothesis's What/Where/Why/Proof/Problem fields are recorded in
`.context/wmh-full-build-jsonl-hypothesis.json`.

## Solution

Unify full-build publication with the existing jsonl_line framing function.
Stream physical records, validate each native Step and the parallel embedding
row count, then atomically replace the steps file before publishing the build
manifest. Decoded content, order, and matrix bytes are preserved. This applies
to every observation and also handles U+2029 and U+0085. Installed dependency
files are unchanged. A publication pass is linear in corpus bytes and retains
one record plus a memory-mapped matrix; it adds no per-agent serving path.

The identical causal command passed in `.context/wmh-full-build-jsonl-green.log`.
The deploy-owned blackbox runner passed the full world-model-harness domain,
including native build/load, full decoded-row equality/order, exact distinct
observations, matrix-byte preservation, idempotence, and malformed-record /
row-count rejection preserving original bytes. The final reviewed assertions
are recorded in `.context/wmh-full-build-owning-green-final.log`. Adversarial
review confirmed the cause and transformation; its permanent-proof objections
were addressed. The existing full artifact was
validated without another archive build: all 179,449 native index rows match
the matrix, and 13 records needed escaping. The 280 additional native rows
relative to eligible tool observations remain an audit item. All 97 checksum
export exclusions also remain explicit; they have not been silently recovered.

The exact fundraiser has been restarted with its unchanged prompt, evaluator,
and authorized per-run timeout. This case remains open until actual startup,
benchmark outcome, and viewer-visible replay acceptance are established; a
serialization test does not prove a successful fundraiser.

## Human feedback

The user insisted on finishing the complete corpus before running with WMH,
then providing the frontend link for inspection. No partial artifact was used.

## Reusable lesson

Exercise native build-save-load and incremental refresh against the same JSONL
framing contract; escaping transport input does not constrain later serialization.
