---
id: 2026-11-05-selector-comment-fixture-coupled-to-live-import-graph
date: 2026-11-05
title: Comment-only selector assertions drifted when a genuine native maintenance import connected the graph
surface: harness
component: select-affected-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: check_extraction_precision applied a comment-only negative to the entire live repository despite a newly executable cross-package dependency
symptoms:
  - agents rose_browser_use blackbox selects no backend blackbox domain (rose/models reached it only via comments)
  - agents rose_browser_use blackbox reaches backend-unit only through the code literal agents/tests
  - select-affected-tests 2 failures on round24 source0e1af5589
tags:
  - affected-tests
  - dependency-graph
  - fixture-isolation
  - conservative-selection
sources:
  - commit 23356ac8dfab33aee30e8eac99d435bf46187aae
  - commit 0822666ea454874579255b61096b5c85c20b0e35
  - commit 0e1af5589c4e177d50900efe785278f4cb247e8d
repro: python3 scripts/tests/select-affected-tests.test.py
status: open
---

## Problem

The actual round24 structural execution on0e1af5589 failed exactly two selector checks after19.1seconds. Other selector checks passed; the parent later collected terminal full-gateFAIL with100/101 outer executions passing. The two assertions expected a changed agents rose-browser-use test to select no backend blackbox domain and at most the worker-process-deployment unit. All original failed receipts and the new pending occurrence remain retained. This repair does not rerun or credit the whole structural gate or deployment.

## Diagnosis

Gate: INTRODUCED — compared with prior23356ac8d, integration0822666 added native maintenance source and its real run-bench-cloud entrypoint. The selector and selector-test blobs are byte-identical between23356 and failing0e; source-tree reachability changed. The original owning test fails with the two exact messages on0e. The identical original test and selector replayed over the complete prior23356 source snapshot pass and select no backend blackbox plus only worker-process-deployment. This is a stale fixture premise exposed by our integration, not a comment-stripper regression or permission to omit real conservative dependencies.

Archive searches before hypothesis used `select affected tests rose_browser_use blackbox dependency comments` and `import graph literal agents/tests rose models cross package false edge`, followed by exact selector/comment searches. The related2026-10-28-selector-comment-lexing case concerns a real tokenizer defect. Its Solution and Human feedback require conservative executable references and retained failure evidence. The present first-bad boundary differs: lexing is correct, but a whole-repository negative assumes that no future executable path can exist.

A reverse/data-edge trace on the frozen failing tree shows the concrete path:

`agents/tests/blackbox/rose_browser_use.blackbox.py -> dir:agents/tests reader scripts/select_affected_tests.py -> scripts/run_deploy_stage.py -> scripts/run-deploy-stage -> scripts/deploy_test_local_cleanup.py -> scripts/deploy_test_cycle.py -> scripts/cloudbench_maintenance.py -> scripts/run-bench-cloud -> scripts/lib/cloudbench-env.sh -> back-end/scripts/run-blackbox-tests.sh -> back-end/src/tests/blackbox/assertLocalDatabase.ts -> backend blackbox callers`.

The selector reads the tests tree as data; importers and executed script paths propagate that dependency conservatively. Native maintenance really imports the coordinator for source/admission and uses the existing preallocation writer. The warm runner really executes maintenance. The production graph therefore selects40 backend blackbox domains and18 backend unit files. Removing only the maintenance-to-cycle edge in a private diagnostic graph is insufficient because another real maintenance import path remains. Removing the single newly added warm-runner-to-maintenance entrypoint in that same frozen private graph restores the prior empty-backend/one-unit selection. This counterfactual is causal evidence only: deleting that executable edge from production would under-select and is not a repair.

## Solution

Keep the production selector, runtime imports, dynamic dependency declarations and conservative coverage unchanged. Isolate the historical comment-only source example in a four-file in-memory graph, while reusing the actual discovered lane/root mapping, selector configuration and real selection implementation. Preserve every original assertion/negative control and timeout. The live own-domain check and all whole-repository mapping/explicit-edge checks remain. Only the two comment-only negatives receive controlled source input matching their stated premise.

Strengthen the same owning suite with three controls: the literal agents/tests data reader must actually be selected, an executable cross-package path must select the backend rose domain, and a raw-source/no-comment-stripping mutant must make the comment-only selection detect backend reachability. These demonstrate that the corrected fixture is neither an empty graph nor a mechanism for dropping genuine imports. A shallow selector copy replaces only its graph/reverse indexes and never mutates the live graph.

This simplifies the fixture rather than growing an exception list of backend domains whenever a legitimate importer is added. The production selector module and all runtime/benchmark files are byte-identical to failing0e. No tasks, coverage rules, load sizes, assertions, negative controls or timeouts are relaxed. Golden reference: not applicable (no approval-gated hunk). This changes test input isolation only, not LLM text, schema, runtime recovery or production behavior. At10k agents there is no runtime work or new service/query/lock; the extra controlled graph contains four files only.

The exact owning command is registered as select-affected-tests in scripts/run-deploy-structural-gates.py and deploy Step4s, so it runs in the parent's selected full structural gate. The local same-command red/green and unchanged-code five-run results, graph traces, prior-tree replay and byte/hash comparisons are retained in the repair report. Status remains open for independent review and combined-source/full structural validation by the parent.

## Human feedback

The user required reading RCA/process feedback and two archive searches first, an existing clean/quiescent ordinary clone branched from exact0e, preservation of branches/evidence/shared history/dependencies, no canonical or active-worker edits, no competing deploy, no new thread and no provider/financial/DB/Kernel/Freedom actions. The user explicitly required evidence to decide runtime versus fixture responsibility, preservation of genuine conservative dependencies, original assertions/negative controls/timeouts, exact original-command proof and independent review before integration. The parent reported original round24 terminalFAIL with100/101 outer executions passing and pending occurrence dbe9fda283bf4bb0acd48771d0fc0a2a. A later parent merge0563ccfba contains factory history only with runtime/test blobs identical to0e; this isolated branch deliberately does not resync or rewrite that history.

## Reusable lesson

Freeze the source inputs of a negative dependency-extraction test instead of treating future executable repository imports as comment-parser regressions.
