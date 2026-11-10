---
id: 2026-11-08-cycle-fixtures-inherited-parent-request-authority
date: 2026-11-08
title: Disposable cycle fixtures inherited the native parent request authority
surface: harness
component: deploy-test-cycle-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: setUpModule retains enclosing DEPLOY_GATE_REQUEST while tests create independent disposable custody
symptoms:
  - "historical custody: missing request-owned custody locator"
  - "FAILED (errors=4)"
tags:
  - deploy
  - fixture-isolation
  - historical-custody
sources:
  - PR #1708 full34 source74311e0479c97a8ba770646fa83bf84ba5893081
  - commit 74311e0479c97a8ba770646fa83bf84ba5893081
repro: scripts/tests/deploy-test-cycle.test.py
status: open
---

## Problem

Original full34 deploy-test-cycle completed255 tests in115.832s with four outer
errors. Three are the two Cycle historical-custody/import cases and the Relay
owned-supervision case. The fourth, large-run-artifact metadata-bound failure,
has a separate repair owner and is preserved unchanged. Original raw bytes and
all four traces are retained; no original numeric subunit exit was captured here.

## Diagnosis

The producer PID3517241 allowlisted environment confirms the exact attempt34
DEPLOY_GATE_REQUEST and width4. The coordinator sets that path; the structural
runner inherits it. Disposable fixtures construct their own custody, while the
module previously isolated process enumeration only. The real admission guard
at historical_custody.py:501 correctly rejects unrelated or missing custody.
The first bad owned boundary is the test fixture's inherited request authority.
The guard itself is correct and is preserved.

Identical original three-case command: before exit1 (5.434s unittest), after
exit0 (6.394s). The added registered subprocess regression also exercises those
unchanged cases with an explicit outer request. Added native negative controls
reject absent/foreign custody. The final regression set additionally verifies
module cleanup restores the enclosing environment. Exact commands, exits, times,
source hashes and output hashes are in result.json and per-run receipts.

Gate: NOT_INTRODUCED by743 versus incoming main6b505. All three method ASTs and
the custody production module match; both reproduce the exact failures. The
02874 same-named relay method passes but predates extra source/capacity assertions;
the two custody cases and module are absent there. Strict aggregate attribution
versus02874 remains UNKNOWN; changed files alone are not a causal verdict.

Archive searches used the literal missing request-owned custody locator and the
behavioral test inherited DEPLOY_GATE_REQUEST fixture environment. Independent
custody ledger transfer and archive mock environment cases are relatives, not
previous fixes of this exact fixture boundary.

## Solution

Private test-only candidate removes inherited DEPLOY_GATE_REQUEST once in
setUpModule with patch.dict/addModuleCleanup. Explicit native request scopes
still exercise unchanged authorization. All original method ASTs are unchanged;
production files, width4, caps, retries, budgets, parent environment and original
evidence are unchanged. The fix has no test-name conditional. The new test names
only identify original cases executed by the regression subprocess.

Existing structural gate wiring runs the owning unittest file and discovers the
new class. Supplemental original custody/startup cases pass after completing
their frozen helper closure; the socket case passes using a short relative
private temporary path. Earlier private setup failures are retained in result.json.
No full255/native gate PASS is claimed. Parent owns combined integration,
independent review and unchanged original full-gate rerun; this archive stays open.
No provider, resource, financial, cloud, or deploy credit follows from this test.

Golden reference: not applicable (ordinary test-only fixture configuration).
Simplification: isolate one shared fixture boundary instead of adding per-case
exceptions or weakening native custody. No production runtime or scaling changes.

## Human feedback

The user prohibited canonical/source/worker/DB/service/provider changes and
changes to assertions, caps, retries, deadlines or original evidence. Parent
separated the independent fourth error and retains ownership of all native
gates and the bounded final review. No new review was requested by this child.

## Reusable lesson

Remove enclosing execution authority at the disposable fixture boundary and preserve explicit native ownership rejection tests.


## Same-cause extension: smoke stamp and cross-devbox deadline fixtures

Full34 also emitted two additional actual failures on the same frozen743 source:
SharedCanaryStamp.test_the_smoke_launch_passes_the_shared_stamp_to_the_fleet and
AdapterPassesGateDeadline.test_execute_hands_the_deadline_to_the_native_cli.
The authoritative structural aggregate records original exits1, original9 tests
in0.250s/errors1 and original8 tests in11.151s/errors1. Both exact stacks reach
historical_custody.admission line501 through the real cloud execute function.
The deleted individual temporary logs cannot be hashed after cleanup; their hashes
remain UNRECORDED. Aggregate and derived-section hashes are separate evidence.
The native producer reads each unit output and prints it under its labelled header;
that source proof and the full byte-preserved aggregate are retained here.

Local unchanged affected tests each fail with the same guard before the fix and
pass afterward. Both fixture classes now isolate DEPLOY_GATE_REQUEST in setUp
with patch.dict and addCleanup. Original9+8 test-method ASTs and all assertions
are unchanged. Two additional registered tests per class execute the actual
original case under a poisoned outer request, and check restoration of the
parent environment plus actual rejection of missing and foreign custody.
All four new tests were observed failing before the setup fix and passing after.
Full private owning files pass11 and10 tests. Exact command vectors, start/end
wall times, exits and log hashes are recorded in extension result.json.

Gate: NOT_INTRODUCED relative to incoming6b505: all17 original test methods have
identical ASTs and the production historical-custody module is byte-identical;
both exact affected cases reproduce the same guard on6b505. Production code,
width4, caps56/140, task definitions, deadlines and retry budgets remain unchanged.
The extension patch touches only these two test files and does not overlap the
prior cycle patch. Its SHA256 is3f6ed508c6ea25138c6efb14963725c5e44c77c20afada8ff39a3572979f0049.
The prior cycle patch remains26d203bfdb13921d0074468582400e31950872b9a9d7356ba63e786ce6e25929.

The first supplemental full smoke run exposed the private directory's placement
inside canonical Git, so an intentionally outside-Git fixture discovered Root.
Its failed result is retained, and the private runner now sets
GIT_CEILING_DIRECTORIES to its private root before the full-file run. The canonical
canary directory already existed with unchanged timestamps before this task;
no corrective canonical write, removal or cleanup was attempted. This is private
fixture placement, separate from the original authority failure. Initial dynamic
module export omissions are also retained as incomplete-closure attempts, not
original cause evidence. All needed test source came from frozen git show743/6b505.

Archive literal and behavior searches are stored alongside this addendum. This is
an extension of the same fixture authority cause, not a new production cause.
The existing native runner registers both files explicitly. The original full34
FAIL, all old debt/clocks and cloud UNVERIFIED remain unchanged. Parent owns review,
integration and full native rerun; no new automated review was requested.
