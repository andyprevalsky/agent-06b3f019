---
id: 2026-11-07-code-session-fixture-viewer-attached-after-cli-streamed
date: 2026-11-07
title: Code-session fixture test attached its viewer socket after the stand-in CLI had started streaming, so it compared the compacted replay with a live-stream fixture
surface: agents
component: code-session-direct-chat blackbox (replay_cli.py stand-in, LocalCodeSessionSandbox)
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tests/blackbox/code_session_direct_chat.blackbox.py _claude_session_with_direct_turn started SessionObserver after sandbox.start() returned, while the ws-server had already spawned the stand-in CLI; a viewer that attaches after output began is served the bounded replay, which since 8ee39ea54d omits the cumulative text of superseded partial snapshots
symptoms:
  - "ws-server output for claude_stream_json.events.json drifted from the committed fixture (85 vs 85 events; first difference at 7"
  - "claude_recording_through_ws_server_matches_event_fixture"
  - "code-session-direct-chat FAIL (16 passed, 1 failed)"
  - agents-coverage-blackbox gate FAIL on a loaded Blacksmith VM, passes on a quiet host
tags:
  - flaky-test
  - blackbox
  - deploy-gate
  - ws-server
  - replay
  - partial-messages
sources:
  - commit 8ee39ea54d (introduced the replay compaction; the fixture test was not updated)
  - PR #1751 deploy attempt 2, gate agents-coverage-blackbox at 9997bca37f
  - commit b3b2e83dd5 (fix)
repro: agents/tests/blackbox/code_session_direct_chat.blackbox.py::test_claude_recording_through_ws_server_matches_event_fixture (VIEWER_ATTACH_LAG_S) and ::test_late_viewer_replay_drops_only_superseded_partial_text
status: fixed
---

## Problem

In the PR #1751 deploy, gate `agents-coverage-blackbox` (`bash scripts/run-coverage.sh`,
two isolated coverage processes on a Blacksmith VM) failed one case of
`code-session-direct-chat` (16 passed, 1 failed):

`ws-server output for claude_stream_json.events.json drifted from the committed fixture
(85 vs 85 events; first difference at 7: [... "delta": "I'll read", "partial": true}]
!= [... "text": "I'll read", "delta": "I'll read", "partial": true}])`

Same event count, but the ws-server output lacked `text` on a partial
`agent_message` snapshot that the committed fixture carries. The same command
passes on a quiet devbox and on origin/main (308315a4bc) when run alone.

## Diagnosis

Attribution: `Gate: NOT_INTRODUCED`. The ws-server, the stand-in CLI, the helper,
the test and the fixture are byte-identical between origin/main (308315a4bc) and the
deploy source (9997bca37f), and origin/main fails the same way under the same condition.

Causal chain:

1. Commit 8ee39ea54d (Nov 4, `fix(code-agent): bounded ws replay`) made the ws-server
   keep only the latest snapshot's `text` per streamed item in its replay buffer
   (`supersedePartialSnapshot` in `e2b-templates/claude-code/ws-server.mjs`). That is
   the intended contract (case 2026-11-04-code-agent-superseded-partial-snapshots-retained:
   replay history grows with the output, not its square). Live `code_agent_event` frames
   still carry the cumulative `text`.
2. The committed fixture (`claude_stream_json.events.json`, Oct 20/21) is a capture of
   the live stream: every partial snapshot carries `text` and `delta`.
3. The test starts the ws-server, which spawns the stand-in CLI at once, and only then
   attaches its viewer (`SessionObserver.start`). Whatever the CLI emitted before the
   viewer attached arrives as `code_agent_events` replay (compacted: `delta` only);
   whatever it emitted afterwards arrives live (with `text`). On a quiet host the viewer
   attaches before the first text delta, so the fixture matches. When the test process
   is slower than the node + python startup (coverage tracing, two coverage processes
   on a shared VM), the first snapshots are replayed compacted and the comparison drifts
   at the first superseded snapshot (event 7).
4. Before 8ee39ea54d replay and live frames were identical, so the attach latency could
   not matter; that commit created the race and did not touch this test.

Reproduction (see Solution for the permanent form): the unchanged test body with the
viewer attached 50 ms late fails with the gate's message byte for byte
(`/tmp`-scratch `late_attach.py`: delay 0 PASS, 0.05/0.3/1.0 FAIL on both the deploy
branch and origin/main). Bisect on the ws-server alone with the same 0.3 s delay:
8ee39ea54d^ PASS, 8ee39ea54d FAIL. The codex fixture has no partial snapshots and is
unaffected at 0.3 s and 1.0 s.

Consumers of the dropped field were checked: `utils/code_transcript.py` already treats a
replayed partial without `text` as a revision of its item (8ee39ea54d), the Python loop
compacts the same way (`_supersede_partial_snapshot`), and the front-end reads the
built UI records, not raw ws events. Nothing depends on `text` surviving in replay.

Not a producer regression, and not a fixture to regenerate: regenerating the fixture
from a late viewer would have pinned the compacted shape and hidden the live contract.

## Solution

Test-harness only; no ws-server, fixture, prompt or runtime change.

- `replay_cli.py`: opt-in `REPLAY_CLI_START_GATE` holds the first turn's first output
  line until `<gate>/start-turn-1` exists.
- `LocalCodeSessionSandbox(hold_first_turn_output=True)` sets it;
  `release_first_turn_output()` releases it.
- The fixture test attaches the viewer, then releases the CLI, so every recorded event
  reaches the viewer live. It also sleeps `VIEWER_ATTACH_LAG_S` (0.5 s) before attaching,
  like the scripted CLI in case 2026-11-05-live-resume-test-read-turns-before-cli-consumed:
  the hazard is kept deliberate, so removing the hold fails every run instead of only on
  a loaded host (before the hold, the permanent test failed with the gate's exact message).
- New `late_viewer_replay_drops_only_superseded_partial_text` pins the contract that
  made the hold necessary: a late viewer's replay equals the live view minus `text` on
  the 32 superseded partial snapshots (the pre-8ee39ea54d server compacts 0 of 32, so
  the test fails there).

Siblings: any test that compares ws-server frames to a live-stream capture now has a
documented way to attach before the stream starts. 10k-agent behavior: unchanged, test
code only.

## Human feedback

None recorded.

## Reusable lesson

A test that compares a live-stream capture must hold its source until the viewer is attached (and attach late on purpose), because a late viewer is served a different, replay-shaped view of the same session.
