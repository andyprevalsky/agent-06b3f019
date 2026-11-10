---
id: 2026-11-10-chat-protected-tool-body-defeats-compaction
date: 2026-11-10
title: A recent multi-megabyte grep result survived chat compaction and overflowed the next router request
surface: back-end
component: chat-compaction
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/chatCompaction.ts compressChatContext retains oversized TOOL bodies in its protected tail
symptoms:
  - "Compaction did not reduce context (786002 -> 787018 estimated tokens)"
  - "Chat router completion expired"
  - "Sorry — I couldn't generate a response just now. Please try again."
  - "Cerebras 400 (request_id=b8e8db49edc3)"
tags:
  - chat
  - grep
  - compaction
  - protected-tail
  - oversized-tool-result
sources:
  - agent ebb350db-303b-4e6a-b8b0-2d40dc9f9251
  - commit c1a3a0c71e589a486e6f4b07ae982bee74406504
repro: back-end/src/tests/blackbox/chat-compaction.blackbox.ts
status: open
---

## Problem

Production chat agent `ebb350db-303b-4e6a-b8b0-2d40dc9f9251` searched for
saved Azure credit justification. Its first grep failed regex safety analysis;
the next router recovered and requested `azure`, documents/email, before/after
5 and head_limit 20. That successful result was 2,244,783 characters: twenty
matches, each with multiple full email records, including overlapping context
and both content and structured records. No agent self-report existed (the
production report-bug endpoint returned HTTP 200 with report null).

Render's complete incident-window collection records a successful compaction
provider call, then `Compaction did not reduce context (786002 -> 787018
estimated tokens)`. The unchanged history reached the next router, which saw
Cerebras 400, then 429 on retry, plus empty hedged streams and two 15-second
deadlines. At 23:03:22.412Z the generic failure notice was persisted. The 207-byte
400 body and the original assembled model calls were not archived; the precise
provider explanation is unproven. This case proves the owned compaction defect,
not an invented provider error code or model-intelligence diagnosis.

## Diagnosis

Critical path: grep -> persisted TOOL JSON -> chat history loader -> compaction
-> router and speculative generator. A recent tool row can exceed the entire
context window, but head/tail splitting protects the latest four rows. Summarizing
only the middle cannot reduce that protected floor. The savings guard correctly
rejects growth; the caller then passes the unchanged oversized history onward.
The deepest owned error is treating recency as unconditional protection of a
tool body, even under context pressure. The raw source evidence remains valid.

Relevant deployed source is byte-identical to local pre-fix source, independently
bound to Render deployment `dep-dbp9r1rbc2fs73bamjsg` and commit c1a3a0c71.
Archive searches included `Sorry couldn’t generate response grep context`,
`grep large email context token overflow`, `Compaction did not reduce context`,
and `chat oversized grep protected tail router deadline`. This is a relative of
2026-09-28-explore-compaction-protected-tail-floor-above-trigger, on the TS chat
boundary; the October 23 whole-record paging case explains why slicing JSON
would be an incorrect repair. Existing chat grep/profile and chat evidence
publication owners explicitly confirmed they do not own this production incident.
Other active Bug Report work was read by actual evidence. Project folder
membership could not be exhaustively verified through the current read API.

Permanent owning-boundary reproduction, executed before production edits:

    env -u FLY_APP_NAME NODE_ENV=development DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria node --import tsx back-end/src/tests/blackbox/chat-compaction.blackbox.ts

The sanitized seven-row fixture preserves the measured huge-result size and
recent-tail placement. The real compaction function and client assemble a real
request; only external summary text is controlled. Before: throws
`Compaction did not reduce context (785736 -> 785758 estimated tokens)` in
672ms. After, same command and assertions: 785736 -> 99 estimated tokens,
672ms, all fourteen cases pass. It also asserts unchanged raw history, verbatim
user request, preserved tool identity/status and explicit summary. This is
causal contract proof, not proof of summary intelligence or the user's retrieval
outcome. Production failure bodies and complete original wire capture remain an
observability gap; a controlled reconstructed provider replay is separate work.

## Solution

Candidate: before ordinary head/tail compaction, summarize oversized TOOL bodies
in place under context pressure, largest first, using the existing summarizer
and existing KEEP_RECENT_TOKENS bound. Stop once the context fits; otherwise
continue normal head/tail compaction. Preserve message order, user/assistant
instructions, tool-call identity/status and raw persisted evidence. Reject
non-shrinking summaries and retain the existing savings guard. No regex,
provider, deadline, prompt, schema or benchmark contract is weakened.

Reference mechanisms opened: Hermes `agent/context_compressor.py:3315` pressure
demotion explicitly summarizes even the newest huge tool body; Claude Code
`src/utils/toolResultStorage.ts:276` retains original tool output and substitutes
a smaller model-facing representation; OpenClaw
`src/agents/embedded-agent-runner/tool-result-truncation.ts` bounds model-facing
tool projections separately from durable history. Golden review and deployment
remain pending; do not interpret this candidate as production acceptance.

At 10k concurrent agents, work remains per-conversation: O(n log n) local
selection only when over budget, no extra DB reads or broadcasts. Only oversized
tool results need additional existing-summary calls; ordinary chats retain their
current path. Summaries are lossy and model-dependent; source records remain
available through the original search. No raw production text or credentials are
committed. The existing chat-compaction blackbox runner owns the regression and
is included by backend coverage/blackbox deploy gates.

## Human feedback

The user required completing RCA and deploy, and reconciling existing bug
ownership by actual work and evidence before editing. No incident-specific
technical fix was approved or rejected by the user.

## Reusable lesson

Under context pressure, shrink oversized tool bodies before protecting recent
turns; a summary of older messages cannot reduce an oversized protected tail.
