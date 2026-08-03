---
id: 2026-07-20-manifest-written-only-at-finalize-dropped-crashed-runs-from-the-corpus
date: 2026-07-20
title: The trace-archive manifest was written only at finalize, so any run that crashed first was silently dropped from the world-model corpus
surface: back-end
component: trace-archive
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/traceArchiveLifecycle.ts — manifest.json.gz.enc was written only at finalize, never at agent creation
symptoms:
  - crashed or SIGKILLed runs produce a bundle with no manifest
  - '`bundle_world_model_mode` reads a missing manifest as "unknown" and drops the run'
  - prod runs silently absent from the world-model corpus
tags:
  - trace-archive
  - world-model
  - r2
  - data-loss
  - manifest
sources:
  - memory:project_trace_manifest_at_creation_shipped
  - PR #813
repro: none-recorded
status: fixed
---

## Problem

Bundles for runs that crashed or were SIGKILLed before finalize had no
`manifest.json.gz.enc`. The WMH consumer
(`agents/benchmarks/world_model_harness.py:bundle_world_model_mode`) gates
eligibility on a manifest carrying `world_model_mode`, and a **missing** manifest
reads as `"unknown"` — so the entire run was silently dropped from the corpus. A
producer-side data leak with no error anywhere.

## Diagnosis

The manifest was only ever written at finalize, which means every bundle's
classifiability depended on the run terminating cleanly — exactly the runs least
likely to do so were the ones being discarded. Because the consumer's fallback for
"no manifest" is a silent skip rather than a failure, the loss was invisible from
both sides.

## Solution

PR #813 (merged to main `e0b1952`) writes the manifest at **agent creation**, in
`archiveAgentStartFixture`, root-agent-only and off the launch-critical path, so a
run is classifiable and world-model-ingestible from birth. Design points:

- A `finalized` flag distinguishes the start manifest (`false`) from the terminal
  update (`true`); finalize became an update rather than the first write.
- Creation-time `world_model_mode` is gated on `isBenchmark`: prod agents get
  `real` (a crashed prod run stays usable), benchmark agents get `pending`
  (non-eligible — they may be shadow/simulate and their true mode is only known at
  finalize, so a crashed sim run cannot poison the real corpus).
- `excludeControlArtifacts()` filters `manifest.json.gz.enc` /
  `manifest.public.json` out of `listArchivedObjects()` refs so the manifest never
  indexes itself now that it exists from creation.
- No DB schema change — the flag lives in the JSON manifest.

Fixing it at the producer avoided a reaper process and any risky force-failing of
live agents. Verified live on prod agent `589b7282…`: manifest in R2 at creation
(`real`, `finalized:false`, eligible) → `finalized:true` at completion → WMH derived
8 real transitions.

## Human feedback

CodeRabbit flagged the benchmark-vs-prod `world_model_mode` gating as a Major issue
and confirmed the fix — benchmark agents must start `pending` rather than `real` so
a crashed simulate run cannot enter the real corpus.

## Reusable lesson

Write the record that makes data classifiable at creation, not at finalize —
otherwise every crashed run is silently discarded by a consumer whose
missing-metadata fallback is "skip".
