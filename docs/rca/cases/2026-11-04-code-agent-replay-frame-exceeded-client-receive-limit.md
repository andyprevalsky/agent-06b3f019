---
id: 2026-11-04-code-agent-replay-frame-exceeded-client-receive-limit
date: 2026-11-04
title: Code-agent reattach livelocked once the sandbox's one-frame event replay exceeded aiohttp's 4 MiB receive limit
surface: cross
component: code-agent-ws-transport
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/claude-code/ws-server.mjs (and codex-code) connection handler sent the whole unbounded eventBuffer as one code_agent_events frame, which agents/helpers/claude_code_ws_client.py ws_connect (default max_msg_size 4 MiB) refused with 1009; connect() then reset _reconnect_count on every handshake
symptoms:
  - "[ClaudeCodeWs] WS error"
  - "Message size 4194304 exceeds limit"
  - "WSCloseCode.MESSAGE_TOO_BIG"
  - "Served final buffer to reattaching client" logged in a loop by the sandbox ws-server
  - spawn_claude_code_agent never returns after a deploy drain reattach; sandbox stays billed
tags:
  - websocket
  - aiohttp
  - message-too-big
  - replay
  - reconnect-livelock
  - code-agent
  - e2b
  - multi-day
sources:
  - commit 28a7bfc99 (base on which the repro fails; fix on branch fix/code-agent-multiday-t1-ws-transport)
  - task T1 of the parent RCA "Review long-running rose code agents" (devbox 211c7467), finding T1 #1
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_run_agentic_loop_reattaches_after_replay_exceeds_one_frame_limit (+ test_sandbox_replay_frames_fit_a_default_client_limit, test_run_agentic_loop_applies_a_chunked_replay_as_one_history; claude_code_ws_client.blackbox.py::test_reads_single_frame_history_larger_than_aiohttp_default, test_reconnects_without_progress_exhaust_the_budget)
status: fixed
---

## Problem

A code session that streamed a long answer could never be reattached. The
regression drives the production `ws-server.mjs` with a scripted `claude` CLI
that streams one 120 kB answer as 120 deltas, emits its result and exits, then
runs the real `_run_agentic_loop` against it. On base 28a7bfc99 the loop never
returned: `reattach never read the exit; 27 replays served in 30s`. The client
unit regression (sandbox closes every connection after a `buffer` frame)
reconnected 9,172 times in 10 s without exhausting `max_reconnects=3`.

## Diagnosis

1. `appendEvent` stored every `--include-partial-messages` delta as an event
   whose `text` is the whole block so far, so `eventBuffer` grew with the square
   of message length (a 120 kB answer = 7.4 MB of history) and was never trimmed.
2. Every connect without `?cursor=` sent that history as ONE `code_agent_events`
   frame. The worker's `ws_connect` set no `max_msg_size`, so aiohttp (3.14)
   refused frames over 4 MiB: `WSMsgType.ERROR`, `_listen_loop` broke, and the
   exit frame queued behind the replay was never read.
3. `_reconnect()` called `connect()`, which reset `_reconnect_count = 0` on each
   successful handshake, so the budget never ran out; each reconnect also called
   `on_connection_change(True)`, which reset the idle timer. Net: a ~1 Hz
   reconnect loop forever, tool call never returns, sandbox stays billed.

Deepest owned cause: the transport had no contract that a frame fits the
receiver, and "progress" for the retry budget was defined as a TCP handshake
rather than delivered data. Step 6b reference: Claude Code's remote SSE
transport resumes from the last processed sequence instead of replaying the
whole history (`claude-code-src/src/cli/transports/SSETransport.ts:246-247`,
`from_sequence_num`). It does reset `reconnectAttempts` on open (`:314`,
`WebSocketTransport.ts:312`), which is safe there only because a reconnect
never re-sends the full history; Rose had both a full replay and a
handshake-reset budget, so it diverges here and resets on delivered data.

## Solution

- Both ws-servers bound replay frames: a client that sends `?replay_chunks=1`
  gets `code_agent_events` chunks of <= 1 MiB (`chunk` 0 replaces, later chunks
  append, `last` marks the end); the terminal buffer replays as `buffer` +
  `stdout` chunks (256 K chars), which every client already appends. Older
  clients still get the single frame they expect.
- Superseded partial snapshots drop their cumulative `text` in the stored
  buffer (the delta stays), so history is linear in output (see
  2026-11-04-code-agent-superseded-partial-snapshots-retained).
- The client opts into chunks and buffers them, delivering the whole replay
  once when `last` arrives (an adversarial review showed that acting on chunk 0
  alone ended a Codex attachment on turn "first" while chunk 1 started turn
  "second"; regression `test_run_agentic_loop_applies_a_chunked_replay_as_one_history`). It accepts
  arbitrary frame sizes from sandboxes built before this change
  (`WS_MAX_MSG_SIZE = 0`, the history the sandbox already holds), and resets
  the reconnect budget only when an event, a complete replay or the exit is
  delivered, so a connection that fails before delivering anything exhausts it.

10k-agent behavior: one connection per attached code session as before; replay
cost per reattach is now linear in the session's output and split into <= 1 MiB
frames, so peak per-frame worker memory is bounded for chunk-aware sandboxes;
no shared state is added. A dead or poisoned sandbox now costs at most
`max_reconnects` attempts instead of an unbounded loop.

Pending: fix is on the branch; the parent integrates it into the combined
whole-devbox deploy. Existing sandboxes keep their old ws-server until rebuilt,
which the client's unlimited receive size covers.

Follow-up (2026-11-05, CodeRabbit 4475152990 on PR #1691): a complete replay
counted as progress even when it resent the same history, so a sandbox that
replayed and then dropped every connection still refilled the budget (8,843
reconnects in 10 s). The client now counts a replay as progress only when it
is longer than the history already delivered (regression
`test_unchanged_replays_do_not_refill_the_reconnect_budget`).

## Human feedback

None recorded.

## Reusable lesson

Bound every replay frame below the receiver's limit and count a reconnect as progress only after data is delivered, never on the handshake.
