---
id: 2026-10-24-handoff-schema-dropped-declared-field-descriptions
date: 2026-10-24
title: Code-agent handoff schema dropped every declared field description, so a real CLI filled a field with the wrong value
surface: agents
component: spawn_claude_code_agent handoff contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py handoff_json_schema — built properties with helpers.llm._json_schema_for_response_field, which emits types and bounds only, so the code agent never saw what each declared field means
symptoms:
  - "ASSERTION FAILED: handoff sentinel mismatch: {\"sentinel\": \"CLAUDE_E2B_DONE\", \"file\": {\"path\": \"/home/user/output/claude-smoke.txt\"}}"
  - handoff JSON is schema-valid but a field holds the wrong content
  - Result JSON Schema for /home/user/.rose/handoff.json has no "description" keys
tags:
  - code-agent
  - handoff
  - output-schema
sources:
  - commit 75743b45a (fix and red/green tests, branch rca/R3c-handoff-e2e)
  - commit 7a9994366 (R3b handoff contract merge)
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_handoff_json_schema_carries_declared_field_descriptions
status: fixed
---

## Problem

The R3c end-to-end check ran the real Claude Code CLI in E2B (BLACKBOX_SMOKE=1) with
the worker's "Result JSON Schema for /home/user/.rose/handoff.json" block. The CLI
wrote a handoff and /close returned it schema-valid, but the CLI put its reply token
CLAUDE_E2B_DONE in `sentinel`, not the file content CLAUDE_E2B_OK.

## Diagnosis

`handoff_json_schema` mapped each declared field through
`_json_schema_for_response_field`. That function was written for verifier structured
output and emits only types and bounds. Every `description` the parent declared was
dropped. For 31f51d25 that included "Complete verbatim stdout of running the
program". The code agent therefore saw field names and types only, so any
ambiguous field name was a guess. The smoke schema was undescribed and
reproduced the class directly.

## Solution

`_with_field_descriptions` copies each declared description into its property schema.
It recurses into declared object and list[object] subfields. The red test failed
with `KeyError: 'description'` and passes after the fix (5/5). The smoke schema now
carries the description a real output field would have. With that description, the
same real CLI wrote the correct sentinel: claude-code smoke PASS. The change adds a few
bytes per field to the task text and has no effect at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

When reusing a schema builder for a new consumer, check what it omits; a model-facing contract needs the field descriptions, not just the types.
