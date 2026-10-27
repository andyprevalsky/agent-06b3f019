---
id: 2026-10-23-explore-grep-result-char-cap-silently-drops-whole-matches
date: 2026-10-23
title: Explore grep results cut at 50k chars mid-match silently dropped the decisive match and its paging fields
surface: agents
component: spawn-agent-explore-tool-result-rendering
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/service.py _render_explore_tool_result rendered the whole grep result dict as JSON, then run_agent's hard_cap_tool_result_text cut it at 50,000 chars mid-match, dropping later matches and has_more/next_offset without saying which matches were lost or how to fetch them
symptoms:
  - "...[truncated, original_len=76652]"
  - "...[truncated, original_len="
  - explore agent answered success while the prior TOOL message says "tool_status: ❌ FAILED"
  - "Declared evaluator prior-code-tool-reported-status failed"
  - grep-agent-trajectories-code-tool-status fails when the explore grep uses context=3 or record_kind=all
tags:
  - explore
  - grep
  - tool-result
  - truncation
  - context-drift
  - grep-agent-trajectories-code-tool-status
sources:
  - agent f5f8e933-2373-4535-bf27-9298f64e5633
  - fleet run 20261023-024206-29561 (descend-full69-20261023, sharded run original600-1792722242636117810, r001-j0035)
  - hub run original600-1792722247819897873
  - task grep-agent-trajectories-code-tool-status
repro: agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_grep_result_over_cap_never_silently_drops_a_match
status: mitigated
---

## Problem

Benchmark `grep-agent-trajectories-code-tool-status` (prompt "Did my coding
agent's tool report success or failure when it ran the Collatz program?")
failed one of two copies in descend run `descend-full69-20261023`. Root
`f5f8e933-2373-4535-bf27-9298f64e5633` spawned an explore agent that called
`grep(pattern="(?i)collatz", case_insensitive=true, context=3,
record_kind="all", sources=[agent_trajectories, agent_network], head_limit=50)`.
The backend returned 22 matches; the formatted DB TOOL message is 69,480 chars
and has `tool_status: ❌ FAILED` at offset 55,976 (match 19,
`agent_trajectories/c4531f8e-.../TOOL/0b08f6f4-...`). The explore context
dump (`llm.context.dumped call_site=explore_agent dump_id=e59eedb15779`) shows
the TOOL content as JSON ending `...[truncated, original_len=76652]`: matches
after the cut, the FAILED status line, and the trailing `has_more` /
`next_offset` fields never reached the model. It answered "success" from an
embedded `result.success` record; the root verifier accepted it and the judge
`prior-code-tool-reported-status` failed it (correctly). The passing copy used
a narrower grep (14,652 chars, uncut).

## Diagnosis

Archive searches: "original_len truncated 50000 hard cap grep explore tool
result" and "explore agent answered success but tool reported FAILED match
lost truncated grep result" (+ `grep -rli original_len docs/rca/cases`). Both
hit `2026-09-28-explore-compaction-protected-tail-floor-above-trigger`, which
introduced the 50k activity-mode cap. This is a **relative** (a side effect of
that fix), not a recurrence: that case bounded context size; this one is what
the bound silently removes.

Critical path: explore LLM → `grep` → `GrepManager` → backend
`/api/data/grep` (correct: 22/22 matches) → `_render_explore_tool_result`
(`json.dumps` of the dict, 76,652 chars) → `run_agent` activity append
`hard_cap_tool_result_text` (head cut at 50,000) → explore LLM context.
Data is correct up to the render; it first goes wrong at the cut.

Step 5a ladder:

- Why 1: the model answered "success" — the FAILED match was not in its context.
- Why 2: the 50k head cut fell mid-match 15; matches 16–22 were dropped.
- Why 3: the cut is a character slice of structured multi-record output, so it
  (a) splits a record, (b) drops the result's own paging fields, and (c) its
  marker says only `original_len`, not which records were lost or how to
  fetch them. The grep tool already has whole-record paging (`offset`,
  `page_after`, `has_more`, `next_offset`); the explore render bypassed it.
  **Deepest owned cause.** Siblings: any explore grep over 50k (large
  `context`, `record_kind=all`/`llm_context`, big `head_limit`).
- Why 4 would be "char caps exist" — a deliberate design decision from the
  2026-09-28 case (keep the cap; stop there).

Local repro (owning boundary): the new blackbox drives
`spawn_explore_agent_activity` with a 22-match grep result whose JSON exceeds
the cap, applies the same `hard_cap_tool_result_text` that `run_agent` uses,
and asserts every match is either whole in the visible text or reachable via
the result's own continuation offset. On b84475d38 it fails:
`AssertionError: matches [16, 17, 18, 19, 20, 21, 22] were cut from the
50036-char explore result without a continuation offset`.

Outcome reproduction gap: `scripts/run-bench --local` was not run. The task
passes 9/10 historically (one red needs the model to choose a broad grep), and
the shared devbox had 3.1 GB free (98%) with six other RCA workers; the
parent's cloud rerun supplies outcome proof.

## Solution

`fit_grep_result_to_budget` (agents/domains/grep/service.py) holds back whole
trailing matches until the rendered result fits the same 50k budget
(binary search on the kept count; kept matches byte-identical), marks
`has_more`, sets the continuation (`next_offset`, or `next_page_after` = path
of the last shown match for keyset trajectory pages) and adds a
`size_notice`: "Showing matches 1-15; 7 more matches from this page were held
back whole ... repeat this grep with offset=15, or narrow pattern, context or
record_kind." `_render_explore_tool_result` applies it to grep before
`run_agent`'s cap, which remains as the backstop for a single oversized match.
The same unchanged blackbox passes after the fix.

Golden references: claude-code-src/src/tools/GrepTool/GrepTool.ts:110-127
(`applyHeadLimit` slices whole entries and reports `appliedLimit` so "the
model knows there may be more results and can paginate with offset") and
:268-276 (appends `[Showing results with pagination = limit, offset]`);
claude-code-src/src/utils/toolResultStorage.ts:189-199 (oversized results get
an explicit "Output too large" notice, never a silent cut);
hermes-agent/tools/file_tools.py:66-112 (trim to the last complete line and
return `next_offset` + a "Use offset=N to continue" hint). The fix converges
on all three: whole-record truncation plus an explicit continuation.

Not done: the root (poll_messages) path uses the formatted DB message and the
summarizer; it was not part of this failure. Raising the cap was rejected
(process-feedback rule 6).

10k-agent behavior: O(log n) extra `json.dumps` of one result inside the
explore activity, only when a grep result exceeds 50k; no new queries,
broadcasts, shared state or fan-in.

## Human feedback

None recorded.

## Reusable lesson

Never char-cut a multi-record tool result: hold back whole records and return
the tool's own continuation (offset/page cursor) with an explicit notice.
