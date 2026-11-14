---
id: 2026-11-03-deploy-refresh-after-completed-focused-gates
date: 2026-11-03
title: Hourly source sync could not rebind a completed focused validation phase
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: refresh refused the quiescent failed-gates phase after a completed focused sweep
symptoms:
  - source refresh only at the repair boundary
  - source/plan changed; refresh after RCA before running
tags:
  - deploy
  - source-refresh
  - lifecycle
sources:
  - PR #1662
  - commit 2c1acbc4ea40fbc9c8167ebb17c12df518bf32a9
  - commit b23cc68ccd2c6c08cbb50a0c909844cfacec5e6c
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_failed_gate_boundary_refresh_keeps_history_and_revalidates_new_source
status: fixed
---

## Problem

After the focused native sweep completed and its only remaining compute-judge
skip was qualified, the cycle correctly advanced to `failed-gates`. A normal
hourly main sync then changed source at this quiescent boundary. The next run
refused the stale source, but the refresh command also refused this phase.
There was no supported transition that preserved the existing ledger.

## Diagnosis

The refresh phase allowlist omitted `failed-gates`. `resume` requires an
interrupted cycle, `focus` requires a focused-plan boundary, and `init` refuses
an existing state directory. A synthetic failure, reset, or manual phase edit
would bypass the recorded lifecycle rather than repair the missing transition.
The registered regression exercised the actual refresh CLI: the old command
returned2 where the legitimate source rebind required0.

## Solution

Admit `failed-gates` to the existing refresh allowlist. The unchanged exclusive
state-directory lock prevents refresh during a running coordinator. Pending
occurrences, removed gates/checks, stale source and contract changes still
refuse. The same refresh invalidates affected results and qualifications,
preserves original failures, attempts, round and repair gates, clears the old
focused plan and requires quick, focused, full failed-gate, quick and full final
validation before readiness. No result or cleanup owner receives credit.

The owning suite passes81 tests, including the fail-first CLI transition,
exclusive-lock refusal, immutable history, full later inventories, current
source bindings and atomic pending/dropped-inventory refusals. This repairs the
source-rebind command; it does not claim that the later native deployment gates
or production verification have passed.

## Human feedback

Standing instructions require hourly main synchronization at safe boundaries
and autonomous completion. No new approval was requested. The parent required
the existing supported path to be checked first, prohibited ledger resets and
invented failures, and retained the normal validation sequence.

## Reusable lesson

A coordinator that rejects stale source must also expose a safe source-rebind
transition at each legitimate completed-phase boundary. Reuse its lock and
invalidation rules instead of manufacturing a failure to reach an allowlist.


## November 4 follow-up: completed repairs retained stale focused routing (OPEN)

A later source-refresh audit at `8c63501f0afa0e3f4c5aafd3e29e01a119eb5f2a`
found a second defect in this same transition. `refresh` removed a historical
`repair_gates` label only when the old FULL PASS could be carried to the new
source. All current gate inputs default to `*`, so two unrelated fixture edits
prevented carry and left already completed healthy repairs in FOCUSED alongside
the actual latest failed or incomplete gates. Requiring new-source FULL proof
was correct; retaining the old repair routing was not. The November 4 user
instruction requires independent gates to remain concurrent and reserves the
focused-test/full-failed-gate exception for actual failing work. This is not a
reason to serialize gates or grant a changed-input PASS.

The private correction consults the existing strict latest old-source FULL
native binding before refresh replaces fingerprints or qualification
projections. It retires only a nonquick historical repair label with unchanged
execution contract/environment and no pending occurrence, explicit triage
routing, retained owner or unresolved running state. Unknown ownership or bad,
partial, stale or later failed proof keeps the label. Changed inputs receive no
carried PASS: ordinary current-source FINAL still selects the gate, and verify
refuses readiness until its new FULL native result exists. Quick labels remain
unchanged because this helper deliberately provides no quick-pass binding.
Original receipts, failures, history, clocks, inventories and validation guards
are preserved.

The registered causal control
`Cycle.test_refresh_healthy_old_full_pass_leaves_focused_but_requires_new_final_full`
failed against the original production function because the healthy gate stayed
in the repair set. The same control passes with the private correction and
proves FINAL selection plus readiness refusal before a new FULL result. Five
new registered methods pass with eleven latest-result/pending/owner/binding
subcontrols, qualified-failure preservation and quick-label refusal; eight
existing relevant controls also pass. All 146 original test-method ASTs are
unchanged. An initial private export-support error for the unchanged benchmark
task catalog was retained, then resolved by copying that exact source file;
no assertion was relaxed. No full suite or native gate was run in this lane.

Patch SHA256:
`b71fa84f7d111cfcfb07b53896fb81f8d2b060089429aa8f1583ccb0652b9207`.
Independent blockers-only review is CLEAR. Private evidence lives in
`/var/tmp/pr1662-8c-repair-set/` and the parent received immutable copies. The
parent has applied it only to the private combined validation batch; integration
and actual current-source validation remain parent-owned and are not credited
by this RCA. This follow-up stays OPEN until that validation establishes the
repair in use. The separate backend qualified-domain parser defect has its own
owner and does not share this routing cause.


## November 11 follow-up: runtime drift trapped an unstarted carried quick phase (OPEN)

The original cycle at source `6fa45df7088257019808536f8fa6b984778300e9`
retained 13 unresolved older-source occurrences after a supported triage
refresh. It was `quick`, not ready, with `failure_phase=refresh` and
`next_after_quick=triage`. There were no active/running/resume/live-failure
markers, current-source quick attempts, or current-source quick receipts.
Before any new quick execution, the managed runtime configuration changed.
The actual saved run log emitted `DEPLOY_CYCLE BLOCKED: source/plan changed;
refresh after RCA before running`. Source and plan matched their saved binding;
input fingerprints differed even holding the saved process environment fixed.
No private environment values were displayed or changed by this worker.

Two archive searches were `refresh requires triage pending failures quick` and
`unstarted quick environment fingerprint changed source refresh deadlock`.
This is a recurrence of the safe-rebind transition gap documented by the
November 3 case, at a different legitimate boundary. The original `_refresh`
required pending work to be in triage, while its unstarted-quick predicate
required no pending work. Its own preceding supported triage refresh creates
quick with carried pending work. When runtime inputs change before that quick
phase starts, both the next execution and the only rebind path refuse.

The isolated candidate admits only this quiescent, unstarted, carried-pending
quick boundary to the existing refresh implementation. It requires exact
quick/triage/refresh markers, ready strictly false, unique pending IDs resolving
to original failures, no active/running/resume/resume_phase/live_failures keys,
no cancellation, and no current-source quick attempt or quick result anywhere
in attempt history. Stale or empty current-source quick attempts still refuse;
result source falls back to its enclosing attempt for legacy receipt shapes.
Pending nontriage work without these proofs remains refused.

The normal refresh code then rebinds inputs, selects all quick gates again,
and routes completion back to triage. It preserves original pending IDs,
failures, sources, attempts, ownership evidence and clocks, grants no PASS,
retirement or cleanup credit, and still requires actual changed inputs. Its
exclusive state-directory lock, source/plan/contract/check inventory guards,
and later full execution/readiness rules are unchanged. No new receipt or
special waiver is manufactured.

Three new methods in the registered `scripts/tests/deploy-test-cycle.test.py`
reproduce the runtime-only trap, preserve every original debt/history field,
prove every quick gate is selected, and exercise active/interrupted/current-
attempt/current-receipt/unknown-ID/duplicate-ID/source/contract negative
controls with unchanged input state on refusal. The unchanged production
function fails the positive repeat-refresh assertion with the actual pending
boundary error; the candidate passes all three. Three existing refresh/triage
controls also pass, for six focused methods total, not the full suite.

A separate read-only replay calls `_refresh` only on a deep copy of the actual
13-occurrence cycle and plan, with process environment fixed to the recorded
binding. It never invokes the refresh CLI or writes the real state/config.
Initial replay preconditions failed because parent-authored closeout docs
changed source during the investigation; those setup failures are explicitly
excluded from causal credit and recorded in the tool transcript/observation
note. The parent restored the original frozen source and quiesced writes for
the subsequent frozen-source replay. Actual rebind/execution, source
integration and complete deployment remain parent-owned and unverified here.

This is a bounded coordinator transition, outside live agent execution. It
adds no provider operation, lock, polling channel, timeout, concurrency change,
receipt rewrite or per-agent hot-path work at 10,000 agents. Golden reference:
not applicable (no approval-gated hunk). The parent required isolated source
and test copies only, immutable native debt, narrow admission and a reviewable
patch within 15 minutes; no canonical source/state/config edits were made by
this worker.

Final proof qualification: attempt2's actual saved-state replay reached the
owning pending guard (RED exit1) and passed on the candidate (GREEN exit0)
against a legitimately current-source in-memory new plan, preserving all 13
occurrences and actual state/plan bytes. That is valid historical boundary
proof. A later attempt to strengthen it to the restored original frozen source
failed the replay's final source-stability assertion when the parent integrated
the approved patch during the read. That later frozen replay is NOT a PASS and
receives no acceptance credit. The runtime-only fixture is valid fail/pass;
there is no claim of a successful latest frozen native cycle execution. Parent
integration now matches the isolated source/test hashes, but actual refresh and
full final execution remain solely parent-owned.


Integration note: the coordinator applied the reviewed exact phase guard and all three new registered tests passed. Actual live cycle refresh and every final-source gate remain separate required validation; no original receipt or resource debt is changed by this repair.
