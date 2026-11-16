---
id: 2026-11-16-browser-recovery-stopped-between-tasks
date: 2026-11-16
title: Browser recovery stopped at a zero-task snapshot before a missed successor start
surface: front-end
component: selected-agent-backfill
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/agent-context/hooks/agentBackfill.ts runPostSubscribeBackfill terminated a browser recovery lease when one snapshot contained zero active browsers
symptoms:
  - 'first attempt of retried browser call: browser chip count never reached 1'
  - 'Error: page answered 32 probe(s); slowest 39ms'
  - 'Expected: 1 Received: 0'
tags:
  - browser-chip
  - realtime
  - backfill
sources:
  - memory:FLAKY occurrence 764c43fceeb84b16abc375a8b14cc00f
  - PR #2259 source 759e325c27b8302de4e6400369f5d3c64f2a7b25
  - memory:GitHub Actions run 43777553297 artifact 14186849376
repro: front-end/src/tests/blackbox/browser-start-recovery.blackbox.ts
status: open
---

## Problem

The original browser-chip semantic test timed out for 30 seconds with zero
chips when a distinct browser invocation should have produced one. Its single
rerun passed. The page answered 32 probes, slowest 39 ms. This is not evidence
of the renderer stall from October 2.

Recovered the original gate artifact independently of the originating devbox:
https://github.com/Rose-Ai-Labs/rose/actions/runs/43777553297/artifacts/14186849376 .
Local retained files are under `.context/browser-chip-repair/original-artifact`;
the trace is extracted under `.context/browser-chip-repair/trace`. The closed
forensic capture (1,192 files) is also encrypted in R2 with full authenticated
read-back verification. Its public receipt is
`docs/handoffs/browser-chip-count-repair/initial-evidence.json`; restore with the
existing `docs/handoffs/whm-b07d9037-preservation/private_archive.py restore`
command and the project-managed trace-archive encryption configuration.

## Diagnosis

Critical path: POST message → committed Message → asynchronous HTTP broadcast
→ selected-agent INSERT → canonical reconciliation → browser-panel reducer.

For root `f5d7c7b1-aafb-4ef7-a15c-364598ba2c4a`, the backend created retry-start
message `5b0c7bdc-4927-4873-b045-a57927b99469` at 23:58:38.116 UTC. The POST
returned 201 and the broadcast returned 202 at 23:58:38.159 (32 ms). There was
no publisher failure or selected-channel disconnect. Broker acceptance does
not acknowledge subscriber delivery; the trace does not contain websocket
frames, so the broker's internal reason for the missing notification is unknown.

The page's final selected-detail read (trace time 14830.459) contains the
completed A/B tasks and ACTIVE agent status. It makes no further selected-detail
read through the failing wait, and never opens retry-task-old's browser view.
The previous snapshots and earlier rendered lifecycle steps establish that the
browser recovery owner was running and then stopped on the terminal snapshot.
The pure reducer gives the expected 0→2→1→0→1→1→0 sequence.

Why could a missed notification persist for the whole budget? Reconciliation
ended on zero known active browsers even though its existing 150-second
browser recovery lease remained valid. Restarting required receiving the new
start itself. This circular recovery condition left a committed successor
invisible on a healthy connected page. The assigned repair owns that client
reconciliation defect; it does not claim to repair Supabase internals.

The permanent regression delivers a first start and terminal, reads the zero
snapshot, then persists a successor in its authoritative HTTP fixture without
delivering the successor notification. It uses the real subscription hook,
message handling and browser reducer. It does not claim to test persistence or
the external broker. Its controls prove ordinary completed chat does not poll,
the prior terminal still closes its chip, no reconnect is required, and repeated
snapshots cannot renew recovery indefinitely.

Archive searches: `browser chip count` and `realtime missed messages`.
This is a relative of the October 13 uncertain-broadcast case and July 21
one-shot snapshot case: successful transport does not establish complete client
state. The October 2 renderer-stall case is a different mechanism; responsive
probes and missing successor state rule out adopting that diagnosis here.

## Solution

Retain the existing finite browser recovery lease across zero-browser snapshots.
Browser activity renews it only for newly observed tasks (the existing chat-turn
renewal is unchanged), and ordinary completed chats still stop
immediately. No spec assertion, 30-second budget, provider permission, retry
count or polling interval changes. Golden reference: not applicable (no
approval-gated hunk).

At 10,000 agents, recovery remains isolated to each selected conversation with
an observed browser lifecycle, one request owner and the existing bounded
150-second lease; this adds no global scan or per-user fan-in. It can make
additional reads during that existing window after a terminal snapshot.

Identical narrow command before and after:
`cd front-end && npx vitest run src/tests/blackbox/browser-start-recovery.blackbox.ts`.
Before: exit 1, expected retry-task-old panel but received []. After: exit 0.
The final unchanged blackbox was rerun against baseline and fixed runtime:
exit 1 before, exit 0 after. The connected-backfill suite passes (11 cases across
both files). Both files passed five consecutive runs under eight CPU load slots
with the canonical stability selector (33 seconds).

A second semantic case reuses every original lifecycle assertion, but withholds
only retry-task-old websocket notifications while forwarding all other frames.
On the old bundled frontend it fails with the exact original 32-probe / 39-ms /
zero-chip error. On the fixed frontend both the unmodified no-fault control and
the dropped-notification case pass (32.2 and 34.3 seconds). The separate fixed
preview's first invocation had a wrong inferred backend port and was interrupted;
it is not counted as repair proof. The corrected preview uses same-origin API
proxying. The independent RCA reviewer accepted the causal fit and regression controls;
a separate final semantic review found no blocking flaw and explicitly required
five unchanged Playwright runs before stability credit. Full semantic and
deployment qualification remain pending.

## Human feedback

The user requires the original assertions and 30-second budget preserved,
quarantine release and deployment through production verification and cleanup.
No questions or human-dependent implementation choices.

## Reusable lesson

A zero-active snapshot settles known tasks, but cannot establish completeness
for a still-valid recovery window when successor notifications can be lost.
