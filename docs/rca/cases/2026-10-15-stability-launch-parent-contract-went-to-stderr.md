---
id: 2026-10-15-stability-launch-parent-contract-went-to-stderr
date: 2026-10-15
title: Stability launch sent the parent instructions to a different output stream
surface: infra
component: benchmark-cli
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench stability-proof branch redirected benchmark_agent_instructions to stderr while the registered launch contract consumes stdout
symptoms:
  - "launch must emit one complete contract"
  - stability-proof launch omitted the parent scorecard instructions from stdout
tags:
  - cloudbench
  - scorecard
  - cli
  - stdout
sources:
  - commit 337113459
  - agent 01a13294-abf3-7b02-952d-028f9a03119c
repro: bash scripts/tests/approval-format.test.sh
status: fixed
---

## Problem

After the standing scorecard memory was integrated, the existing scripts-only
CLI test failed for `stability-proof -k 2`. Other launch routes printed the
canonical parent instructions before their runner; this branch sent the same
instructions to stderr, leaving its stdout contract absent.
The before/after receipt and exact diff are retained in the author checkout's
`.context/i42-cli-report-contract/` directory.

## Diagnosis

Critical path: dispatch `stability-proof` -> classify launch versus read-only
operation -> print the shared instructions -> execute the proof runner.
The actual registered fixture failed with `launch must emit one complete
contract`. The first bad operation was the branch's stderr redirection.

Archive searches used the literal assertion and `stability proof parent
instructions stderr report format`. No identical case was found. The optional
artifact-sink case from September 10 is related output-path context, not this
cause; its solution and feedback were reviewed.

## Solution

Remove only the stderr redirection in the actual-launch branch. Preserve the
existing read-only option scanner, task selection, proof bounds and all runtime
behavior. The identical registered `approval-format.test.sh` then passed,
including every CLI launch route. No test assertion was weakened.

This is a CLI instruction-delivery repair, not proof of the pending 600-task
benchmark outcome. At 10,000 agents it adds no new work, shared state or fan-in:
the same constant instruction document uses the canonical output stream once
per launch.

## Human feedback

Every display correction must be saved concisely in memory so future agents
inherit it. A passing check on another checkout does not qualify the integrated
checkout; fix its actual failed contract.

## Reusable lesson

Use the same instruction stream on every launch route, while preserving pure
output for read-only commands.
