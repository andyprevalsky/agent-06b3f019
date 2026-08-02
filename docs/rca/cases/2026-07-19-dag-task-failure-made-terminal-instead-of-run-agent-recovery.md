---
id: 2026-07-19-dag-task-failure-made-terminal-instead-of-run-agent-recovery
date: 2026-07-19
title: A single failed planned task became a terminal agent FAILED instead of falling through to run_agent, and the inverted blackbox test let it ship green
surface: agents
component: agent-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit 500715a5f — execute_dag returned a terminal status so agent_workflow routed a failed planned task to _handle_incomplete instead of run_agent
symptoms:
  - "Agent failed: Planned task N failed during DAG execution."
  - agent ends FAILED on a single failed planned task with no LLM recovery attempt
  - blackbox suite green while the recovery invariant is gone
tags:
  - dag
  - temporal
  - workflow
  - recovery
  - terminal-status
  - inverted-test
sources:
  - PR #806
  - memory:project_dag_failure_terminal_regression
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

Agents died with `Agent failed: Planned task N failed during DAG execution.` A
single failed planned task inside the DAG terminated the whole agent rather than
handing control back to the LLM loop for recovery, so recoverable partial
failures became total failures.

## Diagnosis

Commit `500715a5f` converted a failed/stalled DAG into a terminal FAILED status,
and `agent_workflow` therefore routed to `_handle_incomplete` instead of falling
through to `run_agent`. Its stated rationale — that `run_agent` would replay
sibling spawns — is false: `execute_dag` runs once and is never re-entered, and
`run_agent` reads the recorded context from the DB and iterates exactly as it
already did on the completed-but-unverified DAG path. The reason this reached
production is the deeper defect: the blackbox test that had cemented the recovery
invariant was _rewritten to assert the regressed behavior_, so the suite was
green while the product decision silently flipped. A passing suite cannot
validate a control-flow semantics change when the author can update the
assertion in the same commit.

## Solution

`execute_dag` now returns `needs_llm` (recoverable) on a failed or stalled DAG and
`agent_workflow` falls through to `run_agent`; the cementing test was inverted
back to `test_workflow_dag_failure_recovers_via_run_agent`, and the
`dag_executor` and `payload_guard` consumers of the old status literal were
updated. Prevention is the generalizable half: a new Step 0b agent-behavior
approval gate (`scripts/check-agent-behavior-approval.sh`) scans the agent
control-flow layer and its behavior tests and requires human approval for
recovery/terminal-semantics hunks — including inverted recovery-invariant
assertions, which the LLM-text-only prompt gate (Step 0p) cannot see. It is wired
into `/deploy` Step 0b and `scripts/test.sh` and pinned by
`scripts/tests/check-agent-behavior-approval.test.sh`.

## Human feedback

The new Step 0b agent-behavior gate fired on this very PR: the recovery-semantics
change required, and received, explicit human approval before it could ship —
recorded in the source as proof the gate catches this regression class. No other
correction recorded.

## Reusable lesson

Treat a rewritten or inverted invariant assertion as the primary evidence of a
regression — when a behavior change ships green, check whether its own test was
changed to agree with it.
