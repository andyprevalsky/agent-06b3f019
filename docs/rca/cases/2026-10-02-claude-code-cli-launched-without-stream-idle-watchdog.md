---
id: 2026-10-02-claude-code-cli-launched-without-stream-idle-watchdog
date: 2026-10-02
title: Claude Code CLI ran with its stream idle watchdog off, so a stalled Anthropic stream hung the sandbox session silently
surface: cross
component: claude-code-ws-server
classification: third-party-failure
problem_class: other
first_bad_boundary: e2b-templates/claude-code/ws-server.mjs runClaudeCli spawn env, which launched the CLI without CLAUDE_ENABLE_STREAM_WATCHDOG, so the CLI never bounded an idle /v1/messages stream body
symptoms:
  - Timeout after 193s (dynamic cap=189s)
  - Claude Code working (211s) with no new CLI output after the first Bash tool_result
  - claude-code-agent smoke status PAUSED (expected COMPLETED)
  - Extending SDK idle timeout for post-result stretch tool idle_limit_s=900.0
  - Received code-agent event event_type=cli_message with its contents never logged
tags:
  - claude-code
  - e2b
  - anthropic-streaming
  - stream-stall
  - idle-watchdog
  - rate-limit-observability
  - smoke-benchmark
sources:
  - agent 28b8f555-09ce-412a-b602-39176869f1ec
  - task d35c4db2-0ba8-40c9-a41d-00027b6c0427
  - benchmark run 20261003_012531 claude-code-agent
repro: back-end/src/tests/unit/claude-code-ws-cli-env.test.ts
status: mitigated
---

## Problem

The `claude-code-agent` smoke benchmark (agent `28b8f555`, Claude Code task
`d35c4db2-0ba8-40c9-a41d-00027b6c0427`, E2B sandbox `iis114x0aek9v8gm1owch`)
failed with `Timeout after 193s (dynamic cap=189s)` and status `PAUSED`. Worker
log timeline (UTC, 2026-10-03):

- 01:08:59.6 session created; 01:09:00.2 WebSocket connected, `session starting`.
- 01:09:03.5 CLI `system.init`; 01:09:04.2 one `cli_message` event (contents
  dropped by our logger).
- 01:09:06.0 `tool_use Bash`, so the first Anthropic `/v1/messages` call
  completed. 01:09:06.3 `tool_result`; 01:09:07.4 last CLI output.
- 01:09:30 to 01:12:30: only our own `Claude Code working (Ns)` progress
  messages. The CLI wrote nothing to stdout or stderr and emitted no more
  events. The second `/v1/messages` streaming request (the turn after the Bash
  result) never produced a chunk.
- 01:12:32 the benchmark cap paused the agent (`Cancelling due to pause`).
  01:12:59.7 WebSocket listen cancelled, then `Session Cancelled`.

The CLI sat silent for about 233s (01:09:06.3 to 01:12:59.7) inside one
streaming request.

## Diagnosis

Quota/rate limit ruled out:
- The 5h subscription window reset at 00:50, before the run.
- The first `/v1/messages` call succeeded (01:09:06 tool_use).
- No `system.api_retry` arrived during the stall. The CLI emits each retry as
  a stream-json message, which ws-server forwards as a `cli_message` event.
  Only one `cli_message` arrived (01:09:04, before the first tool_use) and none
  after 01:09:07.

So the CLI was not backing off. It was blocked reading one streaming response
body.

Why the block was unbounded: the vendored CLI source
(`claude-code-src/src/services/api/claude.ts:1868-1925`) only arms its
streaming idle watchdog when `CLAUDE_ENABLE_STREAM_WATCHDOG` is truthy. Its own
comment says "a silently dropped connection can hang the session indefinitely
since the SDK's request timeout only covers the initial fetch(), not the
streaming body". When enabled, it aborts after `CLAUDE_STREAM_IDLE_TIMEOUT_MS`
(default 90s) and throws `Stream idle timeout - no chunks received`. That
drops into the non-streaming retry path (`claude.ts:2310-2335`).

Our only CLI spawn site is
`e2b-templates/claude-code/ws-server.mjs` `runClaudeCli`. Both the E2B overlay
and the local fallback (`claudeCodeLocalSession.ts`) launch this file. It passed
`{...process.env, HOME, NO_COLOR}`, and no layer (backend sandbox `envs`, E2B
template, ws-server) set the flag. So every Claude Code session ran with the
watchdog off. Our outer harness bound did not help either: the Bash tool_use
stretched the SDK idle timeout to 900s (`Extending SDK idle timeout for
post-result stretch tool`). The 189s benchmark cap fired first.

Why the evidence stops here: `_log_code_agent_event`
(`agents/domains/spawn_claude_code_agent/service.py`) threw away the contents
of every `cli_message`. The CLI's `rate_limit_event` (status, type,
utilization, resetsAt, overage) and `api_retry` (attempt, delay, HTTP status,
error) never reached retained logs. Quota therefore had to be ruled out
indirectly. The network-layer cause of the stall (Anthropic edge vs. E2B egress
vs. a half-open TCP connection) is unproven. Nothing captured the stalled
request's id or socket state, and the stall has not been reproduced locally.
Classification is third-party-failure (the upstream stream went silent), and
status is `mitigated`.

Problem bucket: `other`. "Timeout too aggressive" is excluded because the path
was blocked, not making progress. The missing bucket candidate is "unbounded
wait on a silent third-party stream (missing liveness bound at the client that
owns the stream)".

## Solution

1. `e2b-templates/claude-code/ws-server.mjs` now forces
   `CLAUDE_ENABLE_STREAM_WATCHDOG=1` into the CLI child env. It goes after the
   `process.env` spread, so an inherited `0` cannot disable it. It keeps the
   CLI's own 90s default, so `CLAUDE_STREAM_IDLE_TIMEOUT_MS` stays unset. A
   silently dropped stream now aborts after 90s idle and retries
   non-streaming instead of hanging until an outer timeout. This covers every
   Claude Code session (E2B overlay and local fallback). Codex sessions use a
   separate ws-server and are unchanged.
2. `_log_code_agent_event` now routes `cli_message` events to
   `_log_claude_cli_message`. At info level it logs the `rate_limit_event`
   fields (status, rateLimitType, utilization, resetsAt, overage
   status/resetsAt/disabledReason, isUsingOverage, surpassedThreshold) as
   `[ClaudeCode] CLI rate-limit status`. It logs the `system.api_retry` fields
   (attempt, max_retries, retry_delay_ms, error_status, error) as
   `[ClaudeCode] CLI API retry`. Values are scalars capped at 200 chars, with
   no session ids or message bodies. The next stall can then be told apart
   from quota/retry backoff straight from the run's logs.

Tests that fail on revert:
- `back-end/src/tests/unit/claude-code-ws-cli-env.test.ts` runs the real
  ws-server.mjs with a fake `claude` on PATH that records its env. It asserts
  `CLAUDE_ENABLE_STREAM_WATCHDOG === '1'`, including when the sandbox env sets
  `0`, and that the idle-timeout override is unset. It is auto-discovered by
  the backend unit runner in `/deploy` coverage.
- The agents blackbox `log_claude_cli_rate_limit_and_api_retry` in
  `agents/tests/blackbox/spawn_claude_code_agent.blackbox.py` asserts both
  log lines carry those fields, truncation applies, and session ids are not
  logged.

Sibling failures this prevents: any Claude Code session, whether a prod user
or a benchmark, whose stream drops mid-turn. Before this change such a session
showed `Claude Code working (Ns)` until the 180s, or 900s once stretched, SDK
idle reap.

10k-agent behavior: one env var per CLI process, with no shared state, channel,
or connection. Logging adds one bounded line per CLI rate-limit status change
(the CLI dedupes) and per retry (at most max_retries per request). The
non-streaming fallback costs one extra request only for a stream that actually
stalled.

Still open: the stall's network-layer cause. Next occurrence: read the new
`CLI rate-limit status` / `CLI API retry` lines. If a stall recurs with neither,
capture the CLI's debug log (`--debug-file`) and request id to locate the drop.

## Human feedback

None recorded.

## Reusable lesson

When a vendored or third-party client streams over the network, check that
its own idle/liveness watchdog is actually enabled where we launch it. Also
make sure its rate-limit and retry telemetry reaches our logs before blaming
quota or the network for a silent hang.
