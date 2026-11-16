---
id: 2026-11-15-compaction-summaries-admitted-as-feedback-triple-carried-in-continuation-runtime-state
date: 2026-11-15
title: Context-compaction summaries were admitted as user feedback and every id-less feedback text rode three times in continuation runtime_state, so a 536 KB runtime_state helped push agent 8789a5df's handoff past Temporal's 2 MiB limit (TMPRL1103)
surface: agents
component: agent-workflow-continuation-state
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py _real_user_requirement_keys counted the compactor's USER-role summary row (metadata.compactionSummary) as a real user requirement, so _admit_durable_response_schema_feedback queued each ~40 KB summary as feedback, and agents/workflows/agent_workflow.py _continuation_resume_state then serialized that row's full text in response_schema_feedback, response_schema_feedback_sources and response_schema_feedback_rows (id-less keys embed the text)
symptoms:
  - "[TMPRL1103] Attempted to upload payloads with size that exceeded the error limit."
  - "Continuation payload is 2124477 bytes (Temporal rejects ~2 MiB); context messages=602"
  - "response_schema_feedback_sources"
  - "response_schema_feedback_rows"
  - "[CONTEXT SUMMARY]"
tags:
  - temporal
  - continue-as-new
  - payload-limit
  - cooperative-cutover
  - response-schema-feedback
  - context-compaction
  - background-agents
sources:
  - agent 8789a5df-0119-4bbf-b90c-c7e58de56fe4
  - PR #2239
repro: agents/tests/blackbox/workflow.blackbox.py test_workflow_continuation_runtime_state_carries_feedback_and_background_once (domain workflow)
status: fixed
---

## Problem

Agent 8789a5df's generation-handoff `continue_as_new` failed every workflow-task
retry with TMPRL1103. That wedged Fly cutover job a145f654 in DRAINING for about
12 h. The context half (arg 6, 1,583,193 bytes) is case
2026-11-15-continuation-context-over-2mib-below-token-trigger-wedges-cutover-drain
(PR #2239). This case covers arg 16. The start input of run 794ef8d4 (07:29Z,
read-only Temporal history fetch, 17 args, 2,095,385 payload bytes) carried a
`resume_state.runtime_state` of 536,819 bytes:

| field | bytes | items |
|---|---|---|
| response_schema_feedback | 152,493 | 47 |
| response_schema_feedback_rows | 131,835 | 47 |
| response_schema_feedback_sources | 130,155 | 47 |
| background_agents | 100,004 | 31 finished records |
| user_context_section | 12,069 | |

## Diagnosis

1. 3 of the 47 feedback entries had a `("legacy", timestamp, text)` source and row.
   Their text starts with "[CONTEXT SUMMARY]:" and they are 36,949, 41,441 and
   45,828 characters long, which is ~124 KB of the 152 KB. The same 3 texts are
   129,703 of the rows' 131,835 bytes. In the context, the matching rows have no
   id and carry `metadata: {"compactionSummary": true}`. They are the synthetic
   USER row from helpers/summarize.py. Only 1 of the 47 feedback texts was
   still in the context, because compaction had removed the rest.
2. `_real_user_requirement_keys` (agents/loop/run_agent.py) skips hidden,
   agent-authored and model-excluded rows, but not compaction summaries. Every
   compaction therefore added a new requirement key.
   `_admit_durable_response_schema_feedback` queued the summary as user feedback
   (and bumped the response-schema revision), and the verifier treated the new
   key as fresh user feedback.
3. An id-less requirement key embeds the row's full text. `_continuation_resume_state`
   serialized the feedback text, then its source key, then its row key, so each
   summary crossed continue_as_new three times.
4. Each wakeable finished background record stored its spawn goal twice
   (`wake.base_goal` == `wake.tool_args.goal`, e.g. 2,235 bytes each way).
5. Deepest owned cause: continuation state had no "one copy" rule for anything
   except the conversation (fixed 2026-11-06). Fields grew with each compaction
   and each wakeable task, and `CONTINUATION_PAYLOAD_WARN_BYTES` only warned.

Archive searches: "TMPRL1103 continuation payload runtime_state continue_as_new"
and "compaction summary requirement feedback response_schema_feedback". Both
relatives apply, and neither is a recurrence of this boundary.
- 2026-11-06-continuation-carries-the-context-twice: same class. Its lesson
  ("carry bulk state in exactly one argument") is applied here to runtime_state.
- 2026-11-15 context-over-2mib (PR #2239): the sibling arg-6 cause.

Local repro: `BLACKBOX_CASE_FUNCTIONS=test_workflow_continuation_runtime_state_carries_feedback_and_background_once python scripts/run_blackbox_tests.py workflow`
from agents/ (venv active).
- Pre-fix it fails with "AssertionError: a compaction summary is the harness's
  own digest, not a user requirement".
- With only the run_agent fix it fails with "feedback carried more than once".
- With only the background fix missing it fails with "wake goal carried twice".
- Post-fix it passes (5/5 consecutive).

Replaying the prod snapshot through the fixed serializer gives 536,819 → 263,209
bytes:
- sources: 130,155 → 650
- rows: 131,835 → 2,330
- background: 100,004 → 85,404
The restored snapshot keeps the 3 legacy summaries as feedback, now carried
once. New runs never admit them, which leaves ~28 KB of real feedback.

## Solution

- `agents/loop/run_agent.py`: a `compactionSummary` USER row is not a requirement
  row, so it no longer becomes feedback or supersedes a verifier verdict.
- `agents/workflows/agent_workflow.py`: an id-less requirement key whose text is
  already `response_schema_feedback[i]` serializes as
  `["legacy_feedback_text", timestamp, i]`, and restore expands it back to the
  identical in-memory key. Snapshots written by the old code (inline text)
  restore unchanged.
- `agents/workflows/background_agents.py`: a finished record's `wake.base_goal`
  is omitted from the snapshot when it equals `tool_args.goal`, and restore
  re-derives it.
- Claim check (`agents/workflows/agent_workflow.py`, `agents/helpers/fetch_config.py`):
  a feedback entry proven bound to a durable USER message records its message id.
  - Binding is proven in one of two ways: durable admission from a row with an id,
    or a plain signal bound to the row it arrived as.
  - The continuation carries `{"message_id", "sha256"}` instead of the text.
  - At run start, `_hydrate_claim_checked_feedback` reads the text back through
    the read-only `fetch_message_texts` activity (`POST /api/agents/messages/batch`,
    user-scoped, 50 ids per request).
  - It accepts the DB text, or the DB text plus the context pointer suffix,
    whichever matches the digest. A mismatch logs an error and uses the stored
    message.
  - An entry whose message is gone is dropped (logged).
  - No schema refresh starts until the read-back finishes.
  - Feedback text therefore no longer grows the continuation args. Only id-less
    rows (rare) and attention responses still ride inline, once.

Nothing is truncated (rule 13). Every value restores exactly, and the summary
travels only in the context argument. The regression asserts:
- each feedback text and wake goal appears once in runtime_state;
- runtime_state stays within 20 KB of its unique content;
- id-bound feedback rides as id + digest and is read back exactly (including the pointer-suffixed form);
- a deleted message's entry is dropped;
- schema refresh waits for the read-back;
- the handoff stays well under 2 MiB with a context at #2239's 1.2 MB budget;
- old snapshots still round-trip (negative control).

10k agents:
- per-agent O(feedback) work at each continuation;
- one user-scoped batch read per restore (ceil(ids/50) requests);
- no shared state or fan-in.

Residual:
- Snapshots written before this change have no recorded message ids, so their
  existing feedback stays inline (once) and only new feedback is claim-checked.
- An old-code worker restoring a new snapshot would skip the claim-checked
  entries.

## Human feedback

None recorded.

## Reusable lesson

Every piece of state that crosses continue_as_new travels exactly once. A key
that embeds content must reference the copy instead of repeating it, and
harness-synthesized rows must never be counted as user input.
