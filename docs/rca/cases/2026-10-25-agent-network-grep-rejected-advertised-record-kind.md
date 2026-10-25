---
id: 2026-10-25-agent-network-grep-rejected-advertised-record-kind
date: 2026-10-25
title: grep rejected trajectory selectors (record_kind, order) on agent_network with an opaque 400, so an explore could not read a sibling's trajectory
surface: back-end
component: data-grep-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/data/validate.ts validateAgentSourceSelection — any record_kind/order/surface/until/page_after without agent_trajectories threw InvalidGrepParamError('agent_trajectories source'), although GrepTool advertises them and every agent_network row is a stored message
symptoms:
  - "Unsupported grep parameter: 'agent_trajectories source'."
  - "grep source=agent_network record_kind=all trace_path=/root/member_number → 400 INVALID_GREP_PARAM"
  - "grep sources=[agent_network] order=oldest_first → Unsupported grep parameter: 'agent_trajectories source'."
  - "explore spawn_agent ERROR Reached max iterations (5)"
  - "browser-auth-assistance-declined assistance-declined-runtime: Observed tool failure: attempt_completion_with_result status=ERROR"
tags:
  - grep
  - agent-network
  - record-kind
  - explore
  - a2a
  - descend-full69-20261023
sources:
  - agent a9cdd906-f8b8-4aba-9b6e-dfd43f18ef0d (descend full rerun on 4bb71d90f, shard-01, job r002-j0061)
  - agent 3327c447-2cf2-46e8-80de-94eb897daab8 (explore /root/auth_obstacle)
  - commit d2cfa2c90 (branch rca/GREP-explore-agent-network)
repro: back-end/src/tests/blackbox/data-agent-task-path.cases.ts proveAgentNetworkRecordKind (data blackbox domain)
status: fixed
---

## Problem

In browser-auth-assistance-declined, after the browser agent reported that the
user declined to sign in, the root spawned explore `/root/auth_obstacle` to read
`/root/member_number`'s trajectory. `list_agents` told it to read an agent's
messages with `grep(sources=["agent_network"], trace_path="<address>")`. The
explore called `grep(source=agent_network, record_kind=all,
trace_path=/root/member_number)` and got
`Unsupported grep parameter: 'agent_trajectories source'.` With no successful
evidence tool, `attempt_completion_with_result` was rejected by the explore
evidence guard, a web_search used the last iteration, and the spawn ended
`Reached max iterations (5)`. The evaluator saw the ERROR tool and failed the
run. Evidence: run.json root messages 66–85
(`/var/tmp/f4x/context/fleet/runs/20261025-230302-25960/browser-auth-assistance-declined/run.json`).

## Diagnosis

Critical path: explore LLM → grep tool → POST /api/data/grep →
`resolveSourceSelection` → `validateAgentSourceSelection`. The GrepTool schema
(`agents/utils/tool_schemas.py`) exposes `record_kind` (message/llm_output/
llm_context/all) and describes `record_kind=all`; the backend accepted
`trace_path` and `role` for agent_network but treated any `record_kind` as
trajectories-only and rejected it with an error that names a source, not the
offending parameter. agent_network searches only `Message` rows
(`agentNetworkGrepRepo.ts`), so `message` and `all` are exactly satisfied by
it; only model-record kinds are genuinely unavailable there. The same task
passed in earlier runs because the model happened not to pass `record_kind`.
The first local post-fix pass (agent 3467c479-b951-47a3-801f-3238ff21dd7f)
showed the same class through `order=oldest_first` on agent_network; that run
recovered through agent_trajectories, but the fix was widened to the class.
Relative of 2026-08-04-grep-emits-pointers-no-tool-can-dereference (same
contract-inconsistency class, different boundary).

Repro (record_kind red on 4bb71d90f; order red on d2cfa2c90): `cd back-end && ROSE_USE_SYSTEM_PG=true bash scripts/run-blackbox-tests.sh data`
failed pre-fix with
`agent_network record_kind=all reads the stored messages, got 400 {"error":"INVALID_GREP_PARAM","message":"Unsupported grep parameter: 'agent_trajectories source'."}`.

## Solution

For agent_network-only selections, `validateAgentNetworkSelectors` accepts
`record_kind` message/all (they select every stored-message row) and `order`
(the repo and display order now honor oldest_first/newest_first), and rejects
llm_output/llm_context/code_event, surface, until, page_after and a non-task
trace_path with `InvalidGrepParamError('<that parameter>')`. Selections
without agent sources keep the old behavior. No
prompt, schema or harness change. Golden reference: Claude Code's Grep accepts
selectors that do not apply in the chosen mode and ignores them rather than
failing the call (`claude-code-src/src/tools/GrepTool/GrepTool.ts:59`,
"Requires output_mode: content, ignored otherwise"); the fix converges on that
for vacuously-satisfied selectors while still rejecting unsatisfiable ones by
name. 10k-agent behavior: pure request validation, no new queries or state.

## Human feedback

None recorded.

## Reusable lesson

When a tool schema advertises a selector, every source it can be combined with must either honor it, accept it when vacuously satisfied, or reject it by naming that parameter.
