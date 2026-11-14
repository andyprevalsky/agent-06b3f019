---
id: 2026-10-27-campaign-scorecard-ignored-controller-receipts
date: 2026-10-27
title: Campaign scorecard ignored controller handles and verified release receipts
surface: infra
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-scorecard.py load_campaign only loaded fleet_dir, which non-retry campaign summaries do not record, and never derived campaign source provenance
symptoms:
  - src UNRECORDED
  - 28 AGENT FAIL reason UNRECORDED
  - Lifecycle verified 0/30
  - 0/30 terminal jobs · no native audit
tags:
  - scorecard
  - campaign
  - receipt-binding
sources:
  - commit 0d399ac5b85a9d4aeb649177a9f9cc0466b06371
  - commit 35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
  - benchmark run campaign-20261027-060019-631588
repro: scripts/tests/cloudbench-scorecard.test.py Scorecard.test_campaign_monitor_receipts
status: fixed
---

## Problem

Campaign A recorded 30 trustworthy verdicts (2 PASS, 28 FAIL, zero infra) at
35ae7f4a7. All 30 fleet lifecycle receipts were verified and all 30 had
provider-teardown-verified.epoch. The launch owner's read-only native inventory
at about 18:34Z contained none of the 30 primary IDs. Yet the canonical CLI card
https://boxes.dev/visuals/vis_903ed33060776a54813e17b96f993801 showed the literal
missing-source/reason/lifecycle strings above.

The owner supplied A-scorecard-receipts.tgz: original campaign summary, job logs,
fleet report cards, lifecycle and release receipts. It was extracted without
overwriting files. A second pristine copy remains under .context/rca-i2/original.
The two-job checked-in fixture retains one original PASS and FAIL, their original
clocks and relevant receipt fields; only filesystem paths are relocated by tests.

## Diagnosis

Path: controller report-card/lifecycle and job monitor handle -> campaign summary
adapter -> compact_rows -> CLI HTML. The raw artifacts were correct. With
retry_infra=0, run-bench-campaign records attempt_verdict, omitting fleet_dir and
release fields; the retry branch uses released_attempt and records those fields.
The renderer assumed only the latter shape. load_campaign did not read the exact
monitor command already consumed by run-bench-campaign.terminal_task, so it never
loaded the existing failure reasons or lifecycle receipts. It also never assigned
source_ref, even when every fleet recorded the same immutable source.

One original job (r001-j0009, polar-bu-060) contains its own monitor command at
line 205 and a nested infrastructure canary command at line 242. The first
command is the controller binding, as in the existing producer; requiring only
one command would wrongly discard this valid job. Every loaded card must match
that handle's run ID and the scheduled task before its fields can contribute.

The permanent test on 0d399ac5b fails with None !=
'35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1'. The exact 30-job offline CLI replay
also reproduced 28 missing reasons and 0/30 lifecycle. No benchmark was rerun.

Archive searches: `src UNRECORDED Lifecycle verified` and `scorecard campaign
receipts`. This is a relative of
2026-10-19-native-release-audit-ignored-retained-fleet-ownership, not a recurrence:
that case owns native export inventory extraction; this case owns the
campaign-to-fleet report adapter. No native audit extraction changed.

## Solution

The adapter now reads explicit fleet_dir or the existing first canonical monitor
handle, checks exact task/run binding, and consumes the existing report card.
Release requires the matching lifecycle, owner, workspace, provider seal metadata,
finite positive release epoch and released task stage. Missing/mismatched seals
stay unverified. It reports producer receipt verification, not a new native audit.
Campaign source is the unanimous full base SHA with complete job coverage;
partial or conflicting coverage remains UNRECORDED. Original summaries are never
rewritten, original start/end clocks and all outcome classifications remain intact.

The same regression passes unchanged after the fix, including nested-canary,
explicit-handle, custom campaign-root, missing/mismatched seal, invalid epoch,
and wrong-task controls. Registered in the existing benchmark-scorecard gate at
scripts/run-deploy-structural-gates.py and the deploy command's scorecard suite.
The full suite has 42 tests. Full campaign replay recovers 30/30 release/lifecycle,
source 35ae7f4a7 and all 28 reasons, retaining 2 PASS / 28 FAIL / zero INFRA and
epochs 1793080819.4384704 -> 1793126030.864443. It does not repair those task failures.

Simplification: reuse the producer's handle and persisted receipts; do not add a
second provider audit, mutate controller behavior, or rewrite the card by hand.
At 10k jobs this is one bounded-prefix log scan and a few local receipt reads per
job, with no provider calls, background pollers or shared mutable state.

Reference review: opened OpenClaw src/commands/status.command-report-data.ts:49
and src/state/backup-run-records.ts:64-103, which render status from persisted
producer records without creating or repairing state. This converges on that
read-only reporting separation. Searched/opened Claude Code status, Codex exec
event reporting, and Hermes scripts/ci/timings_report.py; none supplies this
campaign-specific receipt contract. The authoritative exact handle convention is
the existing Rose run-bench-campaign.terminal_task. No runtime-context, prompt,
task definition, orchestration or acceptance semantics were changed. No strong
grounding approval for a runtime change is claimed or required.

## Human feedback

The user required an offline owning red/green regression, original clocks and
genuine task failures preserved, no task edits, no paid benchmark and no deploy;
only a causally proven fix may be pushed with an I2-tagged commit.

## Reusable lesson

Bind campaign reporting to the controller's recorded physical handle and verified receipts regardless of retry policy, preserving unknowns and original clocks.
