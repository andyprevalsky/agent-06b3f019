---
id: 2026-11-06-benchmark-manifest-fixture-keyed-to-one-task-name
date: 2026-11-06
title: DoorDash cart-reauth benchmark ran without its pinned food-plan manifest because the harness keyed the fixture to the sibling task's name
surface: harness
component: run-benchmark-doordash-food-plan-fixture
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/run_benchmark.py _doordash_food_plan_prompt_override / _doordash_food_plan_manifest_context_for_judge / pre-run fixture apply all returned early unless task.name == DOORDASH_FOOD_PLAN_TASK_NAME ("browser-doordash-food-plan-grocery-order"), so the cart-reauth sibling that pins the same pinned_facts.manifest_source received the bare catalog prompt and an empty judge checklist
symptoms:
  - "manifest does NOT exist in any reachable local data source"
  - "Declared evaluator doordash-food-plan-cart-reauth-completeness failed"
  - "The explore searches returned no manifest, but an unavailable manifest is not an allowed omission"
  - browser-doordash-food-plan-grocery-cart-reauth FAILED HARNESS_FAIL
tags:
  - benchmark-fixture
  - doordash
  - food-plan
  - cart-reauth
  - task-name-keyed-wiring
  - llm-judge-context
sources:
  - agent 52a83b8b-69d2-4e96-b787-69b67a4759aa
  - fleet run 20261106-190604-1376118
  - commit 789ccbbde6
  - fleet run campaign-20261106-185145-1109152
repro: agents/tests/blackbox/benchmark.blackbox.py::test_doordash_food_plan_cart_reauth_receives_pinned_manifest
status: open
---

## Problem

Descend batch 3 epoch 1 (campaign-20261106-185145-1109152, job r001-j0016) ran
`browser-doordash-food-plan-grocery-cart-reauth` for the first time (0 prior
ledger attempts). Agent 52a83b8b's goal was the literal catalog prompt ("Add
every required Safeway manifest line item ... with manifest-allowed quantities")
with no manifest attached. The root spawned an explore agent to "Recover the
complete weekly food-plan grocery manifest the user refers to"; it reported the
manifest "does NOT exist in any reachable local data source". The declared judge
`doordash-food-plan-cart-reauth-completeness` failed: no manifest-valid cart,
"an unavailable manifest is not an allowed omission".

## Diagnosis

Both catalog tasks pin `pinned_facts.manifest_source:
doordash-food-plan-grocery-fixture.json`; the cart-reauth prompt and judge
both reference "the canonical manifest checklist". The harness wired that
fixture only by task name: `_doordash_food_plan_prompt_override`,
`_doordash_food_plan_manifest_context_for_judge`, the judge's task requirement
and supplemental cart evidence, and the pre-run `apply` in `run_single_task`
all checked `task.name == DOORDASH_FOOD_PLAN_TASK_NAME`. Commit 789ccbbde6
(2026-09-03) added the cart-reauth sibling with the same pinned manifest but
never widened that wiring, and no test covered the sibling's goal resolution.
The variant had never run, so the gap surfaced only in its first live run.

Deepest owned cause: per-task fixture wiring was keyed to a task name instead
of the catalog declaration (`pinned_facts.manifest_source`) that states the
dependency, so a new task with the same declared fixture got none of it.

Local repro (red, pre-fix): `cd agents && python -c` loader over
`tests/blackbox/benchmark.blackbox.py::test_doordash_food_plan_cart_reauth_receives_pinned_manifest`
failed with `AssertionError` at `assert checkout_manifest in goal`.
`_benchmark_goal_for_task(cart_reauth)` returned the bare task prompt.

## Solution

Harness-only (branch `rca/h-33-20261106`): `_uses_doordash_food_plan_manifest(task)`
derives the dependency from the existing catalog field
`pinned_facts.manifest_source`. The pre-run fixture apply
(`_prepare_doordash_food_plan_fixture`), judge task requirement, canonical
manifest checklist and supplemental cart evidence all use it. The grocery-order
task keeps its prod execute-prompt override unchanged. A sibling keeps its own
catalog contract (guest cart, stop at auth) and receives the frozen checkout
manifest table appended as data. A missing checkout table now fails closed
(`DoorDashFoodPlanManifestUnavailable`) instead of silently sending the
manifest-less prompt; the judge path falls back to the catalog prompt. A
sibling's judge receives only that checkout table, labelled as what the agent
received, never the order task's execute (checkout) prompt. The prod checkout
table (agent c27b4f28 message, 9,700 chars) itself carries the allowed omissions
(under-250-mg wrap, no-salt tomatoes), substitutions (PB2 -> tahini), P0/P1
labels, prohibited items and 99 Ranch scope, so no execute-prompt rules are
needed. Cart-reauth joins `EXCLUSIVE_SHARED_DB_TASK_NAMES` because it now runs
the same shared user-profile upsert. No tasks.json edit.
The same regression asserts that the unrelated `browser-doordash-usb-c-cable`
gets nothing.

Post-fix: the identical test passes. Full `benchmark` blackbox domain
(`python scripts/run_blackbox_tests.py benchmark`): 773 passed, 3 failed. The
three failures (local launcher proxy, sms runner gate, local start-services
platform selection) fail identically on the base revision in the lean worktree
(no `back-end/.env` or `node_modules`). A first run caught duck-typed judge
doubles without `pinned_facts`; the predicate now uses `getattr`. Golden
review of that snapshot (NOT_GROUNDED) found the sibling judge was handed the
order task's execute prompt as "the same source the agent received"; the
regression now asserts it is absent (red on fddf896140, green after). Final
full `benchmark` domain with `node_modules` and `back-end/.env` linked: 777
passed, 0 failed (EXIT=0). Still open: the agent-visible goal text changed, so this needs prompt
approval or golden-reference review. Outcome proof (`scripts/run-bench --local
browser-doordash-food-plan-grocery-cart-reauth` failing pre-fix and passing
post-fix) has not been run.

10k-agent behavior: one dict lookup per task at setup/judge time; no new
per-agent state, queries or fan-in.

## Human feedback

Golden-reference review (coordinator relay, 2026-11-06): NOT_GROUNDED because
the cart-reauth judge context claimed the order task's execute prompt was what
the agent received. Required: give sibling judges only the checkout table,
labelled truthfully; judge path falls back to the task prompt; add cart-reauth
to the exclusive shared-DB set.

## Reusable lesson

Key benchmark fixture, prompt and judge wiring on the catalog field that
declares the dependency (e.g. `pinned_facts.manifest_source`), never on one
task name, so sibling variants that declare the same fixture receive it.
