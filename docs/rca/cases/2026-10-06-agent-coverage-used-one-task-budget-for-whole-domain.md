---
id: 2026-10-06-agent-coverage-used-one-task-budget-for-whole-domain
date: 2026-10-06
title: Whole agents coverage domain used one task sized verification budget
surface: harness
component: agents-coverage-domain-runner
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: run_coverage_blackbox_parallel assigned a 300 second aggregate budget to the complete benchmark control domain under concurrent coverage
symptoms:
  - agents benchmark coverage domain timed out after partial completion
  - whole domain timeout occurred while individual controls were still completing
tags:
  - agents
  - coverage
  - domain-budget
sources:
  - commit 5233c125258139b2c71a7d35a8a39d7f30d02984
  - PR #1424 deploy
  - agent /root/fresh_basic_claude_final50_cli
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/agents-coverage-budget-followup.safe.json
repro: agents/scripts/run_coverage_blackbox_parallel.py
status: open
---

## Problem

The roughly 21.5k-line benchmark control domain shares its coverage host with
four workers and many independent native checks. Its outer domain process
was timed out at 300 seconds after 75 control names completed. This aggregate
verification deadline was not an individual benchmark execution deadline.

## Diagnosis

The first bad boundary is assigning a single short domain budget to the whole
control collection under concurrent instrumentation. The unchanged domain
completed 476 checks in 190.298 seconds on the scoped retry; the full coverage run
completed 109 domains with 82 percent coverage. The existing coverage process-
cleanup case is related machinery with a different cause: this finding concerns
aggregate verification admission, not failure to retire descendants. Root
reviewed the measured result before authorizing the infrastructure budget.

## Solution

Set the whole-domain default to 1800 seconds and retain the existing positive
AGENTS_COVERAGE_DOMAIN_TIMEOUT override. Timeout and cancellation still fail
the domain and retire its exact process group. Existing runner controls pass
independently in 6.316 seconds. No task/model/prompt/evaluator, task execution
limit, flush limit or allocation-to-release deadline changes. No tests or
coverage thresholds are removed. The normal agents coverage command discovers
the existing runner family; source and docs/testing.md are the only changes.
Root integration and final mandatory gates remain pending, so this case stays
open. This is an authorized aggregate verification budget correction, not
native campaign speed or acceptance evidence.

## Human feedback

None recorded for this specific domain finding. Root required preservation of
all task budgets, existing cleanup controls and measured coverage evidence.

## Reusable lesson

Size an aggregate verification-domain deadline for its complete measured control collection while preserving each task's own limits.


### October 6 follow-up: native command families retained shorter inner guards

The normal covered benchmark domain on committed `7872fa3d` completed in about
400 seconds but recorded two native verification-family failures at their
60-second wrappers: `private_fleet_source_permanent_gate` and
`boot_terminal_runtime_evidence_permanent_gate`. The other 108 domains passed.
Their original temporary pytest streams were not retained by the wrapper error
path, so a particular slow assertion or a production cause is not established.
No timeout is reclassified as a passing original attempt.

The exact unchanged private-source command subsequently passed all 70 cases in
16.534 seconds. The same two boot-evidence groups, using the existing exact-owned
helper with a diagnostic-only 600-second aggregate guard and retained output,
passed all 166 cases in 44.545 seconds. These are scoped native verification
measurements, not evidence of live benchmark performance or a proved contention
mechanism. The prior cleanup contract and every test assertion remained intact.

A class-wide audit found 17 whole native command-family guards between 15 and
120 seconds, including the parallel owned-command helper default. They now
share the existing AGENTS_COVERAGE_DOMAIN_TIMEOUT value, with the same 1800-second
standalone default. Synthetic fault, transport, native snapshot and exact-owner
retirement bounds remain identical; all 2,246 assertion AST nodes are unchanged.
This removes inner aggregate verification deadlines rather than relaxing an
individual fault assertion or a task deadline. The original 60-second failures
and private native reductions remain durably separate. The final affected
covered benchmark domain must qualify once on the composed source, combined
with the retained 108 unchanged domain receipts through the supported runner.
No model, task, evaluator, prompt, task execution bound or allocation-to-release
limit changes. The user explicitly requested liberal infrastructure observation
budgets and meaningful stage handoffs, rather than repeated sub-suite timer
adjustments.
