---
id: 2026-10-23-claude-cli-initialize-deadline-shorter-than-cold-start
date: 2026-10-23
title: Sandbox ws-server gave a cold Claude CLI 5s to answer initialize, so first Claude Code sessions failed settings_unconfirmed
surface: infra
component: claude-code-sandbox-ws-server
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: e2b-templates/claude-code/ws-server.mjs cliControl — the startup initialize control_request shared the 5000 ms settings-confirmation deadline, but the CLI answers initialize only after its own startup, which exceeded 5.5s on cold E2B sandboxes
symptoms:
  - "[Error] settings_unconfirmed"
  - "Closing CLI stdin reason=native settings unconfirmed"
  - "Agentic loop finished: 0 interactions"
  - "The previous Claude Code attempt failed immediately with settings_unconfirmed, zero interactions"
  - "Timeout after 305s (task timeout=300s)"
tags:
  - claude-code
  - e2b
  - ws-server
  - cold-start
  - cloudbench
  - descend
sources:
  - benchmark run original600-1792738962466034914 (descend-full69-20261023 outcome proof on 8b69d3760)
  - fleet run 20261023-071845-27473 (job r002-j0010, agent 4f97f72e-5655-4457-8ab9-a3b1a51a9eeb)
  - fleet run 20261023-071845-27493 (job r003-j0019, agent d5def233-b4d0-4b2d-8db7-0abf07def3be)
  - fleet run 20261023-071845-27545 (job r005-j0037, agent 8ba99d40-4201-4aeb-8038-bf5ac8b1d22b)
  - task claude-code-agent
repro: e2b-templates/claude-code/direct-chat.test.mjs "Claude cold start" (run by agents/tests/blackbox/code_session_direct_chat.blackbox.py::test_claude_native_direct_chat_contract)
status: open
---

## Problem

The `/descend` outcome proof for K4/K9 (5 cloud copies of `claude-code-agent`
on 8b69d3760) failed r002-j0010, `Timeout after 305s (task timeout=300s)`.
K4/K9 held: every copy logged `[ClaudeCode] Selected code sandbox provider
code_provider=claude` and `Verifier skipped via ROSE_DISABLE_CODE_AGENT_VERIFIER`.

In 3 of 5 copies (27473, 27493, 27545) the first Claude Code session died before
any turn: SDK events `session starting` 07:32:45.271Z → `error
settings_unconfirmed` 07:32:50.769Z → `final failed exit_code 1`. The root then
re-spawned Claude Code. Measured `session starting` → `turn_started` (initialize
+ apply_flag_settings both confirmed): first sessions that passed 2.8s and 3.0s;
the three failures exceeded 5.5s; warm re-spawns 0.8–2.0s. The 5s deadline sat
inside the cold-start distribution.

## Diagnosis

`runClaudeCli` sends `initialize` and awaits `cliControl`, which rejected
`settings_unconfirmed` after a fixed 5000 ms; the catch closes stdin and
SIGTERMs the CLI (exit 1). The CLI processes `initialize` in its stdin loop only
after startup (claude-code-src/src/cli/print.ts:2863), so this deadline measures
CLI cold start, not settings confirmation. The 5s value was designed for runtime
settings changes during direct chat.

This is one contributor to r002-j0010, not the whole timeout. In that copy the
failed session plus re-spawn cost 07:32:32→07:33:43. A separate defect then
consumed the budget: after the successful re-spawn, the root started a third,
presentation-only Claude Code session ("Create and publish a compact Rose
scorecard in Agent Display…", task `collatz_card`, 07:34:05 until the 300s
pause). That follows the branch-only system-prompt section
"# Presenting results as Rose scorecards" (6d1dfa66d, agents/utils/prompts.py).
Copy 27493 did the same and passed narrowly. That boundary is split to its own
HARNESS cluster. A third defect also appears: every successful session with the
verifier disabled is labelled `❌ FAILED … Required output artifacts were not
completely extracted - incomplete`. In this copy the root still understood the
run had succeeded, so this label is not the timeout cause. It is split too.

## Solution

The startup `initialize` request now waits for the CLI's answer or its exit; the
existing close handler rejects it with `session_ended`. Runtime settings changes
keep the 5s confirmation deadline (`cliControl(request, confirmWithinMs = 5000)`).
This converges on OpenClaw `extensions/anthropic/cli-transport.ts:308-315`,
which awaits the initialize response with no fixed deadline and fails only when
the process fails. A hung CLI remains bounded by the caller's existing
code-agent silence watchdog. 10k agents: no new per-agent work, connections or
state. Each sandbox waits once at startup.

Regression: `direct-chat.test.mjs` "Claude cold start", where the fake CLI
answers initialize after 6.5s. It failed `['settings_unconfirmed']` before the
fix and passes after it. It runs in deploy Step 4g through the agents blackbox
domain `code_session_direct_chat`. The fix reaches cloud and production only
after the E2B template `kng6z68u1md05bfdhq47` is rebuilt from
e2b-templates/claude-code (the Dockerfile COPYs ws-server.mjs). Outcome proof
for the benchmark is still pending.

## Human feedback

None recorded.

Related cases: 2026-10-23-cloud-guest-omitted-claude-code-provider-pin (K4/K9,
whose outcome proof exposed this) and
2026-07-21-fixed-wmh-readiness-window-shorter-than-cold-model-load (same class).

## Reusable lesson

Never bound a child-process startup handshake with a deadline built for steady-state requests. Wait for its answer or its exit, and measure cold-start latency before choosing any bound.
