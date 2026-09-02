---
id: 2026-09-02-sms-start-new-agent-drops-inbound-mms-attachments
date: 2026-09-02
title: SMS start_new_agent drops inbound MMS — create never receives filePointers
surface: back-end
component: sms-supervisor-start-new-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/smsSupervisor/supervisorTools.startAgent.ts commitStartNewAgent — creates USER goal message with no filePointer / no attachment messages even when the inbound SMS turn carried MMS media
symptoms:
  - "[7 attachment(s)]"
  - "file_pointer: null"
  - "start_new_agent"
  - "provided images"
  - "Remove the mirror stains/spots from the provided images"
tags:
  - sms
  - mms
  - attachments
  - start-new-agent
  - file-pointer
sources:
  - agent 6ea9cd1e-c02d-40f3-9c09-0905425f6769
repro: back-end/src/tests/blackbox/sms-supervisor.media.behavior.ts::testWriteCommit_startNewAgentForwardsInboundImageAttachments
status: open
---

## Problem

User texted Rose MMS photos ("Clean up the stains in the window for each
picture" + `[7 attachment(s)]`). The SMS supervisor correctly saw the images
(replied about mirror stains) and called `start_new_agent`, creating agent
`6ea9cd1e-c02d-40f3-9c09-0905425f6769`. The agent goal references "provided
images" / `list[file_pointer]` response schema, but every agent message has
`filePointer: null` — the create path never received the files. The execute
plan then tells subtasks they have "image attachments (all files attached to
this task)" that do not exist.

## Diagnosis

Critical path:

`Surge webhook attachments → routeToSupervisor → processInboundAttachments
(ephemeral base64 image_url blocks for supervisor LLM) → start_new_agent
PendingOp → commitStartNewAgent → Agent + USER message(goal text only) →
Temporal agent`

Binary search:

1. SMS session turn 17 persists `[7 attachment(s)]` — attachments arrived.
2. Supervisor reply acknowledges mirror stains — multimodal blocks reached the
   supervisor LLM.
3. Agent row `source=SMS`, goal about provided images — `start_new_agent`
   committed.
4. Agent USER message `filePointer: null`, zero attachment messages — **first
   bad sink**.

`processInboundAttachments` only builds ephemeral LLM content blocks. It never
uploads to Supabase Storage / `FilePointer`. `commitStartNewAgent` only creates
a text USER goal message and has no `attachments` argument, unlike
`POST /api/agents` → `createAgentTransaction` → `createAttachmentMessages`.

Archive searches (`sms attachment media file forward create`,
`inboundMedia MediaUrl attachments create agent`,
`file_pointer null SMS create agent attachment`,
`sms start_new_agent attachment file`): relatives exist for SMS media
persistence markers and for agent-side attachment use after a filePointer
exists, but **no prior case covers MMS → start_new_agent create forwarding**.
Novel incident (gap left by MMS inbound feature `d126a992e`, which stopped at
supervisor multimodal input).

Local repro (measured ~18s suite / ~130ms failing case):

```bash
cd back-end && bash scripts/run-blackbox-tests.sh sms-supervisor
```

Fails with:
`Expected start_new_agent to forward inbound MMS as USER filePointer message(s); got 0 attachment messages`.

## Solution

Proposed (awaiting approval — not implemented):

1. Extend inbound media processing to upload downloadable image (and other
   storable) attachments via `processUploadedFile` into `FilePointer`s for the
   current supervisor run.
2. Thread those pointers into `commitStartNewAgent` and create USER attachment
   messages the same way `createAttachmentMessages` / `POST /api/agents`
   does — auto-forward current-turn inbound media; do not rely on the LLM to
   invent storage paths.
3. Keep the new blackbox assertion permanently in `sms-supervisor`.

10k-agent behavior: O(attachments on one SMS create) storage uploads + message
rows per `start_new_agent` commit; no per-user fan-in, no shared broadcast.

## Human feedback

None recorded.

## Reusable lesson

When a surface accepts media for an LLM and can also spawn agents, upload that
media to storage and attach FilePointers on create — ephemeral multimodal
blocks are not a substitute for the create attachment contract.
