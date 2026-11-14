---
id: 2026-11-08-predeploy-cap-warning-polluted-task-inventory
date: 2026-11-08
title: Predeploy cap warning polluted the machine-readable task inventory
surface: harness
component: predeploy-selector
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: select_predeploy_benches names format appended a repeated human warning separator to stdout consumed as exact task names
symptoms:
  - cloud smoke selector did not return an exact task inventory
  - check_standard_plan_typescript failed through staged_template
  - run-predeploy-cloud --list emitted 20 task names plus seven diagnostic lines
tags:
  - deploy
  - predeploy
  - task-selection
  - stdout
sources:
  - commit e001301076c6b3ff3c966b841bf6db03edcb4a8e
  - task .context/cli-nov08-round47-failures/deploy-pipeline.log
repro: python3 scripts/tests/run-deploy-pipeline.test.py
status: open
---

## Problem

Round47's deploy-pipeline check failed while building the standard staged template. The native terminal error was `cloud smoke selector did not return an exact task inventory`. The planner's TypeScript assertion never ran. Original failure evidence and all existing cleanup and financial obligations remain retained.

## Diagnosis

Gate: NOT_INTRODUCED by the compared51d5/70fb/e001 code at this output boundary. The selector's `main` and `scream_if_cap_hit` function ASTs are identical across those sources. This describes attribution only; the assigned repair remains required. The worker's eligible history and changed paths selected20 tasks plus one dropped candidate, unlike the smaller canonical selection.

The exact worker `run-predeploy-cloud --list` produced20 task-name lines followed by seven cap-warning lines. The warning's separator occurred twice. `deploy_test_plan.standard_template` consumes stdout with splitlines and correctly refuses a duplicate inventory. The same error reproduced in an isolated e001 source fixture using the recorded worker changed-file list and existing eligibility history. No cloud task was launched.

The first bad boundary is the selector's names serializer, not the planner's refusal. `scream_if_cap_hit` wrote the human warning to both stderr and stdout even for the machine-readable names format. A full list exactly at cap could likewise acquire a non-task warning line without the duplicate separator. Filtering warnings out of the consumer would conceal malformed producer output.

Archive searches used the exact task-inventory error and template/list-output behavior. The related2026-10-13-human-report-prefixed-read-only-json-output case explains the same separation of structured output and human reporting, on a different command path.

## Solution

Keep task selection, history eligibility, ordering, cap, dropped-candidate warning and planner rejection unchanged. The names format now emits its complete warning on stderr only. Human report formats retain stdout diagnostics. Permanent controls exercise capped names and report formats and exact-cap names, preserving the existing cap assertions and adding explicit stdout inventory checks.

The original focused TypeScript-plan check is red before and green after on the same selection inputs. Focused selector controls and the complete original pipeline command are recorded separately in the repair report. Initial scratch setup failures from missing source imports are retained and do not establish product failures. No dependency install or live cloud/provider operation was used. The native full47 outer result is not rewritten; parent review, integration and required combined-source gates remain pending.

## Human feedback

The user required a separate ignored scratch, preservation of active canonical and worker sources, exact original failures and assertions, no cloud tasks or provider/DB/financial operations, and no new agent or deployment. An unchanged passing selection below the cap was not accepted as cause or fix proof.

## Reusable lesson

A task-name stream is an interface. Keep human cap warnings visible on stderr without turning them into task identifiers.
