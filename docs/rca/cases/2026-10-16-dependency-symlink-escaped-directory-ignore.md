---
id: 2026-10-16-dependency-symlink-escaped-directory-ignore
date: 2026-10-16
title: Linked Python dependencies escaped directory-only source exclusions
surface: infra
component: cloudbench-worktree-patch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: root and agents Git ignore rules excluded venv directories but not dependency symlinks
symptoms:
  - "error: Could not access 'agents/venv/null'"
  - "DIRTY — shipped as a patch"
tags:
  - cloudbench
  - symlink
  - gitignore
sources:
  - PR #1525
  - fleet run 20261015-200010-17187
repro: agents/tests/blackbox/benchmark.blackbox.py test_cloudbench_worktree_patch_excludes_linked_dependency_environment
status: fixed
---

## Problem

The original V41 task controller logged `error: Could not access
'agents/venv/null'`, then reported no shippable workspace delta, while its
independent source panel described an untracked dependency link as a dirty
patch. The original log has SHA256
`f3beb20dcf8230639638cbd31f580afda10ed0d357d864f4628ce58fdee2679b`.
This was a recovered setup/source-report error, not proven to cause the
original infrastructure failure or task outcome.

## Diagnosis

The original controller used linked dependencies. Directory-only ignore
patterns `**/venv/` and `venv/` did not exclude the `agents/venv` symlink.
Git's untracked-source enumeration therefore supplied that link to
`git diff --no-index /dev/null agents/venv`. Git interpreted the linked
directory as a directory operand, emitted the captured error and produced
no patch. The independent provenance panel still saw the untracked link.

The permanent worktree-patch test reproduces the exact error with a real Git
repository and an external dependency directory. The two-test command
`PYTHONPATH=agents/tests/blackbox:agents agents/venv/bin/python3 -m pytest
--import-mode=importlib agents/tests/blackbox/benchmark.blackbox.py
-k worktree_patch -q` failed before the fix and passed unchanged afterward.
Test SHA256 was `f61460ea9d80622d882a47b85fee92cdb572bd1d344023573282b1af7589fc15`
on both direct pytest runs. A follow-up review found that direct pytest did not
prove normal runner registration. The final test was added to `run_all_tests()`
via `BlackboxResult.record`, then identical final test-file bytes
`a3c6a7b6aecaf3db661db8215a8e99dc613f45cabbacf208a4e1dac3e79b876c`
were exercised through discovery, `run_single_domain`, and `run_all_tests`:
old ignores produced one pass and the exact failure; corrected ignores produced
two passes. Unrelated records and judge calls were suppressed, so this verifies
the selected registered cases, not a full-domain pass. Receipts are retained in
`.context/pr1525-continuation/worktree-symlink-rca/actual-route-{red,green}.json`.
Literal-error and untracked/symlink/patch archive searches found
related dependency-isolation cases but no prior case for this boundary.

## Solution

Remove the trailing slash from the existing venv exclusions so both dependency
directories and their symlinks stay outside source enumeration. The generator
and source panel continue to consume the same Git ignore contract. No dependency
files are removed or modified, and no patch-generator fallback is introduced.

The regression verifies no stderr or patch for the dependency link, a clean
source panel, successful application of a real source edit and authored file
symlink, and unchanged external dependency data. It is registered in the existing
agents benchmark blackbox domain. Generic authored directory-symlink behavior
is a separate unsupported input distinction; this change does not claim to
redesign it. At 10,000 agents the change adds no runtime queries or shared state.

## Human feedback

The user required every error, including recovered errors, to receive an
identical registered RED-to-GREEN proof, and required preserving warm data and
Freedom. The fix excludes local dependencies without deleting them.

## Reusable lesson

Exclude linked dependency environments at the shared source-enumeration boundary so patch generation and provenance agree.
