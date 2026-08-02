---
id: 2026-03-26-anthropic-union-type-schema-limit
date: 2026-03-26
title: Execute-phase tool schema exceeded Anthropic's 16 union-typed parameter limit, silently demoting claudeAuth to the waterfall
surface: agents
component: tool-schemas
classification: our-bug
problem_class: other
first_bad_boundary: execute-phase `output_config` JSON schema — 18 union-typed parameters (Optional fields across tools) vs. Anthropic's limit of 16
symptoms:
  - execute phase returns `google/gemini-3-flash-preview` instead of `claude-sonnet-4-6-claude`
  - Anthropic API returns 400 for the execute-phase schema, 200 for the plan-phase schema
  - claude auth works in PLAN phase but silently fails in EXECUTE phase
tags:
  - anthropic
  - claude-auth
  - json-schema
  - structured-output
  - tool-schemas
sources:
  - PR #264
repro: none-recorded
status: fixed
---

## Problem

Agents authenticated with the user's Claude OAuth token (claudeAuth) ran the PLAN
phase on Anthropic (`claude-sonnet-4-6-claude`) but every EXECUTE-phase call came
back from `google/gemini-3-flash-preview` — i.e. the direct-Anthropic path had
failed and the request had fallen through to the paid provider waterfall. Posting
the execute-phase schema to the Anthropic API directly reproduced it: HTTP 400 on
execute, HTTP 200 on plan.

## Diagnosis

The only structural difference between the two phases was the `output_config`
JSON schema. The Anthropic API rejects schemas with more than 16 union-typed
parameters. The plan phase had exactly 16 and worked; the execute phase had 18,
accumulated from `Optional` fields spread across the execute-phase tools. The
count is an emergent property of the union of all tool schemas in a phase, so no
single tool looked wrong — the limit was crossed by aggregate growth as tools
were added. Nothing in the pipeline surfaced the 400: the failure appeared only
as a different `actual_model` in the response.

## Solution

Made `WaitForTool.check_interval_seconds` and `max_checks` non-`Optional` (they
already had defaults), dropping the union count from 18 to 16. The union count
was then verified at 16 after merging main, which had added the `add_memory`
tool — establishing the count as something to check whenever a tool or an
`Optional` field is added to a phase. Post-fix, all execute-phase claudeAuth
tests returned `claude-sonnet-4-6-claude`.

## Human feedback

None recorded.

## Reusable lesson

When claudeAuth silently degrades to the waterfall in one phase only, diff the
phases' aggregate tool schemas and count union-typed parameters against
Anthropic's 16-parameter ceiling before suspecting the token.
