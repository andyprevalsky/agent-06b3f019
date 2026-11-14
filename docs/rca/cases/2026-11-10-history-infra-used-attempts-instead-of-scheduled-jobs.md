---
id: 2026-11-10-history-infra-used-attempts-instead-of-scheduled-jobs
date: 2026-11-10
title: Scorecard history projected infra attempts over terminal attempts instead of scheduled jobs
surface: harness
component: cloudbench-scorecard history HTML and text renderers
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: history renderers selected infra_attempts and terminal_attempts despite recorded infra_jobs and original scheduled_total
symptoms:
  - INFRA 0/1 in an eleven-task aggregate history row
  - native history scheduled_total11 scored1 infra_jobs0
  - retained retry attempts changed the history infra denominator
tags:
  - scorecard
  - history
  - denominator
  - scheduled-jobs
sources:
  - commit ec6c24c530ddbb04e1e49672dbda809a8f7a5f18
  - plan:.context/agentcard-e2e/stability-proof-20261109/postfix-round01-active-card-history-gap.json
  - plan:.context/agentcard-e2e/history-denominator-20261110/receipt.json
  - plan:.context/agentcard-e2e/history-denominator-20261110/parent-review-decision.json
  - plan:.context/agentcard-stability/combined-observer-report-application.json
  - plan:.context/agentcard-stability/combined-observer-report-public-checks.json
repro: python3 scripts/tests/cloudbench-scorecard.test.py, Scorecard.test_history_infra_uses_scheduled_jobs_not_scored_attempts; benchmark-scorecard deploy structural registration
status: fixed
---

## Problem

The latest-three history subrow showed `INFRA 0/1` after one scored task in an
original eleven-task native cohort. Recorded history already contained
scheduled_total11 and infra_jobs0. Top-level totals and the stop-policy note
correctly used0/11, with threshold1. This was a display projection error, not
an infra failure, an incorrect native threshold decision or lost custody.

The operator preserved the initial visual and gap receipt. A later retained
card snapshot, copied once without rewriting its counts or clocks, had two
scored tasks; rendering that identical JSON produced0/2 before and0/11 after.
Its SHA256 is
`ad25a089b6c81876bdea28fae13b9774e5ca3f5d5d1704807bb41e4e18eb1919`.
The initial0/1 observation and later0/2 snapshot are distinct dated evidence.

## Diagnosis

The recorded native experiment/history -> `_history_html` and `render_text`
path selected infra_attempts/terminal_attempts for the history fraction.
Those fields describe attempts, not unique infra jobs out of the original
scheduled cohort. Completion count and retained retries therefore changed a
visual denominator that should remain fixed. Correct infra_jobs and
scheduled_total fields were already available; no producer or schema repair
was necessary.

The existing owning scorecard suite gained a registered behavioral test that
calls the real HTML renderer and inspects its history section, as well as its
text counterpart. Identical final test bytes failed four of seven subcases on
the old renderer: eleven scheduled/one scored, cancellation without shrinking
original total, retry attempts versus unique jobs, and absent denominator
without invented zero. Standalone1, no-terminal-attempt and unreconciled
markers were also pinned. This is rendered-output proof, not a test mirroring
source strings. The prior local-worlds reader/custody case is a distinct input
admission boundary; this defect is the final history projection. Archive searches
`history infra scheduled attempts denominator` and
`INFRA 0/1 history renderers` found the campaign fixed-total stop case as another
relative: that case repairs controller policy, while this one repairs display
projection. Neither earlier boundary is being reopened or credited here.

## Solution

Applied exact patch SHA256
`7e7e523cf6676c634ca84d762ee89c053cb20623061ee869fc3441a1ece30de6`
changes only the existing HTML/text history expressions to recorded unique
infra_jobs/original scheduled_total and removes an unused local attempt
variable. It retains `NO TERMINAL ATTEMPTS`, `INFRA UNRECONCILED`, and
`INFRA UNMEASURED` for missing recorded data. Cancellation does not reduce the
scheduled total; standalone1 remains0/1. No classification is synthesized.

The other two patch paths are the existing scorecard test suite and one
campaign text golden: its history becomes1/5 unique jobs rather than2/4 retry
attempts. Attempt metrics themselves are unchanged. Final private proof:

- `python3 .context/agentcard-e2e/history-denominator-20261110/run-owning.py before`
  runs the same new registered test and fails4/7 subcases.
- `python3 .context/agentcard-e2e/history-denominator-20261110/run-owning.py after full`
  passes all53 owning tests, including that same regression.

The private runner preserves canonical dependency paths, substitutes the real
baseline/candidate renderer and private golden fixtures, and traps networking.
Native before/after HTML files are retained beside the immutable JSON snapshot.
Earlier diagnostic logs are labelled separately from the final proof.

Independent reviewer `ph7afnee3j0dm6axgjd98jq3tn8htpgr` accepted the exact patch
as code-only, deferred until the post-proof source boundary. The review receipt
is `parent-review-decision.json`, observed2026-11-10T04:13:49.613373Z. Its
verdict explicitly requires public owning checks after application and grants
no native proof credit. The parent applied that exact three-file patch at
23:15 UTC after postfix round05 resource cleanup and source release. The shared-source owning command
`python3 scripts/tests/cloudbench-scorecard.test.py` then passed 53/53 tests in
2.003s, exit0; the application and public-check receipts above bind the result
to the reviewed bytes. The regression is registered inside the existing
Scorecard class and the existing `benchmark-scorecard` deploy structural gate.

Status is FIXED for this rendered history projection only. No native task,
stop-policy threshold, failure classification, original count, cleanup receipt,
clock or streak was changed. The original 0/1 visual and 0/2 captured snapshot
remain preserved. Postfix round05's actual 10 PASS / 1 FAIL and the failed five-round
qualification remain authoritative. No new benchmark or app test was run to
integrate this tracked archive record.

## Human feedback

Keep the product/environment/source freeze during the healthy native proof.
Defer this display-only repair to the parent-coordinated source boundary.
Preserve original visuals, JSON, classifications, scheduled denominator,
missing/unreconciled markers, clocks, cancellation, custody, stop policy and
same-source streak accounting. No native launch or proof reset is authorized
by this renderer patch.

## Reusable lesson

Project unique infra jobs over the original scheduled cohort in every history
view. Attempts and scored counts remain separate metrics; display corrections
do not create native success or alter admission and cleanup evidence.
