---
id: 2026-11-14-artifact-ownership-ignored-by-trajectory
date: 2026-11-14
title: Trajectory rendered tool-owned file artifacts as standalone assistant attachments
surface: front-end
component: trajectory-tool-artifacts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/useMessageListProjection.ts ignored artifactOnly/sourceToolCallId before projecting standalone file rows
symptoms:
  - browser screenshots and files flood main trajectory
  - artifactOnly
  - sourceToolCallId
  - 318 standalone tool artifacts
  - screenshot_final.png
tags:
  - trajectory
  - attachments
  - browser
  - code-agent
sources:
  - agent 8789a5df-0119-4bbf-b90c-c7e58de56fe4
  - commit e0a3c84759e5b5c3ac33f525253a7dcfc4afa727
  - commit d7103ba60990932d0641966d82b375bd14e561ba
repro: front-end/src/tests/blackbox/tool-artifact-ownership.blackbox.tsx
status: open
---

## Problem

The production snapshot has 1,157 messages and 322 ASSISTANT file rows. Of these,
318 empty-text rows carry artifactOnly=true and sourceToolCallId: one browser
screenshot and 317 code-agent output files (80, 108, 129). Four explicit display
rows are intentionally visible. The 318 artifacts include 99 PNG images, 105
text files, 60 HTML files, 42 JSON files, eight octet-stream files, three ZIPs and
one JavaScript file. These are 318 distinct stored paths, not duplicate rows.

The supported dump-agent-messages.ts command and authenticated agent detail /
report-bug endpoints were captured privately under .context/rca-browser-artifacts.
The agent's report concerns browser initialization retries; that is a separate
issue and does not explain rendering its output files inline.

## Diagnosis

Source-to-sink path:

```text
browser/code output_files -> AssistantEvent -> handle_tool_event
  -> ASSISTANT(file_pointer, artifactOnly=true, sourceToolCallId)
  -> frontend root filter -> list projection -> file_pointer user-facing boundary
  -> AssistantAttachmentBubble -> inline images / file cards
```

The producer already preserves ownership. No frontend consumer read either
ownership field. The first incorrect semantic projection admitted these as
independent rows; trajectoryUserFacingBoundary then treated every file_pointer
as a user-facing boundary, and renderFallbackBubble rendered it standalone.

Actual Vite-loaded production replay before the repair: artifacts=318,
classifiedUserFacing=318, folded=0, exit 1. The first rendered blackbox command,
`cd front-end && npx vitest run src/tests/blackbox/tool-artifact-ownership.blackbox.tsx`,
failed three assertions showing screenshot/early artifact filenames immediately;
the ordinary-attachment negative passed. The identical command passed all four
unchanged original cases after repair. Expanded regression coverage also checks
full MessageList dedupe, code anchors with subAgentId, pending ownership,
background-run ambiguity, generic owners and PNG signing only after expansion.

Archive searches: `browser screenshots files main trajectory` and `browser
attachments tool result`. Related cases are 2026-08-26-browser-download-persist-static-assets-as-attachments
(different producer defect; these are intentional output files) and
2026-10-23-realtime-invariant-snapshot-shape-and-display-mirror-false-positive
(same typed-artifact distinction, different consumer). This is not a demonstrated
recurrence of either boundary.

## Solution

Frontend-only repair groups typed artifacts by exact sourceToolCallId/toolCallId
before trajectory compression. Browser Result expansion renders its attachments;
code and other tool bubbles provide a collapsed Files disclosure inside the
owning result. No file is removed from persisted messages or model context.
File signing/rendering starts only after expansion. Terminal owners beat progress
rows; code anchors tagged with subAgentId remain valid. Stored-path deduplication
prevents a retransmitted artifact from appearing twice under the same owner.

Missing owners remain accessible in collapsed disclosures until the owner arrives.
When a reused call has multiple background runs, an explicit artifact backgroundRun
selects its run. Historical artifacts lacking that field remain independently
collapsed rather than being guessed into the wrong run. Current production's
four originating calls are unique and all 318 files map to their exact owners.

Explicit displays, user uploads, ordinary attachments, authentication, approvals,
pinned questions and user-attention metadata retain their existing routes.
Golden reference: not applicable (no prompt, schema or harness behavior change).

10k-agent behavior: per-list O(messages + artifacts) time and memory using call/run
maps and per-owner path sets; no global fan-in, polling, services or backend calls
added. Collapsed file content does not mount or sign URLs.

Local implementation and regression are ready for parent review; deployment,
independent final review and final fixed outcome remain parent-owned. This case
stays open until that review/verification completes.

## Human feedback

The user required files under their actual browser/code tool result, collapsed
by default, not suppressed or attached to an unrelated tool. Preserve explicit
displays, uploads and attention controls. The parent required accessible pending
and unmatched files, progress owners, and reuse of the actual result expansion.

## Reusable lesson

Project typed tool artifacts through their ownership identity before treating file pointers as user-facing trajectory boundaries.
