---
id: 2026-09-05-raw-web-tool-envelopes-accepted-as-completion-summaries
date: 2026-09-05
title: Fast Mode accepted raw web-tool envelopes as Task Complete summaries
surface: agents
component: completion-summary
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py:_mark_complete completion-summary publication validation
symptoms:
  - Declared evaluator t7-schema-task-complete failed
  - completionSummary.summary starts with - **query** and contains **Result:**
  - completionSummary.summary starts with - **url** and contains You are filtering a fetched web page for an autonomous agent
  - completion_is_ablated=false for a raw prior-tool-evidence dump
tags:
  - fast-mode
  - completion-summary
  - web-search
  - web-fetch
  - task-complete
sources:
  - PR #1261
  - agent 2676348f-cf69-4bf8-bf79-c5954d7bb3e6
  - agent 2468418e-a748-42c8-8ebc-3ce64eab4e12
repro: agents/tests/blackbox/workflow.blackbox.py:test_workflow_mark_complete_never_persists_raw_tool_envelope_for_any_task
status: fixed
---

## Problem

The local `test-mass-agent-run-0` deploy smoke completed its root and all 50
first-level general-purpose children at zero live spend, but the T7 judge
failed. In agent `2676348f-cf69-4bf8-bf79-c5954d7bb3e6`, 32 of 50 child Task
Complete cards contained raw cached `web_search` or `web_fetch` envelopes rather
than a production-style completion summary. Child `5d90e2fb` began with
`- **query**: Figure robot White House F.03` and later contained `**Result:**`;
other children exposed the web-fetch filtering prompt verbatim.

The failing canonical local run was produced by `scripts/run-predeploy-local`,
whose shared-cache phase invoked the unchanged task through the local benchmark
stack. It exited 1 after 212.7 seconds with `Declared evaluator
t7-schema-task-complete failed`; its durable evidence link is
`https://www.roselabs.ai/?agent-id=2676348f-cf69-4bf8-bf79-c5954d7bb3e6` and its
run record is `agents/benchmarks/runs/20260905_011428_test-mass-agent-run-0.json`.

## Diagnosis

Archive searches for `Task Complete raw web_search web_fetch query Result prior
tool evidence` and `Fast Mode completion summary cached trajectory tool
envelope` found no exact recurrence. The related case
`2026-07-11-completion-gated-behind-final-summary-message-post` established that
completion narration is presentation data whose failure must not corrupt the
authoritative lifecycle transition; this incident adds the missing content
invariant at that same publication boundary. Archive validation passing only
proves document schema, not the diagnosis.

The malformed bytes originated before this run. For child `5d90e2fb`, the
completion-summary call was an exact Fast Cache replay: key and `hit_key` were
identical and `alias_hit=false`. The captured run has no matching cache-creation
event, so historical provenance is bounded to a cache entry created before the
run; it cannot be attributed more narrowly from this evidence. The replayed
summary then followed this path:

`Fast Cache completion_summary` -> `_mark_complete` ->
`is_ablated_completion_summary` accepts it -> `_post_message` persists a
FINISHED `completion_summary` -> backend message/tree state -> Benchmark Hub /
frontend Task Complete card -> T7 evaluator.

The cache is the source of the already-bad bytes. The first owned validation
boundary that failed was `_mark_complete`: its predicate recognized explicit
Fast Mode sentinels but not long raw tool envelopes. The transcript selector
also treated any long `web_search` / `web_fetch` body as a report. Thus raw
query/result text could be published even when the same child held a
substantive spawned-agent report.

The harness had the opposite contract split. The runtime prompt promised a
short completion narration, the runtime predicate only recognized cache
sentinels, the static T7 check only recognized configured forbidden strings,
and the GPT judge was free to inspect the raw body. Run
`20260904_215815_test-mass-agent-run-0.json` therefore false-passed even though
32 of its 50 first-level cards were raw query/URL envelopes; the later failing
run exposed the same 32-of-50 defect because its Claude Fable model judge
correctly distrusted the typed `completion_is_ablated=false`. The earlier
false-pass used `openai/gpt-5.6-sol`; the failing run used
`claude-fable-5-claude`. This conflicting producer/runtime/static/judge contract
is the `logical-inconsistency-in-harness-contracts`.

## Solution

`helpers/completion_summary_contract.py` is now the single import-safe contract
used by both the Temporal workflow and benchmark evaluator. It rejects cache
sentinels, markdown/plain/JSON parameter-result envelopes, and the observed
web-fetch filter prompt. `_mark_complete` applies it for every task immediately
before the final card is persisted, recovers only from substantive completion
or spawned-agent reports, and falls back to a goal restatement rather than
publishing raw tool I/O. The result-body fallback was removed.

The owning workflow regression feeds a >200-character cached search envelope
through `_mark_complete` for an ordinary (non-demo) task and asserts both the
FINISHED card and parent-persisted summary contain the report rather than
`**query**` / `**Result:**`. Static benchmark coverage exercises the observed
query, URL/filter, plain grep-like, and JSON shapes. The full workflow blackbox
runner discovers and passes the persistence regression.

## Controlled validation

A paired benchmark held the task, prompt, tools, fixtures, cache, timeout, pass
criteria, evaluator, and summary-classification helper constant. The evaluator
and helper had matching SHA-256 hashes in both worktrees
(`c1acfc7188b9b487536a0feedae3fcdbc783e2cf8c15fb9151bad071318ed6cf`
and `44e39b1eb5bbb5259faafaad10b1e41680999fd183a8aab761ad47306f3fe62d`,
respectively); only the production workflow boundary differed.

Both sides ran `scripts/run-bench --local test-mass-agent-run-0` with system
Postgres, two workflow workers, and the same Fast Mode cache database. The old
workflow (`b894d6a1`) exited 1 after 281 seconds at T7 because child `ef7435e6`
had a Fast Mode-ablated Task Complete summary. Its run record is
`.context/rca-controlled-bad/agents/benchmarks/runs/20260905_015344_test-mass-agent-run-0.json`
and its durable evidence link is
`https://www.roselabs.ai/?agent-id=6a0d50e5-d1c5-46c4-a169-81ed1a0958ee`.
The fixed workflow exited 0 after 288 seconds with 1/1 tasks passing, zero live
spend, and the same 167,333,028 cache-read tokens / 100% cache hit. Its run
record is
`agents/benchmarks/runs/20260905_020001_test-mass-agent-run-0.json` and its
durable evidence link is
`https://www.roselabs.ai/?agent-id=2180e1ac-d9c6-405c-a6c0-1061c52e2e1c`.

The unchanged owning test file was also copied byte-for-byte into the old-code
worktree (SHA-256
`89bde5e5b89f6ea914c5bc144248924d1f3b7cb09f3bbdd4e54ab9f674a8a7eb`).
The old-code command was:

```bash
cd .context/rca-controlled-bad
agents/venv/bin/python agents/tests/blackbox/workflow.blackbox.py
```

It exited 1 and printed the owning failure verbatim:

```text
File "agents/tests/blackbox/workflow.blackbox.py", line 5686,
  in test_workflow_mark_complete_never_persists_raw_tool_envelope_for_any_task
    assert "**query**" not in summary
AssertionError
❌ wf_mark_complete_rejects_raw_tool_envelope_globally
```

The fixed-code command was the same runner from the repository root:

```bash
agents/venv/bin/python agents/tests/blackbox/workflow.blackbox.py
```

It exited 0 and reported
`✅ wf_mark_complete_rejects_raw_tool_envelope_globally`. This separately proves
the persistence-boundary regression fails before the fix and passes after it.
The final full agents gate then ran:

```bash
cd agents
bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- \
  env AGENTS_COVERAGE_CONCURRENCY=4 bash scripts/run-coverage.sh
```

It exited 0 with 98/98 blackbox domains, 140/140 fast-cache and unit tests,
59/59 additional unit tests, and the required 80% aggregate coverage.

Incremental runtime cost is per-agent `O(local transcript messages and bytes)`:
completion polling, merge/coalescing, and recovery can make multiple local
passes, and message count is not globally bounded. There is no new shared
state, cross-agent fan-in, subscription, row, or lock, but 10,000 simultaneous
completions can still produce 10,000 concurrent local transcript reads.

## Human feedback

The user asked to eliminate cross-agent page leakage and deploy the result. This
same-agent Task Complete defect was discovered by that deploy's smoke gate; it
is a separate bug and is not evidence that one agent ID leaked into another
agent's page.

## Reusable lesson

Classify completion summaries by content shape, and never let a raw tool parameter/result envelope satisfy a production Task Complete card contract.
