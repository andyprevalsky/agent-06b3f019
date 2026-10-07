---
id: 2026-10-06-fleet-live-cards-omitted-run-start-timestamp
date: 2026-10-06
title: Fleet live report cards omitted the run start used to order the Hub catalog
surface: harness
component: benchmark-live-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet startup and aggregate report-card producers omit timestamp before live_bundle_from_report_card emits an empty string
symptoms:
  - live fleet publication lost its stable controller-start timestamp
  - queued DAILY50 group appeared then disappeared from the newest view
  - durable live run has an empty timestamp and is last in the catalog
tags:
  - benchmark-hub
  - cloud-fleet
  - live-publication
  - timestamp
  - catalog-order
sources:
  - commit 5c1fc870c237908db79191ed6c6ae5de5dd96e48
  - fleet run 20261007-001156-61479
  - plan:.context/fresh-claude-grouped50-20261006/daily50-visibility-packet/timestamp-source-review.safe.json
repro: agents/benchmarks/hub_upload_test.py
status: open
---

## Problem

The user reported that the queued DAILY50 group appeared and then disappeared.
Authenticated production detail and catalog GETs both retained the exact live
run and its fifty queued tasks. The row had `timestamp: ""` and occupied index
4859 of4860, outside a newest-first hundred-row page. This proves misplaced
catalog order, not deletion or replacement by the two-task canary. The user's
browser session transition was not directly observed; disappearance from the
newest view is the source-backed implication of the ordering boundary.

## Diagnosis

Both fleet report-card producers omit `timestamp`. The real Hub converter uses
`card.get("timestamp") or ""`; storage preserves the empty string because its
fallback applies only to null/undefined, then sorts timestamps descending.
The first bad data is the absent producer field, not the catalog's durability
or frontend reconnect behavior. Startup and aggregate controls execute the
actual producers and converter. Both fail on frozen5c1 with
`live fleet publication lost its stable controller-start timestamp`.

Archive searches covered `empty timestamp live report card disappears newest
catalog`, literal timestamp/catalog ordering, and `live fleet report card
missing timestamp newest list ordering`. The October4 live-results case is a
relative: it repaired absent live transport, whereas this boundary is an
omitted run-start field in transported cards. Its lesson still applies: useful
live visibility must remain independent of resource teardown.

The current stored row exposes no authoritative start metadata. The run ID is
created with caller-local `date`, without a UTC contract. Upload time and file
mtime are not run start. Forty-four retained rows have empty timestamps,
nineteen live. This repair does not rewrite that frozen control or invent
chronology for legacy records.

## Solution

Forward the existing `FLEET_CONTROLLER_STARTED_EPOCH` into startup and aggregate
card producers, converting it to an explicit UTC ISO timestamp. Preserve this
same original epoch across every refresh. It is conservative controller /
provisioning start before claim-or-clone, not confirmed provider allocation.
Do not reset the run clock to upload time or change execution/deadline budgets,
task verdicts, prompts, models, ownership or release requirements.

The identical two-variant command failed before the private repair (exit1,
1.571s wall; two failures) and passed afterward (exit0,4.825s wall; two passes).
It executes real producer code and conversion without provider calls. Existing
`live_response_preserves_phase_and_startup_label` quick registration selects
both variants; all old test module ASTs remain unchanged, Bash syntax passes
and no new Ruff violations appear. Both captured outer control births are
absent and their processes reaped. The fleet is a bootstrap recipe input;
combined source-policy review/stamping belongs to normal integration. No cold
dependency image inputs changed. Composition, deployed visibility and actual
browser verification remain pending, so status stays open.

## Human feedback

The user reported a disappearing queued group and requested truthful frontend
status without interfering with the independent LIVE control. The investigation
used authenticated GETs and isolated controls; it neither changed the running
control nor re-published its record. The requested read-surface fallback was
qualified against existing metadata instead of borrowing upload/mtime as start.

## Reusable lesson

Carry the original run-start timestamp through every live projection and refresh before using it to order the catalog.
