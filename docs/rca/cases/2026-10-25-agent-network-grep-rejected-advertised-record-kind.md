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
  - "grep sources=[messages] order=newest_first → Unsupported grep parameter: 'agent_trajectories source'."
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
  - commit 81c465b2c (order application, superseded on branch rca/GREP2)
  - agent 06ca141f-61e6-4a2e-b32b-f9baa9db3110 (prod recurrence 2026-11-04 query; 127 rows / 23 agents on non-agent sources)
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

For agent_network selections, `validateAgentNetworkSelectors` accepts
`record_kind` message/all (they select every stored-message row) and, on a
sole agent_network search, accepts and ignores `order` (an agent_trajectories
selector per the GrepTool schema; results stay newest first and
`display_order` reports that). It rejects llm_output/llm_context/code_event,
surface, until, page_after and a non-task trace_path with
`InvalidGrepParamError('<that parameter>')`, and `order` with another source
with `order/page_after`. Selections without agent sources keep the old
behavior. No prompt, schema or harness change. Golden reference: tools accept
a parameter that does not apply, ignore it, and say so in the schema —
`claude-code-src/src/tools/GrepTool/GrepTool.ts:59` ("Requires output_mode:
content, ignored otherwise"), hermes `file_tools.py:1301`, openclaw
`sessions-history-tool.ts:60`. 10k-agent behavior: pure request validation, no
new queries or state.

### Recurrence 2026-11-04 (other sources)

A read-only prod query found 127 grep results (23 agents, 2026-10-07 to
2026-11-03, 43 of them after this fix shipped) ending in `Unsupported grep
parameter: 'agent_trajectories source'.` Callers sent `order` (and `until`)
to messages, calendar, documents, drive and transactions, e.g.
`sources:["messages"], order:"newest_first", filters:{since:...}` and
`source:"calendar", order:"oldest_first", until:"2026-11-25"`. The earlier fix
held only for the agent_network branch of `validateAgentSourceSelection`; the
generic branch still threw for every selection without agent sources, still
named a source the caller never used, and treated top-level `until` as
trajectory-only although calendar, drive, documents and transactions accept
`until`. Reproduced by `back-end/src/tests/blackbox/data-grep-contract.cases.ts`
(data-grep domain) on 28a7bfc99. Fix on `fix/grep-param-contract`: the same
rule now covers every source — `order` is ignored wherever
agent_trajectories is not searched (display_order reports the real order),
`order`/`page_after` on a merged agent_trajectories search is rejected naming
that parameter, the remaining agent selectors are rejected by name with what
to add, and top-level `until`/`since`/`person` apply to every selected source
whose filters accept them (validate.normalize.ts; see
2026-11-04-grep-schema-documented-nested-filters-validator-accepted-only-flat).
The `[agent_network, messages] + order` case in
`data-agent-task-path.cases.ts` changed from 400 to 200 accordingly.

## Human feedback

Golden-reference review (parent /descend thread, 2026-10-26) rejected applying
`order` on agent_network in 81c465b2c as ungrounded, because the schema
documents `order` as agent_trajectories-only. Inapplicable parameters must be
ignored (or rejected) consistently with the schema text. The review also found
that the tests claimed page_after coverage they did not have; the page_after,
non-task trace_path and order-with-another-source rejections are now tested.

## Reusable lesson

When a tool schema advertises a selector, every source it can be combined with must either honor it, accept it when vacuously satisfied, or reject it by naming that parameter.
