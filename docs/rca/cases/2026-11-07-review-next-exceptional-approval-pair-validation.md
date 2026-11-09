---
id: 2026-11-07-review-next-exceptional-approval-pair-validation
date: 2026-11-07
title: Exceptional review CLI delegated incomplete and conflicting approval arguments
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_cli.py::cmd_review_next
symptoms:
  - DEPLOY_REVIEW_NEXT BLOCKED
  - explicit native user approval evidence ID required
  - one final review requires clean current exact approved HEAD
tags:
  - review-next
  - approval-validation
  - deploy-review-cycle
sources:
  - PR #1708
  - commit 77744c54e7da30fd57c8b1c3295b9f9c70249fd5
  - task review-findings-2109
repro: scripts/tests/deploy-cli.test.py ReviewNextInputValidation
status: open
---

## Problem

Review finding 4503659904 identified that `review-next` forwarded an absent exceptional approval-ID or approved HEAD as an empty string. A complete pair could also be combined with `--verification-approval`. Native parser/dispatch reproduction confirms all these cases cross the child-command boundary instead of failing at the CLI input boundary. In the additional empty legacy-approval case, the wrapper silently omits the option and reaches the child's Git validation; the test blocks that call before it executes.

## Diagnosis

The first bad boundary is `cmd_review_next`: presence of either exceptional flag chooses the exceptional route, `or ''` manufactures its missing counterpart, and truthiness controls whether the conflicting legacy flag is forwarded. The downstream cycle validator rejects a nonempty conflict or missing value, but only after PR/state checks, HEAD reading, and delegation. Presence and completeness are different contracts and must be checked before any of those operations.

Gate: NOT_INTRODUCED relative to immediate prior 60ca0ff528360e8e54198cec54c00a11fab4a50e: both owning modules are byte-identical at 60ca and 77744, and the same native regressions fail on 60ca. Original 0d3a03ae0da476027bfceaf35724c75744062119 has no deploy_cli.py file, so no matching CLI behavior can be claimed there. The route originated earlier in PR1708 at 4a0623371f8814da22b48e16522dcd2181e782d0. Direct main b365bf8bd69346f872e5e2cb7218872155ca294d has no exceptional flags and rejects them with argparse exit 2; this is an absent-feature baseline, not a matching behavioral pass.

The native unittest entrypoint invokes the real `deploy_cli.main` parser and `cmd_review_next`, then the real child `deploy_review_cycle.main` against temporary fixture ledgers. Git, writes, review events, and subprocess calls are mock-blocked. Ledger bytes remain unchanged. The valid forwarding control stops at the child boundary and never authorizes an actual review.

Archive queries `one final review approval pair invalid` and `malformed review ledger entry AttributeError` found related contract and shape-validation cases, not an exact recurrence. The full prior cases `2026-10-27-review-ledger-had-no-main-sync-path` and `2026-10-16-world-clock-decoder-dereferenced-nonobject-json` were read, including their Solution and Human feedback. Their lessons require preserving review-budget history and validating JSON object shape before dereference; neither substitutes for this reproduction.

## Solution

Validate a nonempty exceptional pair first, reject any supplied legacy verification approval (including empty), and forward the validated original strings unchanged. The general class is invalid command-line argument relationships, owned by the CLI before side effects; broadening global ledger parsing would not enforce that caller contract. The regression is added to the existing automatically discovered deploy-cli owning test file, already registered by run-deploy-structural-gates.py.

Same-cwd command `/usr/bin/python3 scripts/tests/deploy-cli.test.py ReviewNextInputValidation`: frozen code exit 1 in 0.224465172 s; proposed code exit 0 in 0.148285370 s, same cwd, environment and test assertions. See `logs/cli-same-cwd-before.*` and `logs/cli-same-cwd-after.*` in the private handoff for the exact delegation/error evidence.

The fix is integrated in the stabilization batch; status remains open while current-source full gates and deployment are pending. The CLI target suite passed 10 tests; the complete review-cycle owning suite passed 56. Five additional repetitions of each new regression target passed. This is not a full deployment gate PASS. The full deploy-cli suite was not run because its Collect tests create worktrees, forbidden by this assignment. No existing tests, assertions, registry entries, caps, retries, or timeouts changed.

## Human feedback

The user directed the existing browser/proxy/fresh-Tilion deploy to completion, explicitly asked for `/sync` and rereading `/deploy`, and directed relentless unblocking. Original clocks, failures, coverage, review history, capacity limits and Freedom remain protected. The coordinator, rather than a new direct user instruction, bounded this delegated investigation to frozen77744 and private outputs. There was no additional direct human diagnosis of this finding. The coordinator owns integration and current-source validation; the child did not mutate the actual review ledger or deploy.

## Reusable lesson

Validate paired and mutually exclusive CLI arguments before reading state, resolving HEAD, or delegating any operation.
