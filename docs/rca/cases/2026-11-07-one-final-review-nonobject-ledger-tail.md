---
id: 2026-11-07-one-final-review-nonobject-ledger-tail
date: 2026-11-07
title: Exceptional final review dereferenced a non-object ledger tail
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_review_cycle.py::one_final_review
symptoms:
  - AttributeError: 'NoneType' object has no attribute 'get'
  - one final review requires exactly three completed substantive reviews, latest clean
tags:
  - ledger-validation
  - json-shape
  - deploy-review-cycle
sources:
  - PR #1708
  - commit 77744c54e7da30fd57c8b1c3295b9f9c70249fd5
  - task review-findings-2109
repro: scripts/tests/deploy-review-cycle.test.py OneFinalMalformedLedgerTest
status: open
---

## Problem

Review finding 4503659926 identified an untyped AttributeError when a valid JSON ledger has three qualifying review cycles followed by a non-object entry. The unchanged native main/parser path reproduces the error with null, an array, a string, an integer and a boolean. No Git or ledger mutation is required to trigger it.

## Diagnosis

`read_state` validates that cycles is a list. `review_cycles` and `budget_cycles` deliberately filter non-object entries, so all three substantive cycles satisfy the exceptional-review prefix checks. The last raw entry is then dereferenced with `.get` without a shape guard. The first bad boundary is that raw-tail dereference in `one_final_review`; it escapes the existing typed `ReviewCycleError` path.

Gate: NOT_INTRODUCED relative to immediate prior 60ca: the complete owning module is byte-identical at 60ca and frozen 77744, and the same regression fails at the same dereference in 60ca. The exceptional route first appears earlier in PR1708 at 4a0623371f8814da22b48e16522dcd2181e782d0. Original 0d3a03ae0da476027bfceaf35724c75744062119 also lacks the exceptional route (native parser exit 2), and its deploy_cli.py file does not exist. Direct main b365 has no exceptional route, so native argparse rejects the new flags with exit 2 and cannot serve as a behavioral PASS baseline.

The new test invokes the actual `deploy_review_cycle.main` parser and start path with a temporary JSON ledger. It asserts the final error is caused by `ReviewCycleError`, checks exact fixture bytes are unchanged, and blocks Git, write_state and subprocess calls. All five malformed types raise AttributeError before the patch.

Archive queries `one final review approval pair invalid` and `malformed review ledger entry AttributeError` found related contract and shape-validation cases, not an exact recurrence. The full prior cases `2026-10-27-review-ledger-had-no-main-sync-path` and `2026-10-16-world-clock-decoder-dereferenced-nonobject-json` were read, including their Solution and Human feedback. Their lessons require preserving review-budget history and validating JSON object shape before dereference; neither substitutes for this reproduction.

## Solution

Check that the raw final entry is a dict in the existing eligibility predicate before accessing either field. The existing ReviewCycleError message and refusal remain intact. This rejects malformed evidence instead of filtering the tail away or resetting history. A global rewrite of ledger parsing is broader than the failing final-review invariant and risks unrelated history semantics. The existing registered deploy-review-cycle test file gains the permanent regression.

Same-cwd command `/usr/bin/python3 scripts/tests/deploy-review-cycle.test.py OneFinalMalformedLedgerTest`: frozen code exit 1 in 0.134134320 s; proposed code exit 0 in 0.122565980 s, same cwd, environment and test assertions. See `logs/ledger-same-cwd-before.*` and `logs/ledger-same-cwd-after.*`. Existing default-three, exact-fourth, no-fifth, no-reset and history controls pass in the 56-test owning suite.

The fix is integrated in the stabilization batch; status remains open while current-source full gates and deployment are pending. The CLI target suite passed 10 tests; the complete review-cycle owning suite passed 56. Five additional repetitions of each new regression target passed. This is not a full deployment gate PASS. The full deploy-cli suite was not run because its Collect tests create worktrees, forbidden by this assignment. No existing tests, assertions, registry entries, caps, retries, or timeouts changed.

## Human feedback

The user directed the existing browser/proxy/fresh-Tilion deploy to completion, explicitly asked for `/sync` and rereading `/deploy`, and directed relentless unblocking. Original clocks, failures, coverage, review history, capacity limits and Freedom remain protected. The coordinator, rather than a new direct user instruction, bounded this delegated investigation to frozen77744 and private outputs. There was no additional direct human diagnosis of this finding. The coordinator owns integration and current-source validation; the child did not mutate the actual review ledger or deploy.

## Reusable lesson

Validate the raw ledger entry shape at the eligibility boundary before dereferencing it, without filtering away malformed evidence or changing review budgets.
