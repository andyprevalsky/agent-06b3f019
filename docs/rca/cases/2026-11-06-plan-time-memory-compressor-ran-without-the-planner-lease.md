---
id: 2026-11-06-plan-time-memory-compressor-ran-without-the-planner-lease
date: 2026-11-06
title: The plan-time planner-memory compressor ran without the planner activity's leased compute token, timed out on exhausted API-key legs and dropped the memory
surface: agents
component: planner-memory-retrieval
classification: our-bug
problem_class: other
first_bad_boundary: agents/helpers/llm.py _retrieve_planner_memories — retrieve_memories → compress_transcript → call_llm received none of the planner activity's claude/gpt lease kwargs
symptoms:
  - "planner_memory.compress_timeout"
  - "\"call_site\": \"memory_compressor\", \"pool\": \"rose-1-ultra\", \"claude_auth_present\": false, \"gpt_auth_present\": false"
  - "rose.complete.openai_apikey.fall_through"
  - "injected_chars=0"
tags:
  - planner-memory
  - compute-token
  - claude-auth
  - memory-compressor
sources:
  - agent fdd82785-6e2c-49d4-a411-1a63a960b35d
  - task planner-memory-blue-bottle-on
  - benchmark run campaign-20261106-095011-2029870 job r001-j0016
repro: agents/tests/blackbox/planner_memory.blackbox.py::test_plan_time_compressor_uses_the_planner_activity_lease
status: fixed
---

## Problem

Task `planner-memory-blue-bottle-on` (cloud job r001-j0016, agent
fdd82785) retrieved one candidate memory whose `criticalPath` had to be
recompressed at plan time. The guest worker log shows, inside the same
`call_planner_llm_activity`:

- the planner call: `"call_site": "planner"`, `"claude_auth_present": true`,
  `"direct_auth_type": "claude"` (leased user Claude token, fetched 10:17:06Z);
- the compressor call: `"call_site": "memory_compressor"`,
  `"claude_auth_present": false, "gpt_auth_present": false`, then
  `rose.transport.openai` → `insufficient_quota` / `credit_balance_exhausted`,
  `rose.complete.openai_apikey.fall_through`, Anthropic API-key 400 and
  `rose.complete.anthropic_apikey.fall_through`;
- `planner_memory.compress_timeout` at the 15 s batch budget, then
  `planner_memory.retrieved candidates=1 compressed=0 skipped_uncompressed=1`
  and `Planner memory retrieval: ... injected_chars=0`.

The memory was dropped and the planner planned like the memory-off arm.

## Diagnosis

`call_planner_llm_activity` receives the workflow's leased compute token
(`claude_max_token`, `gpt_token` and their source/pool/user/lineage fields)
and forwards it to the planner's `call_llm_structured_streaming`. Its memory
hook `_retrieve_planner_memories` called `retrieve_memories(goal, user_id=…,
agent_id=…)` with no credentials, `_ensure_critical_path` called
`compress_transcript(transcript, agent_id=…, user_id=…)`, and
`compress_transcript` called `call_llm(...)` with no `claude_token` /
`gpt_token`. With no direct auth, Rose completions tries only the API-key and
waterfall legs. When those keys are out of credits (as on 2026-11-06), the
compressor cannot succeed inside its 15 s budget, so every stale or
uncompressed memory row is silently skipped — in production as well as on
benchmark guests. The H-03 stale fixture
(`2026-11-06-planner-memory-fixture-stale-compressor-version`) is what forced a
plan-time compression in this run; this case is the independent defect that
made that compression fail.

Local repro: `test_plan_time_compressor_uses_the_planner_activity_lease`
runs the real planner activity with an uncompressed hit and a real
`compress_transcript`, and asserts the compressor's `call_llm` receives the
activity's lease. On the pre-fix code it fails with
`claude: compressor claude_token=None, planner lease 'claude-lease-token'`.

## Solution

The planner activity lends its own lease to plan-time compression: it passes
an `llm_auth` mapping to `_retrieve_planner_memories` → `retrieve_memories` →
`_ensure_critical_path` → `compress_transcript`, which forwards only the
allow-listed `COMPRESSOR_AUTH_KWARGS` (claude/gpt token, source, pool, user,
lineage) to `call_llm`. No second lease is taken; the compression runs
before the planner call on the same token, exactly as the planner would. Other
callers (backfill, fixture builder, compressor bench) keep their current
behaviour because `llm_auth` defaults to `None`. Demo-cache keys strip
`claude_token`/`gpt_token` as secret fields, so replay keys are unchanged.

10k-agent behaviour: no new lease, connection, query or shared state per
agent; at most `max_compressions` extra completions per planner call already
existed and now use the agent's own token instead of the shared API-key pool.

## Human feedback

None recorded.

## Reusable lesson

When an activity holds a leased compute token, every LLM call it makes —
including helpers it fans out to — must receive that lease; grep the guest log
for `claude_auth_present: false` on a call site inside an activity whose main
call had auth.
