---
id: 2026-10-27-review-ledger-had-no-main-sync-path
date: 2026-10-27
title: The /deploy review ledger had no supported path for a main-sync-only HEAD after a clean final review, so lanes hand-edited it
surface: infra
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_review_cycle.py start_cycle — a third cycle is allowed only after cycle-two findings, and require_mergeable accepts only the exact reviewed HEAD, so a required main sync after a clean cycle two had no recordable state
symptoms:
  - "verification review is allowed only after cycle two found a valid issue"
  - "current HEAD is unreviewed; latest reviewed HEAD is"
  - PR CONFLICTING on generated docs/rca/INDEX.md after a clean final review
tags:
  - deploy
  - code-review
  - review-ledger
  - generated-files
  - scale-100-seats
sources:
  - PR #1574 (first hand-edited ledger, memory review-ledger-no-main-sync-path)
  - PR #1590 (S12 hit it again)
  - PR #1593 (S11 hit it again; hand-appended cycle 3 with a note)
  - task S17 of the 100-seat readiness audit
repro: scripts/tests/deploy-review-cycle.test.py
status: fixed
---

## Problem

Parallel lanes merge RCA cases into main constantly, and each case regenerates
`docs/rca/INDEX.md`. When main moved after a branch's clean final review, the
PR became CONFLICTING on that generated file. Resolving it needs a sync merge,
which produces a new HEAD. The ledger then refused both supported moves:

- a third cycle, because cycle two had no findings;
- the merge, because the new HEAD was not the reviewed one.

S2, S9, S11 and S12 all hit this on 2026-10-26/27 and appended a cycle entry by
hand. That is an unaudited bypass of the review gate.

## Diagnosis

`start_cycle` caps cycles at three and allows a third only after cycle-two
findings, which is correct for new code. `require_mergeable` binds the merge
to the exact reviewed HEAD, also correct. Neither recognised a HEAD whose only
difference from the reviewed one is base-branch history plus regenerated
derived files. The repro tests in `deploy-review-cycle.test.py` (sync merge,
generated `INDEX.md` conflict) fail on the old module because no such path
exists (`AttributeError: inherit_sync`).

## Solution

`deploy_review_cycle.py inherit-sync --head <sha> --base origin/main` records a
`sync-inherited` entry only when all of these hold:

- the latest real review is completed and clean;
- the reviewed HEAD is an ancestor of the new HEAD;
- every new first-parent commit is a merge whose other parents are on the base;
- the branch-only diff (fork point to HEAD, explicit generated-file allowlist
  excluded) is byte-identical to the reviewed one;
- every file the sync changed was changed on the base or is generated.

The entry stores the inherited-from HEAD, the base SHA, the diff hash and the
generated files touched. It does not count toward the three-cycle cap. Any
refusal means the change needs a real review cycle.

`/deploy` Phase 3 documents the command, and `semantic-deploy-gate.test.sh`
requires that text.

Regression (deploy-command structural registry, `deploy-review-cycle`):

- the generated-index sync is inherited and mergeable;
- a resolution that edits branch code is refused;
- a new non-merge commit is refused;
- merging history that is not on the base is refused;
- a review with findings cannot be inherited;
- sync entries do not consume review cycles.

Scale: a few local git diffs per deploy; nothing runs in production.

## Human feedback

The parent (S17 assignment) asked for a supported, audited path that verifies
byte-identity and main-side/generated-only changes, and never weakens real
review.

## Reusable lesson

- When a gate's only escape is hand-editing its state file, the gate is
  missing a state. Model the legitimate transition with its own evidence and
  refusals instead of loosening the existing rules.
- Generated files need an explicit allowlist; never infer "generated" from a
  path pattern.
