---
id: 2026-10-28-scorecard-partial-export-hid-live-shard
date: 2026-10-28
title: A completed controller export hid the other shard's live scorecard rows
surface: harness
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_sharded selected verified exports globally and skipped live counters once any export supplied rows
symptoms:
  - scorecard completed 20/40 while original shard counters showed 39 terminal and one running
  - one live INFRA and its shard outcomes disappeared after the other shard exported
  - exported shard displayed alone despite the coordinator retaining both shards
tags:
  - scorecard
  - sharded-controller
  - partial-evidence
  - observability
sources:
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - benchmark run original600-1793152917121861690
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
repro: scripts/tests/cloudbench-scorecard.test.py Scorecard.test_mixed_verified_export_and_live_shard_keep_all_scheduled_jobs
status: open
---

## Problem

At approximately 03:04 UTC, It7 shard 00 had a verified controller export
containing 20 terminal jobs: 18 PASS and two task failures. Shard 01 was still
LIVE with 17 PASS, one task failure, one INFRA and one running job. The
coordinator retained the original 40-copy schedule and had no final result.
The normal CLI scorecard displayed only 20 completed, 18 PASS and no INFRA.
Its original JSON, HTML, text, command and source inputs are preserved in the
launch owner's compact evidence bundle.

## Diagnosis

load_sharded used an any-export predicate to choose a global source. It read
all available export summaries, but its live-counter fallback ran only if the
entire merged row list was empty. One available export therefore disabled
live evidence for every other shard. This is a reader selection defect, not a
change in the underlying task grades or campaign state.

The original captured summary and live status replay reproduces 20 completed
and 20 unobserved before the change; per-shard selection produces 39 completed
and one running, with 35 PASS, three task failures and one INFRA. That offline
replay uses a clearly identified test-only summary archive because the owner
excluded the original 866 MB archive. It does not re-verify archive identity or
publish a replacement receipt.

## Solution

For each shard, prefer its existing verified-export summary; otherwise use its
existing live counters. Never count both sources for one shard. Preserve the
final result.json precedence, coordinator schedule, clocks and provenance.
Report a mixed source explicitly. Do not revive an exported empty summary's
stale live counters through the old global fallback.

The registered tests use the real archive reader, summary compactor, live
counter reconstruction, text renderer and HTML validator. They cover the
mixed case, stale counters for an exported shard, missing unexported status,
empty exported summary and final result precedence. Existing release and
lifecycle fields remain unknown for live counter rows; costs and timings are
measured only for rows supplying them.

The scheduled/stop denominator stays 40. The existing task success fraction
uses 38 scored jobs, and the existing infra rate uses 39 terminal attempts;
those distinct metrics are not rewritten to use the schedule as their rate
denominator. No task is regraded or promoted by this reporting correction.

Closest existing mechanism: cloudbench-shard-coordinator.merge combines each
available shard summary while retaining scheduled_total and missing_jobs.
OpenClaw status-all/report-data.ts at immutable
76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af similarly keeps independently available
report sections when another source is unavailable. That is a reporting
analogy; Rose's own readers supply the actual evidence precedence and bounds.

## Human feedback

The parent requested a scorecard-only repair while the 19380f9e9 campaign
remained frozen. No source update, provider call, paid run, resource mutation,
manual grade adjustment or integration into the active operator was performed.
The parent owns later integration and the normal CLI re-render.

## Reusable lesson

Choose evidence at the identity boundary it describes. A stronger source for
one shard does not replace evidence for another. Missing evidence must stay
visible as missing, and live status is not a release or lifecycle receipt.
