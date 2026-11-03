---
id: 2026-11-03-cloud-adapter-counted-nested-canary-as-parent
date: 2026-11-03
title: The cloud adapter counted a nested infra canary as a second parent fleet
surface: harness
component: deploy-test-cloud
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_cloud.collect selected the requested parent by counting every request-owned _batch directory
symptoms:
  - expected exactly one request-owned cloud fleet
  - capacity admission remained blocked for 300s
  - no current run artifact produced
  - worker result identity/inventory mismatch
tags:
  - cloudbench
  - smoke
  - native-handle
  - nested-canary
  - admission
sources:
  - PR #1662
  - commit dc8bc3d5df9df5f649d20c76e8e0ad7c1e727faf
  - commit 5809187aba1d200d6b4cd9aa0abad65eccb5b0e2
  - fleet run 20261103-043936-3384097
  - fleet run 20261103-044000-3392135
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb
repro: 'python3 scripts/tests/deploy-test-worker.test.py CloudCampaign.test_execute_fifteen_under_cap_uses_native_campaign_receipts_with_canaries'
status: open
---

## Problem

The focused smoke request edd06e1df1d3465c8a846922c3ff07e6 selected 15 checks on
5809187aba1d200d6b4cd9aa0abad65eccb5b0e2, frozen digest
cf86c901abe490faaeedb2d1c54ed24365d1ad059b563c2647f91d9fd03a620e.
Native parent 20261103-043936-3384097 ran its ordinary N2 infra canary
20261103-044000-3392135. Both canary stacks passed their strict infra probe;
they did not run either original task's benchmark evaluator.

Parent admission then refused 38 existing app Machines +15 fresh primaries
+4 boot-config replacements =57 against the app allocation56. The unchanged
300-second native admission wait expired. None of the15 original checks was
admitted. Their aggregate rows say INFRA_ERROR/no current run artifact produced.
The adapter subsequently counted both legitimate _batch directories and emitted
expected exactly one request-owned cloud fleet. All15 individual occurrence IDs
and unchanged original receipts remain in the private occurrences.json packet.
No original task execution is credited from the successful infra canary.

## Diagnosis

Gate: NOT_INTRODUCED for the native capacity predicate, comparing actual main
and merge-base dc8bc3d5df9df5f649d20c76e8e0ad7c1e727faf to frozen5809187aba.
The complete run-bench and run-bench-fleet files are identical. Replays of the
actual immutable capacity_reserve_slots body on both revisions refuse38+19/56
with DENY_MACHINE/projected57. This is app-local allocation, not provider org
exhaustion: the saved05:05 authority read reports75 organization Machines with
limit1000. Ordinary disposable lifecycle credits zero stopped-pool Machines;
20 stopped inventory records alone are not reuse authority.

Gate: INTRODUCED for adapter collection. Actual main has no deploy_test_cloud
adapter. The new collector assumes one _batch directory per request, while the
native producer prints the exact parent handle before starting its nested
canary. The actual580 collect AST reproduces the error in a private two-fleet
fixture. A bounded candidate selector uses the launcher-bound first parent
monitor handle without directory enumeration and refuses invalid path, owner,
status and duplicate launcher records. On the saved real parent, unchanged
collect_fleet still refuses the FAILED lifecycle. That control proves identity
selection, not cleanup, task success or a whole smoke pass.

Archive relatives were read: the September boot-config-width issue already clips
replacement demand to fleet width, while the earlier seventeen-check inventory case has no fleet.
Neither substitutes for this new two-real-fleet causal proof. No prompt edit or
golden-reference approval applies.

## Solution

The preferred minimal repair is to route every selected cloud inventory through
the existing ordinary campaign path, including15 tasks below browser cap16:
`--runs 1 --concurrency 15`, no --wait, `retry_infra=0`. Preserve the existing cap,
app allocation56, shared-CPU headroom, task budgets and selected inventory.
Ordinary campaign dispatch starts one foreground task controller per job and
uses native per-child admission; it does not require a strict campaign-wide
startup barrier. Existing collect_campaign and terminal_task select each job's
first native parent handle and validate its one-task provenance, inventory,
terminal publication and cleanup. No new direct-fleet selection feature or
allocation increase is needed for this repair.

A private owning count reserve/release control models provider visibility under
an allowed schedule: all15 one-task reservations progress under56, while
oversubscribed provisional reservations remain refused until a prior primary is
visible and its exact native reservation releases. This does not prove live
campaign admission, CPU/host fit, deadlines or benchmark success. Register the
15-below-cap routing/receipt regression and negative queued, provenance,
cleanup and publication controls in existing scripts/tests/deploy-test-worker.test.py
CloudCampaign coverage. Parent owns integration and subsequent unchanged native
verification; repair and all15 actual outcomes remain OPEN.

Physical release is separate. Parent native provider teardown is verified with
empty owned IDs; both native registry token directories are absent locally.
Parent lifecycle remains FAILED because its verified predicate also requires
execution completion. Canary resources are destroyed-provider-retained, not
absent. Both native audits retain exact viewer3384721/owner25a331399edac0caddf17eaa8891dd2b
with live-transfer-required. No separate successor transfer ACK was found.
Original adapter cleanup_complete=false and outer lingering_group=true remain
unchanged; the launch-only recovery owner must preserve that retained obligation
without awarding execution credit.

Private implementation evidence: the two-file campaign patch
`aedbc1d8a542dab800ad206340c0e3a6c8e9c6b9afc7a812f19808a7f09042c3`
now makes that existing path unconditional and explicitly passes `--retry-infra 0`.
The new registered15-below-cap control fails unchanged580 with all15UNVERIFIED
and passes the candidate; the author's owning Cloud and CloudCampaign log records
19/19 passing checks, including one selected task, the existing17-task path and
queued/provenance/cleanup/publication negatives. Independent review read the patch
and before/after logs, confirmed the five existing collection/capacity helper
ASTs unchanged, and found no blocking issue; it did not repeat the suite.
Synthetic per-child receipts and the real isolated count predicate prove adapter
boundaries only. They do not establish actual campaign scheduling, native
CPU/host admission, task timing or any original benchmark result. Native unchanged
verification remains required after parent source integration and canonical
owner reconciliation. Original15UNVERIFIED and retained Hub obligations remain.

## Human feedback

The parent reserved source integration, deployment and live cleanup, kept this
RCA lane read-only, and required separate evidence before grouping failures.
The user's standing instructions require completing the deploy and preserving
Freedom. The parent selected existing ordinary campaign scheduling, preserving
all selected checks, native capacity guards and configured maximum concurrency.
The diagnostic lane changed no parent source, application environment or provider state.

## Reusable lesson

Select native work through its producer-owned handles and schedule selected inventories through the existing per-task campaign rather than assuming one physical fleet directory per request.

Parent integration verification: both exact patches applied cleanly after the
actual-main sync. The owning cycle suite passed79/79 and the Cloud/CloudCampaign
classes passed19/19. Independent readers found no blockers. The native-cloud-only
reconciliation binds original coordinator and adapter bytes, all95 native proof
files, both audit seals and the retained Hub identity. Canonical reconciliation
completed at2026-11-03T05:23:10Z with native exit0; original bound files and native
attempts were byte-identical, and credit_granted remained false. This launch-only
overlay preserves the exact retained service obligation; it does not change the
original cleanup_complete=false or award a task result. Fresh unchanged native
validation remains required and this case stays OPEN.
