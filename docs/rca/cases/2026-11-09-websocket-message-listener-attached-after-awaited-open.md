---
id: 2026-11-09-websocket-message-listener-attached-after-awaited-open
date: 2026-11-09
title: Codex app-server contract test dropped the ws-server's connection replay because it attached its message listener after awaiting open
surface: harness
component: e2b-codex-code-app-server-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: e2b-templates/codex-code/app-server.test.mjs "production default app-server supports authenticated attachments, steer and cursor replay" — `await new Promise(r => ws.once("open", r))` and only afterwards `ws.on("message", ...)`; ws 8.22 setSocket unshifts the bytes read with the 101 response and emits them on nextTick, before the awaited continuation attaches the listener
symptoms:
  - "AssertionError at app-server.test.mjs:587 wait(): logs \"Server listening\" then \"Client connected\", messages []"
  - "production default app-server supports authenticated attachments, steer and cursor replay"
  - "codex_native_app_server_contract"
  - "code-session-direct-chat FAIL under agents-coverage-blackbox (30-domain concurrency, Blacksmith 8vcpu)"
  - "no session ready within the 200x10ms wait; duration ~2120 ms"
tags:
  - websocket
  - ws
  - flaky-under-load
  - replay
  - code-session
  - codex
sources:
  - PR #1874, commit 15db895549809aa73f6cda284915927d5bce21a6, imported pending repair
  - PR #2290, source 546e440154645f394ddb683bf6dd019fe8f44474, stability run 43799065214
  - PR #1860 deploy gate agents-coverage-blackbox, GitHub Actions run 42576984007 (artifact deploy-gate-result code-session-direct-chat.log)
  - commit 15a52d6ea2dfa176892b21c40592101de9e8a1c4 failed source (NOT_INTRODUCED)
  - commit 1cc49114d fixed the same pattern in the sibling cursor-replay test only
repro: e2b-templates/codex-code/app-server.test.mjs (production default app-server test holds the viewer's reads until a later viewer sees ready)
status: fixed
---

## Problem

The deploy gate agents-coverage-blackbox failed `code-session-direct-chat`
(1 of 131 domains) because the node test "production default app-server
supports authenticated attachments, steer and cursor replay" never saw the
native session's `ready` event: the server log ended at `Server listening`,
`Client connected`, the client had received `messages []`, and the 200 x 10 ms
wait failed after ~2.1 s. The same source passed this gate in two other rounds.
The originating deploy observed the test take 1.5-2.1 s with 64 busy loops on 8
cores (0.3 s unloaded) and suspected slow startup under CPU starvation.

## Diagnosis

Startup-to-ready is not what dominates. A timing harness of the exact test
startup measured connect-to-ready at ~20 ms unloaded and 150-250 ms under 64
busy loops (mostly the fixture `codex` node cold start) — far below the 2 s
budget. The decisive clue is `messages []`: every connection receives at least
the `code_agent_events` replay containing `session:starting`, so the client
had received nothing at all.

The ws-server sends its event replay synchronously in the `connection` handler,
right behind the 101 upgrade response. In ws 8.22 the client's `setSocket`
does `socket.unshift(head)` for bytes that arrived in the same read as the 101
response and then emits `open`; those bytes are parsed and emitted as
`message` on `process.nextTick`, which runs before the `await`ed `open`
continuation. The test attached `ws.on("message")` only after that await, so
whatever shared the upgrade read was dropped. On an idle host the client reads
the 101 alone and `ready` arrives later as its own broadcast. When the client
is CPU-starved between sending the upgrade and reading the reply (30 concurrent
domains on 8 vCPU), the 101, the replay and `ready` land in one read and are
all lost — exactly `messages []` forever.

Local repro (deterministic): the test now holds the viewer socket's reads
(ws `createConnection`, socket paused) until a second viewer connected after it
has seen `ready`; the server is single-threaded and writes to clients in
connection order, so everything that viewer saw was already written to the held
socket. With the original listener order the test fails 5/5 with the gate's
signature (`Server listening`, `Client connected`, `[]`, ~2.15 s); with the
listener attached before `await open` it passes 5/5 (~170 ms), and 5/5
full-file runs pass under 64 busy loops on 8 cores.

Deepest owned cause: the same pattern was fixed in the sibling cursor-replay
test (commit 1cc49114d, "listen before awaiting open") without sweeping its
siblings, so the defect survived in this test and in the claude-code
direct-chat viewer helper. Production clients (back-end codeSessionTurns.ts,
the Python aiohttp clients, the browser terminal) attach listeners in the same
tick and are unaffected.

## Solution

Attach the message listener before awaiting `open` in the production-default
app-server test, and make the claude-code direct-chat `connect()` helper take
its message listener so its viewers do the same. The app-server test now
always exercises the starved-client read (upgrade, replay and `ready` in one
read), so a regression of the listener order fails deterministically in the
deploy path instead of only under load. Assertions and timeouts are unchanged.
Test-only change: no runtime, per-agent or 10k-agent behavior changes.

### Recurrence during PR2290 validation

On 2026-11-16, Blacksmith new-test-stability run 43799065214 reproduced the
same empty-message failure on source546e440154645f394ddb683bf6dd019fe8f44474.
The native suite passed its first repetition and failed the second. Independent
read-only RCA reproduced the loss on both current main bd35eaed and the repair
candidate using the real server and WebSocket traffic. Their failing test bodies
were byte-identical (SHA25679b10ef780009c4ef080e4972cf0af2dd5082841bcfd631e3ed1f32e5217b817).
Attaching the collector before awaiting open passed under the controlled ordering.
The native failure log was retrieved and verified against its artifact manifest.
This is NOT_INTRODUCED relative to the handoff repair. The existing PR1874 fix
was inspected rather than independently reimplemented. Integration and current
final-source verification remain pending; this record is open until they finish.

### Landed qualification (2026-11-16)

The inspected PR #1874 listener-order repair was integrated into PR #2290,
merge cc7a39b2846aa385320386bbb1374e74c989e6a4. The final 96d12280 source passed
all 17 native gates, including new-test stability. This closes this captured
recurrence with test-only listener ordering; no production client change or
full deployment-completion claim is implied.

## Human feedback

None recorded.

## Reusable lesson

With Node `ws`, attach `message` listeners in the same tick as `new WebSocket(...)` — never after `await`ing `open` — because data sent on connection can arrive with the upgrade and is emitted before the awaited continuation runs.
