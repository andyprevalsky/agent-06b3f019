---
id: 2026-11-08-background-child-vetoes-parent-thinking
date: 2026-11-08
title: Background child progress suppressed a new parent model call's Thinking state
surface: front-end
component: thinking-visibility
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useThinkingVisibility treated every persisted IN_PROGRESS background child as blocking the parent's live model stream
symptoms:
  - so i can finish booking myself
  - took something like 30s for the fe to show the state
  - Thinking hidden while a background child remains IN_PROGRESS
  - ASSISTANT_STREAM start precedes first TOOL_STREAM by 27 seconds
tags:
  - thinking
  - background-agents
  - realtime
  - visibility
sources:
  - agent 784d6a3b-2b10-452b-a07b-a1dca682c251
  - commit 9a038b1e9f51ed8c7e419073c8cae63c08bf7a1c
  - memory:boxes-thread-ph7chyy9knyndf8rammrf6f60s8hvjs1
  - PR #1857
  - commit 5a0b1c6c150295da187c737f4ffa023907180e24
repro: cd front-end && npx vitest run src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx
status: fixed
---

## Problem

The user reported a roughly 30-second frontend state delay after asking for
flight links to finish booking themselves. Production records on November 8:
USER persisted 22:03:08.624Z, workflow received it 22:03:08.711625Z,
POST returned 201 in 227 ms, wait_for FINISHED at 22:03:11.940Z. An empty
ASSISTANT_STREAM started 22:03:14.120681Z and its worker broadcast succeeded
in 47 ms. The next TOOL_STREAM began 22:03:41.305629Z; the assistant tool-call
row persisted 22:03:43.237Z (34.613 s after the user input).
The model call itself took 27.822 s, including a structured TTFT of 27.183 s.
This fix addresses the missing live-thinking indication during that wait;
it does not shorten or attribute the provider's generation latency.

The agent's own report_bug is a different incident: a browser StartToClose
timeout and cleanup HTTP 500 around 19:36, not this UI delay.
Private raw runtime evidence is retained under .context/rca-784d/investigator
(API/DB read-only snapshots, retained worker logs, Render logs, latency/cache
results, and independently executed projection observation).

## Diagnosis

Path: user POST -> persisted USER -> workflow wake -> wait_for FINISHED ->
new model call -> empty ASSISTANT_STREAM -> realtime handler -> message-list
filter/dedup -> thinking visibility -> rendered state.

The source and transport did not exhibit the reported 30-second gap: captured
backend broadcasts accepted 202; a root stream began before model output.
The real production message projection still preserved an IN_PROGRESS
background spawn from 21:46:59.945Z, with excludeFromModel=true. Keeping that
child running is correct. The visibility hook incorrectly treated any tool
progress as exclusive foreground work, vetoing the parent's actual model
stream. Its duplicate last-tool check and all-tools scan shared this assumption.
The deepest owned cause is a UI concurrency contract mismatch: asynchronous
child progress was allowed alongside parent work by the transcript projection,
but treated as mutually exclusive by the thinking projection.

Archive searches: `thinking background spawn IN_PROGRESS` and
`stream thinking hidden user response`, plus independent literal/symptom
searches. Read delivery/backfill cases from July 17/21 and November 6 thinking
row rendering case. This is a relative, not a demonstrated recurrence: neither
auth/backfill loss nor thought-row metrics explain this veto. Active owners of
PR1708, PR1743 and PR1826 confirmed different boundaries and no ownership of
this delay before edits. The same agent's separate browser self-report was read.
The Bugs folder exists; its listing does not expose devbox membership here.
Project-wide active bug discovery and evidence-based owner reconciliation were
used rather than claiming a complete folder-membership inventory.

Historical browser socket receipts and pixels were not captured. Broadcast
acceptance is not proof of delivery. Therefore the proven local hidden-thinking
mechanism is not claimed as the exclusive explanation of the user's historical
screen. Current status_message is not treated as historical state evidence.

## Solution

Use one blocking-tool scan. A background spawn no longer blocks the current
scope's confirmed live model stream; foreground tools, plans, attention and
terminal agent states retain their existing precedence. A stream counts as
current work only when it is unfinished and belongs to the displayed scope:
a child stream included for display, or a retained done bubble, is not evidence
that the root is thinking. This deletes a duplicate guard and reuses the existing
background-row contract rather than finishing the child or inventing activity.
Golden reference: not applicable (no approval-gated hunk).

The owning MessageList blackbox preserves the captured background-progress,
user-reply, finished wait and empty stream sequence through the real handler,
filtering, deduplication and rendered component. It asserts Thinking promptly
with no model text and the child chip still IN_PROGRESS. Controls cover
background-only/no stream, child-only stream, completed stream and a foreground
tool. The original foreground/terminal/hung-chat regressions remain intact.
This file is auto-discovered by the normal frontend blackbox/coverage gate.

Initial test failed on missing Thinking (1 failed/2 passed, 10.16 s). The first
fix exposed an incorrect ancillary assertion expecting collapsed wait detail to
be visible; that assertion was corrected to inspect the actual rendered tool
state, and the final permanent test was rerun on the original production code
before reapplying the fix. All original attempt logs are retained.
Final unchanged command: `cd front-end && npx vitest run
src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx`. Original
production code: 1 failed / 6 passed, 11.98 s, missing Thinking. Fixed code:
7 passed, 11.68 s, followed by five additional green runs (the last five use the identical formatted file). Related
thinking/plan/tool-row suites passed 29 tests and frontend TypeScript passed. Independent adversarial review passed the final three-file
change after rejecting an initial overly broad stream predicate. All twelve selected deployment gates passed, including thirteen smoke tasks
with verified cleanup and no retries. PR #1857 merged and production web,
Mac release v1.1.299 and live semantic verification passed on the merge.
Manual local-Mac acceptance was SKIPPED after authenticated discovery returned
HTTP 200 with zero devices at 23:19:17Z. Fixed here describes the proven UI mechanism,
not the uncaptured historical browser receipt or the provider's 27.8 s wait.

## Human feedback

The user required reading other active bug threads before editing and reconciling
actual evidence with any existing owner, then completing deployment. No user
permission was inferred from an idle thread or an owner label.

## Reusable lesson

Separate background child progress from the displayed agent's live model activity before deciding whether to hide thinking.

### Operational evidence note

The CLI-native smoke card retains source/lifecycle projection gaps
(UNRECORDED and 0/13) despite the exact per-run receipts proving all thirteen
source bindings and released lifecycles. The native card was not edited. The
private and sanitized closeout smoke-final-proof.json preserves the complete
checks and this open reporting observation. It is separate from the fixed
product Thinking-state veto; no repair or inferred cause is claimed for it.
