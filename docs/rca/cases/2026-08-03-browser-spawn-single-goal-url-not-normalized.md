---
id: 2026-08-03-browser-spawn-single-goal-url-not-normalized
date: 2026-08-03
title: Browser spawns rejected an explicit checkout target duplicated only in the goal
surface: agents
component: agent-tool-schemas
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/tool_schemas.py SpawnAgentTool rejected an explicit first-line browser target when the duplicate start_url field was omitted
symptoms:
  - '"Value error, start_url is required when type=''browser''."'
  - '"Expected validated payment-card request but none was observed"'
  - '"No browser agent trajectory was recorded; expected at least 2 steps per browser agent"'
tags:
  - spawn-agent
  - browser-agent
  - pydantic
  - agentcard
  - tool-schema
sources:
  - PR #927
  - agent 5f485022-9d12-46e4-8831-73a957266af0
repro: agents/tests/blackbox/tool_schemas.blackbox.py
status: fixed
---

## Problem

The local `agent-payment-abandonment` task failed agent
`5f485022-9d12-46e4-8831-73a957266af0` after 123.1 seconds without a browser
trajectory or validated payment-card request. All three execute-loop attempts,
covering nine retained raw model responses, called `spawn_agent(type="browser")`
with the checkout target in an explicit navigation directive inside `goal` but
omitted the duplicate `start_url`. Every response failed Pydantic validation
with `start_url is required when type='browser'` before tool execution.

## Diagnosis

`SpawnAgentTool.check_spawn_agent_constraints` treated the derived browser target
and its self-contained goal as independent required sources of truth. The model
owned the target with an explicit first-line imperative, but validation rejected
the call solely because the same URL was not copied to a second field. The first
bad boundary was therefore tool-call normalization, before any browser provider
or payment code ran.

The deeper owned cause was a duplicated contract with no safe normalization
rule. A broad "one URL anywhere" rule is not safe: negated or contextual URLs do
not express target ownership, and trimming terminal punctuation can change a
valid URL or collapse distinct values. Archive searches for the exact validation
text and missing-trajectory symptom found no recurrence.
`2026-07-24-tool-arg-validation-error-caught-by-transport-failure-handler` is a
relative about surfacing model-authored validation failures, not duplicated
browser target fields.

## Solution

Pre-validation now derives `start_url` only from a leading imperative of the form
`Navigate to`, `Go to`, `Open`, or `Visit` followed by one HTTP(S) target. The
directive must end either at a newline or at the explicit sentence delimiter
`. ` before a subsequent instruction on the same or next line. The delimiter is
grammar, not generic URL trimming; directly newline-delimited URL punctuation is
copied byte-for-byte. Negated, contextual, URL-free, and ambiguous goals still
fail closed.

The explicit-target regression was run against detached pre-fix production code
and failed with the original Pydantic validation error. The identical artifact
passed against the fixed code. The final focused set is reproducible from
`agents/` with:

```bash
PYTHONPATH=tests/blackbox:. python - <<'PY'
import runpy
ns = runpy.run_path('tests/blackbox/tool_schemas.blackbox.py')
for name in (
    'test_spawn_agent_browser_infers_explicit_goal_target',
    'test_spawn_agent_browser_does_not_infer_ambiguous_goal_url',
    'test_spawn_agent_browser_does_not_infer_negated_goal_url',
    'test_spawn_agent_browser_preserves_owned_url_punctuation',
    'test_spawn_agent_browser_infers_period_delimited_goal_target',
    'test_spawn_agent_browser_infers_period_then_newline_goal_target',
    'test_spawn_agent_browser_does_not_collapse_distinct_urls',
):
    ns[name]()
PY
```

All focused checks and the complete tool-schema blackbox suite exit 0 after the
fix. Replaying the nine retained failed tool calls through `SpawnAgentTool`
recovered the exact benchmark URL in 9/9 cases, including the `. \n` shape that
initially exposed a delimiter bug. The exact four-task AgentCard rerun passed
4/4; `agent-payment-abandonment` successfully ran its browser trajectory and
passed in 285 seconds.

At 10,000 agents the validation stays request-local and linear in goal length.
It adds no shared state, network call, lock, subscription, or aggregation.

## Human feedback

None recorded.

## Reusable lesson

Infer duplicated browser targets only from explicit owned syntax, and preserve the captured URL byte-for-byte.
