---
id: 2026-11-02-deploy-policy-omitted-existing-review-and-retry-constraints
date: 2026-11-02
title: Deploy policy rewrite omitted existing substantive-review and bounded-retry constraints
surface: harness
component: deploy-command-policy
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The deploy.md policy replacement removed existing independent review and failed-job retry instructions
symptoms:
  - "FAIL: disabled fallback must not waive substantive CodeRabbit review"
  - "FAIL: /deploy must document the single failed-jobs retry"
tags:
  - deploy-policy
  - semantic-deploy
  - review
  - retry-provenance
sources:
  - PR #1580
  - commit 6ff4bcae6d0da979e8c6feb24c011f2698935108
  - plan:.context/deploy-boxes-default-20261102/command-rca/report.md
repro: bash scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The canonical command structural gate failed because the deployment policy
rewrite omitted the existing rule that a disabled Claude fallback alone cannot
close CodeRabbit clean. Restoring only that sentence exposed a second omitted
contract: documentation of the existing failed-jobs-only single retry.
The original aggregate command failure remains recorded; these are introduced
documentation defects, not evidence of a provider outage or an actual improperly
waived GitHub review.

## Diagnosis

Gate: INTRODUCED against main a3c4929f3bbd296766013a7545439b682015a6ef.
Main contains both constraints and passes the complete unchanged semantic gate
in 38.667s. Frozen 6ff fails the first required literal. The first private
candidate restores that rule but then fails the later retry-documentation
assertion. The final two-insertion candidate passes the entire existing gate
in 39.673s. Removing those two insertions reproduces the frozen command exactly;
the new user-authorized attribution and external-provider exception paragraphs
are unchanged. All existing test assertions remain intact.

The retry option already exists in the production deployment helper: it binds
to the same source, waits for the previous attempt to finish, reruns failed jobs
only, and permits exactly one retry. The defect was lost operational guidance,
not missing retry implementation. Source inspection and main/candidate native
controls are retained under the report's private evidence directory.

## Solution

Restore two narrow paragraphs in .claude/commands/deploy.md: disabled fallback
alone never establishes substantive-review clearance; a required same-source
retry of a non-waived failure uses the existing single failed-jobs retry option
with original successful-job provenance. Qualified external exceptions do not
require a retry. The root canonical semantic command gate also passed after
application, recorded in stabilization-semantic-command.log.

Independent review of exactly these documentation hunks was GROUNDED under
deploy-restored-review-and-retry-20261102, scope SHA256
93cc8a122a91717cf67db5388741bc237609cd428cb941a55dadf03590bd2f1f.
This does not certify the full release, a new GitHub workflow execution or
unexecuted deployment lanes. No runtime code, concurrency, timeout, test
assertion or acceptance threshold changed. At 10,000 agents the rule preserves
bounded retry ownership and avoids repeating already-successful jobs; this RCA
does not claim measured fleet savings.

## Human feedback

None recorded for this correction. The previously authorized failure-routing
policy remains unchanged.

## Reusable lesson

When replacing policy paragraphs, preserve independent operational constraints
and run the complete existing contract gate to expose later omissions.
