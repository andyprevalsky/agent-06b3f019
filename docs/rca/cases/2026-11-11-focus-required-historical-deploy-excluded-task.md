---
id: 2026-11-11-focus-required-historical-deploy-excluded-task
date: 2026-11-11
title: Focus planning required a historical task explicitly excluded from future deploys
surface: infra
component: deploy-cycle-focused-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: focused_plan required all historical blocking checks even when a current source-bound explicit deploy omission removed the task
symptoms:
  - focused command omits an unresolved failing check
  - smoke/test-mass-agent-run-0
  - needs-focused-plan
  - focus exits2
tags:
  - deploy
  - focus
  - user-election
  - historical-evidence
sources:
  - PR #1881
  - commit 0cd91e38c150a0b0ae23c1c68737934a2de9b818
  - task operator-0cd-continuation focus-refusal.json
repro: scripts/tests/deploy-test-cycle.test.py Cycle.test_focus_honors_only_recorded_current_deploy_omission
status: open
---

## Problem

After the user explicitly excluded test-mass-agent-run-0 from all future deploys, the current plan omitted only that task. The actual focus command on0cd91e38 exited2 with `focused command omits an unresolved failing check`, before any focused gate launched. Four immutable historical blocking mass occurrences remained: f15a5c2ed03242f9ad4c8fdcf8144f0d, f50f35340eaf4ae591ecebbfe7b689fd, a3767bbb37f741b9a1c929d8e04b68bd and835b955535444119961d6b9cafa1fb01. Their historical failures and custody must remain, but they cannot require a task absent under the explicit current election.

This is an integration defect in future requirement selection, not a new task result or a waiver of the assigned multi-workstream1200-second/five-repetition/eight-load failure. The other14 smoke tasks, all17 current gates and six repair gates remain required.

## Diagnosis

focused_plan derived `required` from every historical blocking/execution-required occurrence and required it to be a subset of the new focused checks. It did not consult the already-recorded current-source deploy_selection_omissions. A plain intersection with current inventory would hide unrelated missing failures and was rejected.

The immutable operator packet binds native state58345386969776a60b894eb8df0cc6a4efc74a7ffc552bc23a2854ba50a43665 and focused payload1c09132c4fda04e3c79c3dbba708a660cdce4d68d4a1aea5c90fd19e5972f4f4. A pure copy replay reproduces the exact original ValueError. The candidate validates matching current-source omission rows, false executed/credit flags, and the same unique explicit reason in the current native-smoke catalog before excluding only absent historical requirements. In-inventory requirements remain mandatory. Missing/stale/changed/ordinary-quarantine authority still fails.

The audit covered focused records, failed/final records, result-derived failed_cases, advance, refresh, isolated_request, full_pass_binding/reuse qualifications, pending_completion_block and deploy_gates.next_step. Future records already derive from the current plan; completion still requires complete current inventory. The previously accepted isolated_request exception remains bound to the catalog and native source proof. Native preparation and historical-successor guards are unchanged. Ordinary refresh needed a narrow authority carry: the same catalog reason is revalidated before appending a new source-bound omission row, retaining the original audit row and all failures.

Archive searches for focused omitted failing checks and explicit deploy omissions found prior selection/custody work as related boundaries; no historical result was borrowed as current acceptance. This recurrence exposes the missing focus consumer of the already implemented user election.

## Solution

External candidate only: add current_deploy_omissions validation, consume it only for required historical checks absent from the current focused inventory, pass the actual root from the focus CLI, and carry unchanged explicit authority through ordinary source refresh. Never mutate historical failure objects or grant execution/cleanup credit.

The same owning test fails on original behavior and passes five unchanged repetitions on the candidate. It rejects missing/stale authority, executed or credit flags, changed catalog reason, ordinary quarantine, missing current requirements and unrelated historical omissions. It verifies authority carry across ordinary refresh without modifying failures. Existing focus, recipe, refresh and isolated-inventory neighbors pass. A pure actual-state replay proceeds through focused_plan, records and next_step without gate execution, retaining attempts/failures. Full native execution remains pending and the case stays open.

Golden reference: no UI, task prompt, evaluator, benchmark limit or approval-gated behavior changes. The explicit user election is the selection authority; original native receipts remain the evidence authority.

## Human feedback

The parent required current catalog plus recorded source-bound omission, rejected plain required-set intersection, and required auditing the later inventory consumers. It prohibited source/state/provider writes by this worker and retained all original failures and the whole-unit repair. The parent alone owns integration, native focus and subsequent gates.

## Reusable lesson

A future-only explicit task exclusion must be consumed consistently by repair planning as well as initial selection. Preserve historical failures independently from the current execution obligation, and require positive source-bound policy authority rather than silently intersecting away missing checks.
