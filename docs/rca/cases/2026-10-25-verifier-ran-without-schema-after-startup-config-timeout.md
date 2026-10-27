---
id: 2026-10-25-verifier-ran-without-schema-after-startup-config-timeout
date: 2026-10-25
title: Sub-agents verified without their response_schema after the startup agent-config read timed out, so cached verifier outputs were dropped
surface: agents
component: agent-workflow-output-schema
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py startup _fetch_agent_config — a timed-out fetch_agent_config returned {} and the workflow continued with output_schema=None; the verifier schema getter returned None, so check_progress parsed the cached verdict as ProgressScore (no output)
symptoms:
  - "Failed to fetch agent config for response_schema: Activity task timed out"
  - "Skipping response_schema generation for sub-agent"
  - "T7: 14 of 51 completion outputs do not satisfy their response_schema"
  - "Fetched output_schema attempt 1/5: True"
tags:
  - mass-agent
  - verifier
  - response-schema
  - structured-output
  - temporal-activity-timeout
  - cloud-only
sources:
  - agent f50d2c3a-ed1e-4181-9cfe-d75d1c5a6a39
  - fleet run 20261025-103949-1184128
  - commit ede5361f7
  - memory:mass-agent-stall-pins-worker-drain
repro: agents/tests/blackbox/workflow.blackbox.py::test_workflow_verifier_schema_survives_a_failed_startup_config_fetch
status: fixed
---

## Problem

On e4b3f9f02 (MA5 merged), the cloud copy of test-mass-agent-run-0 failed the new static
check t7-schema-complete-outputs: 14 of 51 completion outputs were invalid (Khe Hy, Wes
Roth, Joey Schweitzer with 2 fields; Allie K. Miller, Matt Wolfe and others with 7–11).
The local exact run on the same rows had 51/51 valid.

Khe Hy's guest verdict text is identical to the regenerated row's local reasoning, so the
guest read the current DEMO rows. The output was lost inside our workflow.

## Diagnosis

The 14 invalid GPs map one-to-one to a startup "Failed to fetch agent config for
response_schema: Activity task timed out" (14/14 invalid, 0/36 valid). The startup
`_fetch_agent_config` swallowed the failure and returned `{}`, so the workflow ran with
`output_schema=None` ("Skipping response_schema generation for sub-agent").

The verifier's schema getter returned None. The guest's verifier dumps show
`response_model=ProgressScore` for all 14, versus `ProgressScoreWithOutput` for all 36
valid GPs. The cached verdict's `output` was parsed away. Only `_mark_complete` re-fetched
the schema ("Fetched output_schema attempt 1/5: True"), so the completion fill then put
transcript strings into the 14-field schema.

Locally the fetch never times out. On the guest the single worker is load-starved (the P9
class), so the 3×30s activity attempts expire. Deeper rung: "schema unknown" (read failed)
was collapsed into "no schema", and only completion handled the unknown case.

## Solution

- A failed startup read sets `_agent_config_unavailable`.
- The verifier schema getter loads the schema once before verifying when it is unknown.
- One `_load_output_schema` helper serves that path and the existing completion poll
  (poll-until-present only at completion).
- An agent whose read succeeded with no schema pays no extra fetch.
- No timeout, retry budget or check was changed.
- Repro: the workflow regression is red on e4b3f9f02 and green 5/5 on ede5361f7. The local
  exact run is in the hand-off.
- 10k agents: one extra bounded read, only for agents whose startup read failed.
- Golden reference: `claude-code-src/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:143-151`
  always validates against the declared schema; it never runs without it.

## Human feedback

The parent relayed Andy's authorization for mass-agent changes. Constraints: no timeouts,
no nudges, no weakened checks; prove the cloud-only loss from guest evidence.

## Reusable lesson

Never let a failed read of a task's contract (response schema) degrade to "no contract"; keep it unknown and load it before any step that depends on it.
