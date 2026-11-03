---
id: 2026-11-03-predeploy-resource-only-projection-rejected-standing-skips
date: 2026-11-03
title: Resource-only smoke policy projection rejected two explicit native standing skips
surface: harness
component: predeploy-terminal-receipt-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/validate_predeploy_receipts.py _validate required third_party RESOURCE_CODES for every nonpassing task, excluding explicitly reviewed standing native skips
symptoms:
  - "unconfirmed or nonresource task failure: claude-code-agent"
  - "unconfirmed or nonresource task failure: test-mass-agent-run-0"
  - "native launcher exit zero but receipt projection BLOCKED"
tags:
  - predeploy
  - standing-skip
  - terminal-receipts
sources:
  - commit 15251fd54e5bf9b5b88fa5e733ccda261e881be5
  - commit 740988beb558d4879897cb3fbc4d2151d258d6b8
  - commit 30f05795ad0af0e29973cc4f70f93d28b4a15066
  - agent ph7a82s0gwxrgsgy2vdj20vq098hh5gt
repro: scripts/tests/predeploy-receipts.test.py::ReceiptPolicy.test_native_seven_pass_two_standing_skips
status: fixed
---

## Problem

The required terminal smoke policy command exited 1 on a native cohort of nine
scheduled tasks: seven PASS and two SKIPPED, with launcher exit 0. The only
problems were the two exact nonresource failures above. Both source-bound
standing confirmations, complete inventories, timestamps, receipt/card hashes
and original exact benchmark/stack cleanup certificates were valid.

The private immutable archive SHA256 is
174409fdbee7ac5d616040bf36f153999d68f1faf3a4ac8d450bc4f5c37cd0fe
(38,093,781 bytes). All 21 manifest entries were verified before replay and
again after the fix. Raw records and historical helper remain private evidence.
No archived owner entered the canonical active benchmark directory or authorized
present process cleanup. This repair runs on a separate Bugs devbox from its
originating deployment, from fetched main containing the originating merge.

## Diagnosis

Flow: native task/evaluator receipts + reviewed confirmations + plan bindings
-> strict terminal/ownership validation -> release policy projection.

What: permitted native skips became BLOCKED. Where: _validate's sole exception
predicate required resource_scope=third_party and a RESOURCE_CODES member.
Why: it represented only the October 29 credit/storage decision, while Step 6
already permits Claude credential preflight skips and the October 25 standing
Human feedback permits typed unavailable shared-compute-pool skips. The
producer's _ci_should_fail already permits both. Proof: the identical command
below reproduced precisely the two failures before any helper edit; the owning
new test also failed BLOCKED != SKIPPED_WITH_WARNING on that same helper.
Problem: inconsistent consumers of an explicit exception contract. The next
cause is deliberate user skip/cooldown policy; changing judge behavior or
provider credentials would cross the owned repair boundary.

Gate: NOT_INTRODUCED relative to originating baseline
062d536ebe703645e3cebaa2a1c027f0c3e1361c and failed source
740988beb558d4879897cb3fbc4d2151d258d6b8: both helper blobs and fetched current
helper were SHA256
16ee6c6c92a15658b1330c6bb7ab908a98f4a616dd63b15d1e76d953951a483f.
Assigned repair ownership remains here regardless of attribution.

Archive searches: `unconfirmed or nonresource task failure` and
`standing skip terminal receipt policy`. The October 29 exit-zero case is a
related aggregate-summary defect, still OPEN; this does not claim its unknown
source or underlying resource cause is resolved. The October 25 case and
30f05795 establish intentional native/CI behavior, not provider billing proof.
Actual retained producer 404s leave credential/billing state unresolved.

Replay cwd: /home/boxes/rose/.context/receipt-policy-repair/replay.
Its scripts link resolves to current /home/boxes/rose/scripts; its .context
links only to the isolated private packet layout. Historical source is never
installed over the fetched helper. Exact argv, unchanged between RED/GREEN:

```bash
python3 scripts/validate_predeploy_receipts.py --summary .context/predeploy-runs/20261103-054617-832985/summary.json --run-dir .context/benchmarks/1793684779-833294-81444 --run-dir .context/benchmarks/1793685676-1276794-21886 --confirmations .context/native-app-server-rca/smoke-standing-confirmations.json --bindings .context/native-app-server-rca/smoke-receipt-bindings.json
```

RED: exit 1, BLOCKED, 7 passed / 0 skipped / 2 blocked, exactly the two original
problems. GREEN: exit 0, SKIPPED_WITH_WARNING, 7 passed / 2 skipped / 0 blocked,
no problems. All original native statuses/reasons and bytes are unchanged.
Private red-native.json and green-native.json retain the projections.

## Solution

Unify the existing hash/reason/provider/evidence/exclusivity/time confirmation
checks, then apply distinct resource-exhaustion and standing-policy predicates.
Standing confirmation codes bind the existing scope/provider and source policy;
they additionally require native and evaluator SKIPPED, displayed skipped and
source matching the plan. Claude requires its exact native preflight reason
and catalog requires_claude_code flag. Compute skips retain the producer's
permitted prefix and explicit shared-pool confirmation. Neither path infers
exhaustion from free log text. Warnings identify exception_kind and policy_source
and never project nine PASS or invent resource proof. The existing resource-only
nonzero-wrapper explanation cannot be satisfied by standing skips.

The existing owning suite preserves malformed-input, strict resource cause,
full cohort/source/time/exact cleanup and unknown-cause controls, adding the
native seven-plus-two projection and adversarial standing confirmations. A
source-contract test checks the current producer literals and policy files.
The suite already runs in predeploy_metrics.blackbox.py; register that same
suite in the always-run deploy structural registry too so scripts-only changes
cannot omit it. No new verification system or benchmark definition is added.
The 31-test owning suite passed five consecutive unchanged runs. The full
normal deploy gates and review are recorded in the matching deployment report.

Delete/unify/guard assessment: deleting the strict validator would hide missing
coverage; unifying shared proof checks removes duplication while preserving
separate existing policy domains. Moving policy into the agent runtime would
change unrelated behavior; a small explicit operational projection is the
owned boundary. Golden reference: not applicable (no approval-gated hunk).
At 10k agents there are no runtime requests, subscriptions, rows or locks added;
this read-only deploy helper processes only the bounded planned smoke cohort.

## Human feedback

The assignment requires unchanged real native receipts, honest seven-PASS/two-
SKIPPED reporting, preservation of strict resource proof and fail-closed unknown
causes, no credential/billing/cooldown/task edits, and completion through this
independent repair's own deploy. The October 25 Human feedback explicitly
permits unavailable token-pool tests to skip and preserves shared cooldowns.

## Reusable lesson

Project each explicit standing exception from bound native evidence separately from resource-exhaustion proof, preserving original skips and fail-closed unknown causes.
