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
