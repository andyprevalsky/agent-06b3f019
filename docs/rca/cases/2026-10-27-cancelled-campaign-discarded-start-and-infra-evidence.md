---
id: 2026-10-27-cancelled-campaign-discarded-start-and-infra-evidence
date: 2026-10-27
title: Cancelled campaign hid started controllers and lost native child exit classifications
surface: infra
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-scorecard.py compact_rows and started_terminal treated empty no-retry attempts as no start; classify discarded child exit evidence behind cancellation
symptoms:
  - Guests released no terminal jobs yet
  - NO TERMINAL ATTEMPTS
  - cancelled campaign reports zero infra despite one child exit 125
  - all 20 cancelled jobs carry task_status INFRA_ERROR
tags:
  - campaign
  - cancellation
  - scorecard
  - receipt-binding
sources:
  - commit 34ff3f23e6efa9ced9ff75732357df973db14e86
  - benchmark run campaign-20261027-191411-2591810
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
repro: scripts/tests/cloudbench-scorecard.test.py Scorecard.test_cancelled_campaign_keeps_started_lifecycles_and_infra_uncertainty
status: fixed
---

## Problem

Polar k2 iteration 1 at 34ff3f23e ended cancelled at
2026-10-27T19:33:38.080084+00:00. The exact campaign was birth-checked and TERMed
at 19:32:24.721Z after r002-j0017 failed Fly config update with three 408s,
ending with native child exit 125 at 19:29:53.63Z. Every other native child
recorded exit 143. All 20 jobs were marked cancelled and all 20 synthetic task
records said INFRA_ERROR / no current run artifact produced; zero tasks scored.

The final card https://boxes.dev/visuals/vis_b7fa7a62c2e733aa83829725c749f048
reported 20 cancellations, zero terminal attempts, zero infra, and Guests
released / no terminal jobs yet. The launch owner supplied an immutable offline
bundle including all 20 summary jobs, native child markers, fleet cards,
lifecycle and release receipts. Exactly r002-j0015 had a matching provider release
seal; its full lifecycle still failed. The other release gaps belong to I7,
not this reporting fix. Native absence is not full release proof.

## Diagnosis

Path: native child supervisor exit marker and fleet receipts -> campaign summary
adapter -> compact_rows/classify/started_terminal -> CLI metrics and lifecycle.

The no-retry producer leaves attempts empty even for started controllers, but
started_terminal equated empty attempts with never-started cancellation.
compact_rows likewise excluded cancelled jobs from its single-attempt fallback.
The summary already held each controller's started_at and finished_at, so the
renderer discarded positive start evidence and hid every owned resource.

Separately, classify returned CANCELLED before preserving a proven earlier
infrastructure failure. The terminal INFRA_ERROR alone is insufficient: it is
synthesized for both the 125 and 143 paths after no task result exists. The
existing run_fleet_child_supervised producer in run-bench-fleet:17116-17164
writes native failure 125 and forwarded signal exits 129/130/143. The existing
cloudbench-startup-failure-archive.py:85-96 already distinguishes rejection 125
from cancelled accepted start 143. The original 20 markers are one 125 and
nineteen 143. No error-string classifier or mtime-based ordering is needed.

The full release check also incorrectly required successful full lifecycle,
conflating resource release with failed/cancelled execution. r002-j0015 has a
provider-teardown-verified epoch, matching run/owner/workspace metadata, and
released task stage, while lifecycle.status remains failed.

The checked-in reproduction fails on 34ff3f23e with `0 != 20` terminal attempts.
It then exercises actual native markers, missing-marker uncertainty, independent
provider release, canonical prior infra-stop membership, and foreign-cohort
rejection. Archive searches: `cancelled no terminal jobs yet INFRA_ERROR` and
`scorecard cancellation infra failure`. This is a relative of the earlier I2
campaign-handle fix, not a recurrence of that missing-handle mechanism.

## Solution

Count a terminal cancellation as started when it has either attempts or the
recorded start timestamp. Preserve never-dispatched cancellation as resource-free.
Read the native child marker only through the already task/run-bound fleet card.
For cancelled jobs with generic infra flags, 125 supplies confirmed infra and
129/130/143 supplies confirmed cancellation. Missing/malformed/other markers
remain explicitly UNCLASSIFIED in the KPI, outcomes legend, history and issues.
The canonical producer infra_stop membership also preserves known failures
through later cancellation, after checking the original scheduled membership
and denominator. Raw summaries are never rewritten.

Resource release and complete lifecycle verification now remain separate facts.
The real replay reports 1 INFRA / 19 CANCELLED / 0 scored, 20 terminal attempts,
1/20 provider releases and 0/20 successful lifecycles. Start/end epochs remain
1793128451.4080727 and 1793129618.080084. This does not claim to fix the Fly408,
the retained Machine/volume, missing release seals, or the original task outcomes.

The permanent captured-data regression is in the existing 43-test scorecard
suite, registered by scripts/run-deploy-structural-gates.py and /deploy. The same
assertions fail on the baseline and pass after the fix. The original native
bundle remains outside Git; the fixture projects only reporting fields.

At 10k jobs there is one additional small local exit-marker read per bound
fleet, no provider requests, polling, process mutation, or shared locks. This
unifies reporting around existing producer evidence instead of adding a second
classification system or changing runtime semantics.

Golden-reference comparison: the already-opened OpenClaw
src/state/backup-run-records.ts:64-103 and status.command-report-data.ts:49
separate persisted outcomes from status rendering. Claude Code status, Codex
exec reporting, and Hermes CI timing reporting have no equivalent fleet exit
contract. The precise native signal/exit distinction comes from the existing
Rose producer and archive reader cited above. No prompt, harness, task definition
or runtime-context change is included; no strong-grounding runtime approval is
claimed.

## Human feedback

The parent assigned I6 on 34ff3f23e, requiring offline red/green, preservation of
authentic infra versus induced cancellation, separate-branch ownership, no paid
run/deploy, and coordination with I7's release-producer repair. No scorecard fix
may manufacture native release evidence from primary absence.

## Reusable lesson

Keep logical cancellation, native child failure, controller start, provider release, and complete lifecycle as separate recorded facts when rendering campaign outcomes.
