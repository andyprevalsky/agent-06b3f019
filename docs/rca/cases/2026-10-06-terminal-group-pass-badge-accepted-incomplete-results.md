---
id: 2026-10-06-terminal-group-pass-badge-accepted-incomplete-results
date: 2026-10-06
title: Terminal benchmark group PASS badge accepted incomplete evaluated results
surface: front-end
component: benchmark-run-verdict-badge
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: BenchmarkRunView.verdictBadge inferred whole-group PASS from zero failed and any positive passed count without requiring complete evaluated results
symptoms:
  - one PASS plus one INFRA_ERROR terminal copy displayed a green group pass badge
  - one PASS plus one cancelled terminal copy displayed a green group pass badge
  - terminal group displayed pass while its Tasks tile correctly said 1/2 done
tags:
  - benchmarks
  - campaign
  - aggregate-verdict
  - infrastructure-status
  - cancelled
sources:
  - commit 422142e6e7611a640f89c30a07081847bbfe810d
  - agent /root/basic_claude_compiler_overlay_cli
  - plan:.context/cached-mass-latency-independent-20261006/frontend422142/mixed-terminal-v1/review-handoff.safe.json
  - plan:.context/cached-mass-latency-independent-20261006/frontend422142/mixed-terminal-v1/root-independent-absolute/terminal.safe.json
repro: front-end/src/tests/blackbox/benchmarks-live-results.blackbox.tsx
status: open
---

## Problem

The existing campaign scheduler inverse projected a terminal two-copy group with
one evaluated PASS and one infrastructure-only controller failure. The production
owner returned live=false, passed=1, failed=0, running=0, task_total=2 and one
infra_error. The second copy retained passed=null and cleanup-unconfirmed state.
An exact cancelled-controller variation produced the same complete DTO shape
with one cancelled copy. Rendering these owner-produced fixtures in the real
BenchmarkRunView showed a green group pass badge despite the partial benchmark
results. The individual rows and the 1/2 completion count were already correct.
This is owning scheduler and local component proof, not an observed production
campaign or native fleet outcome.

## Diagnosis

The path is existing scheduler outcome -> production group projection -> exact
HubRunDetail fixture -> BenchmarkRunView.verdictBadge. The scheduler fixture's
original inverse assertions passed and the backend preserved null benchmark
results, explicit infra/cancelled counts and unknown cleanup. The first incorrect
value is the aggregate badge: its failed===0 && passed>0 branch treats absence of
a negative evaluated verdict as complete group success. Controller termination
and a raw agent status cannot supply the missing benchmark verdict.

Archive searches were "BenchmarkRunView infra_error cancelled green pass" and
"terminal group partial benchmark results aggregate global task counts". The
frozen 2026-10-06-benchmark-group-label-used-preview-page-size case is a relative,
not a recurrence of its exact cause: that renderer used bounded array lengths
instead of full counts; this badge already had full global result counts but
never required completeness. Its three count/polling controls did not exercise
a mixed terminal verdict. The process-feedback guide was reread. The permanent
regression consumes the actual existing memory-R2 scheduler DTO shape and targets
this separate aggregate consumer.

## Solution

Require a terminal group to have passed equal its authoritative task_total,
falling back to pagination.total and then the existing task-array length only
when those fields are absent, before rendering the green PASS badge. Preserve
the existing live branch, legacy non-group behavior and generic red failed badge.
Keep backend DTOs, individual row statuses, evaluated results, cleanup labels,
model/task/evaluator behavior and polling unchanged. The authoritative total
supports preview/page bounds without promoting a passed page to whole-group
success. Delete/unify assessment: reuse the existing whole-group count at the
single incorrect render owner; deleting the badge would discard useful correct
status, while a new result store or backend result rewrite would duplicate or
corrupt the already correct source of truth.

The existing benchmarks-live-results.blackbox.tsx family retains all three
original controls and adds four parameterized real-component controls: mixed
infra, mixed cancelled, all evaluated PASS and genuine evaluated FAIL. Each
mixed case first verifies its correct individual status, cleanup-unconfirmed
label and 1/2 count, then requires a non-green aggregate verdict. Existing live
teardown/polling and global pagination counts remain asserted.

The unchanged final owning test SHA256 is
940d294db6fbb4abf44aa8d2622beefb985bcff5ea9e35441c8f86f0b2a6fab1.
Original 422142 is RED: 5 PASS, 2 FAIL, exit 1 in 6.890 seconds; both failures are missing
aggregate failed badges with the actual green badge rendered. The private
candidate is GREEN: 7 PASS, exit 0 in 6.848 seconds. Root independently ran the exact
frozen candidate/test and obtained 7 PASS, exit 0 in 6.169 seconds. The exact private
command is run-component.private.py --source original|candidate --receipt-dir
<private-directory> within the packet above. It uses pinned Node 22.13.0 and the
final candidate's own locked frontend dependencies. Earlier runner relocation
and stale dependency failures collected zero tests and are retained privately
with zero causal credit; they were not product failures. Root's relative output
path adapter failure is likewise excluded from product proof.

Candidate component SHA256 is
1815293b121ca32871070062cccfbec33bf64914e652b0c00d994531bb76aa27.
Only verdictBadge's syntax tree changes; all other component syntax trees are
identical. Normal Prettier and private patch application checks pass. The
existing Vitest blackbox include discovers this file, and deploy Step4b runs the
normal full frontend coverage family for frontend changes. No new suite or paid
verification is introduced. Full final-source frontend coverage, integration
and production group observations remain pending, so status stays open. This
packet claims no timing gain, benchmark acceptance or native 50-copy credit.

## Human feedback

The standing user requirement is accurate frontend task grouping and stage
reporting, including genuine evaluated benchmark results and exact teardown.
Root technical review required actual scheduler DTO evidence, real component
RED before code, unchanged GREEN, correct individual infra/cancelled states and
a private minimal change while the frozen deployment source remained active.
Root's independent seven-control run and source review cleared the packet for
coordinated integration. No new human approval or task-grade change was requested.

## Reusable lesson

Require complete authoritative group verdict counts before displaying aggregate PASS, while preserving individual infrastructure and cleanup facts.
