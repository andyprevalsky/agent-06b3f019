---
id: 2026-11-07-predeploy-cap-warning-corrupted-machine-output
date: 2026-11-07
title: Predeploy cap warnings corrupted names and JSON selector output
surface: harness
component: predeploy-selector-output
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: select_predeploy_benches.scream_if_cap_hit appended a human warning to machine-readable stdout
symptoms:
  - cloud smoke selector did not return an exact task inventory
  - json.decoder.JSONDecodeError Extra data
  - run-deploy-pipeline.test.py check_standard_plan_typescript exited 1
tags:
  - predeploy
  - selector
  - stdout
  - cap
sources:
  - PR #1708
  - commit 60ca0ff528360e8e54198cec54c00a11fab4a50e
  - commit b365bf8bd69346f872e5e2cb7218872155ca294d
  - commit 0d3a03ae0da476027bfceaf35724c75744062119
repro: agents/benchmarks/select_predeploy_benches_test.py::test_cli_machine_formats_keep_cap_warning_on_stderr
status: open
---

## Problem

The native deploy-command-structural subgate ran `python3 scripts/tests/run-deploy-pipeline.test.py` and failed after 151.6 seconds. Its unchanged TypeScript recipe check called `staged_template`, whose real `standard_template()` child rejected cloud smoke inventory at line 170. The full original registry also found the same inventory error in semantic-deploy, seed-memory-ratchet, deploy-gates and deploy-test-github; those are additional consumers of the same producer defect. The original log is preserved as `original-native.log`; hashes, commands and outcomes are in the sibling result.json. This is local planning, with no cloud launch.

## Diagnosis

Gate: NOT_INTRODUCED. The faulty warning function has identical AST hashes at original 0d3a03ae, pinned main b365bf8b and frozen PR1708 60ca0ff5. The relevant planner, selector, launcher, catalog and pipeline test are byte-identical between b365 and 60ca. With recorded worker changed paths, original 0d3's own catalog/history selects 17 tasks and its planner passes; b365's own catalog/history selects 20, drops one and its planner raises the same ValueError. Main added four AgentCard tasks to the smoke floor. This exposes an existing output bug; reverting those tasks would weaken coverage and is not the fix.

Critical path: worker Git diff and catalog/history -> selector selected list -> `scream_if_cap_hit` -> `run-predeploy-cloud --list` -> `standard_template` -> TypeScript recipe check. The worker's origin/main is d16c934b7e19446d7069c7f76d8dd550b2058a96, whereas Root's is b365bf8b. Its Git discovery produced 964 changed paths. The initial private copy inherited Root's Git discovery, selected only 13 tasks and passed: that was an invalid input reduction, not proof against the failure. The corrected replay records the worker's exact path list and supplies it through the selector's existing PREDEPLOY_CHANGED_FILES interface. Source, catalog, history, interpreter, worker environment and umask are otherwise retained; TMPDIR and bytecode writes are confined to the private tree.

The selector itself exits 0. Its raw stdout has 27 lines: 20 unique selected task names followed by the seven-line cap warning. The warning's opening and closing exclamation separators are identical. Thus the planner rejects duplicate lines as it should. The original selected tasks remain valid. At an exactly-full cap without drops, the extra warning becomes a phantom task; JSON mode also gains trailing non-JSON text. These are siblings of the same output-ownership defect.

What: valid selection fails inventory validation. Where: the two stdout writes in scream_if_cap_hit. Why: human diagnostics share the machine protocol stream. Proof: corrected exact full subgate fails at the original stack in 161.616 seconds; identical local planner command fails in 0.691 seconds, then passes in 0.667 seconds after only the two-line fix. Problem: logical inconsistency between human reporting and machine-readable output contracts.

Archive queries: `cloud smoke selector did not return an exact task inventory`; `staged template selector subprocess environment fixture`; `HARD CAP stdout selector names`. Related cases were 2026-11-02-deploy-reuse-fixtures-inherited-freshness-kill-switch, 2026-09-11-predeploy-selection-ignored-production-only-eligibility, and 2026-10-13-human-report-prefixed-read-only-json-output. Their solutions and human feedback were read. This is a distinct selector-output incident, not a recurrence at those boundaries. No agent bug-report query applies: this is a local script, not an agent task.

## Solution

Private proposed patch only: delete the warning helper's two duplicate writes to stdout. Keep its complete stderr warning. Human `report` and `names-and-report` output already embeds the warning through `format_report`, so human visibility is preserved. Selection, cap 20, history, catalogs, evaluators, timeouts and planner assertions are unchanged. The cap is not raised and no output filtering or empty-inventory fallback is introduced.

Add four real subprocess regressions covering names/JSON at a full cap with and without drops. Strengthen the existing human report test to require the warning on both stdout and stderr. Register the regression in the existing benchmark blackbox domain. The four new cases were observed failing before the fix. The full selector module passes all 28 cases for five consecutive unchanged runs. The registered wrapper fails against the old source and passes against the fix through BlackboxResult. Full benchmark-domain execution is not claimed because it includes paid/live tests outside this assignment. The corrected full pipeline subgate passed unchanged with exit 0 in 229.476 seconds, after failing at the original boundary with exit 1 in 161.616 seconds. It is not the enclosing full deploy registry. Exact commands, hashes and logs are in result.json.

No prompt or approval-gated runtime hunk is changed; golden-reference review is not applicable. No additional review, deployment, campaign or provider query was initiated. The parent remains responsible for integration after healthy writers finish, its required review, the original full registry and final source-bound gate set. The case remains open pending that integration and validation. At 10,000 agents the change has no runtime, polling, network, locking or per-agent resource cost.

## Human feedback

The user directed the existing deploy to continue relentlessly and required the original clock, failures, selected tests and capacity limits to remain intact. The parent required private proposals while the original healthy workers ran; that coordination constraint was not a new human approval request. Assertions and budgets must not be weakened. Freedom and its protected instructions remain untouched.

## Reusable lesson

Reserve machine-readable stdout for protocol data and emit human cap warnings on stderr without weakening selection or inventory validation.
