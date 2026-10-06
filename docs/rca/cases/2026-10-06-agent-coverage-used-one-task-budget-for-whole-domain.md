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
