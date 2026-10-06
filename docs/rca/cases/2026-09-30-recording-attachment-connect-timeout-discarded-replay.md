---
id: 2026-09-30-recording-attachment-connect-timeout-discarded-replay
date: 2026-09-30
title: A connection timeout discarded an already finalized browser replay attachment
surface: infra
component: browser-recording-message-persistence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/repo.py save_browser_action_message returned false after a pre-request ConnectTimeout without retrying required recording persistence
symptoms:
  - "Failed to save browser action message: ConnectTimeout"
  - "Browser recording message was not acknowledged"
  - "Cloud evidence finalization failed: TimeoutError"
tags:
  - recording
  - cloud-fleet
  - evidence
sources:
  - PR #1299
  - fleet run 20260930-125939-7453
  - agent 98ce88da-d2e1-470a-bc7b-6a139a3a4318
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: mitigated
---

## Problem

Proof73's first slice had eight complete results and two INFRA failures. The
Polar root's last archive observation at 13:16:07 UTC contained three terminal
browser tasks, but task `8d6062bc` had only an IN_PROGRESS recording row. The
slice received no proof credit. Original guest files were preserved from its
exact stopped volume; no recording was synthesized and no requirement waived.

## Diagnosis

The original worker stopped the Kernel replay at 13:13:08.698 and logged a
real view URL. Saving the FINISHED attachment then hit `ConnectTimeout` at
13:13:18.459. The finalizer rejected the negative acknowledgement and finished
cleanup without the attachment at 13:13:23.660. The other two browser tasks
saved their recordings successfully at 13:13:31 and 13:13:32. The three exact
provider sessions were released, but a longer archive poll could not restore
the discarded message. This differs from the earlier zero-allocation case:
this browser had a real session and owed its real recording.

## Solution

Only FINISHED recording persistence retries connection establishment or pool
acquisition failures, at most three attempts with the original tool call,
generation, headers and replay payload. Those failures precede request sending.
Read/write timeouts and HTTP rejections retain their negative acknowledgement;
generation sealing still propagates. Ordinary progress messages are unchanged.
There is no extra request on the healthy path and the existing five-second
request bound remains. At fleet scale, retries are task-local and bounded.

The permanent boundary repro failed before the fix with `a pre-request connection
failure must not discard a real recording`. The unchanged test passes after
the fix and checks byte-equivalent request arguments. Exhaustion, an ambiguous
ReadTimeout, and an ordinary progress message retain their bounded failures.
Nine message-persistence and four recording-finalizer tests pass. Live cloud
qualification and the requested ten-slice streak remain outstanding.

## Human feedback

The user requires infrastructure repair, real recordings, three successful LLM
queries per task, and unchanged benchmark scoring. The invalid slice is zero
credit even though its other eight tasks had complete evidence.

## Reusable lesson

Wait for asynchronous evidence only while a writer still exists. A completed
writer's failed pre-request persistence needs a bounded exact-payload retry.
