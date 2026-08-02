---
id: 2026-07-03-benchmark-prompt-instructed-nested-explore-spawns
date: 2026-07-03
title: The user-data benchmark prompt told provider sub-agents to spawn another explore agent, so the run timed out on nested work
surface: harness
component: user-data-benchmark
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "user-data prod benchmark prompt — nested-agent phrasing instructed provider sub-agents to spawn another explore agent"
symptoms:
  - the user-data prod benchmark run times out
  - provider sub-agents spawn another explore agent instead of grepping directly
  - nested sub-agent work replaces the expected direct provider grep calls
tags:
  - benchmarks
  - prompt-ambiguity
  - sub-agent
  - spawn-agent
  - timeout
sources:
  - PR #692
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The user-data prod benchmark timed out. In the previous prod run the provider
sub-agents did not perform the provider greps the task grades; they spawned yet
another explore agent each, so the run spent its budget building a nested agent
tree instead of producing direct provider grep calls.

## Diagnosis

The benchmark prompt itself was ambiguous about nesting: it read as an
instruction for each provider sub-agent to spawn a further explore agent. The
defect is in the harness contract, not the agent — the task asked for one level
of provider agents doing grep work, but its wording sanctioned an extra level of
delegation, and each additional level multiplies wall-clock until the run hits
its timeout. There was also no evaluator asserting the intended shape (a
completed provider-agent spawn with provider-filter coverage), so nothing caught
the drift before the timeout did.

## Solution

Removed the nested-agent ambiguity from the user-data prod benchmark prompt while
keeping the grep-count requirement intact, so the task was clarified rather than
weakened. Added a custom contract asserting a completed provider-agent spawn plus
provider-filter coverage, and blackbox tests for both the provider-filter
evaluator and the non-nested prompt shape
(`agents/tests/blackbox/benchmark.blackbox.py`).

## Human feedback

None recorded.

## Reusable lesson

When a benchmark times out, read its prompt for accidental permission to nest
sub-agents before blaming latency — and clarify the wording without relaxing the
graded requirement.
