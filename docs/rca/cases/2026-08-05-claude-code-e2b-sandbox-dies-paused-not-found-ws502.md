---
id: 2026-08-05-claude-code-e2b-sandbox-dies-paused-not-found-ws502
date: 2026-08-05
title: Claude Code sessions failed 100% — ws-server passed the prompt positionally, but the CLI's stream-json mode requires it on stdin
surface: agents
component: spawn-claude-code-agent-e2b
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/claude-code/ws-server.mjs runClaudeCli — passed the goal as a positional `claude --print` arg while `--output-format stream-json` makes the CLI read the prompt from stdin, so claude exited 1 with "Input must be provided"
symptoms:
  - "Error: Input must be provided either through stdin or as a prompt argument when using --print"
  - "[ClaudeCode] DIAGNOSIS: E2B sandbox is DEAD"
  - "Paused sandbox <id> not found"
  - "[ClaudeCodeWs] Connection failed 502, message='Invalid response status', url='wss://3000-<id>.e2b.app'"
  - "ClaudeCodeSession rows CLOSED at ~42s with empty output"
tags:
  - claude-code
  - e2b
  - sandbox
  - websocket
sources:
  - agent 6015d598 (ClaudeCodeSession, user 606fe9fc)
  - agent 0c8a3c71 (ClaudeCodeSession, user 606fe9fc)
repro: local — /tmp/cc-repro (e2b v2.38 + real template + overlaid ws-server); cemented as back-end/src/tests/structural/claude-code-ws-prompt-stdin.test.ts
status: fixed
---

## Problem

The Claude Code agent path failed 100% in prod: every `ClaudeCodeSession` in the
last 7 days (4/4) was `CLOSED` at ~42s with zero output. Two sessions traced in
detail (2026-08-05, user 606fe9fc, the "write and run a Python program" smoke)
died identically. Discovered while checking whether a user's synced Claude token
reached Claude Code agents — it did; the failure was downstream of the credential.

## Diagnosis

Traced from ClickHouse `fly_logs`: token resolved (`✅ Claude Max token fetched …
source=pool`), sandbox created, ws-server ready, then the WS to `wss://3000` 502'd
and `check_sandbox_health` → `connectToSandbox` threw `Paused sandbox <id> not
found`, which the handler mislabels `E2B infrastructure killed the sandbox`.

Reproduced locally with a faithful harness (`/tmp/cc-repro`, e2b v2.38 — same
major as prod — real `E2B_CLAUDE_CODE_TEMPLATE_ID`, the repo's `ws-server.mjs`
overlaid, Andy's real decrypted `sk-ant-oat…` OAuth token). The sandbox stayed
ALIVE; the actual failure was the Claude Code CLI exiting 1 at +4.5s:

```
Error: Input must be provided either through stdin or as a prompt argument when using --print
{"type":"exit","code":1}
```

Bisecting the exact `claude` invocation inside the sandbox (CLI v2.1.138):

| invocation | result |
| --- | --- |
| `claude --print hi` (positional) | reaches auth — arg parsing fine |
| `claude --print --verbose --output-format stream-json … hi` (ws-server) | **"Input must be provided …"** exit 1 |
| `printf 'Task: …' \| claude --print --verbose --output-format stream-json …` | runs (streams `system.init`) |

So under `--output-format stream-json` the CLI **ignores a positional prompt and
requires it on stdin**. `ws-server.mjs:runClaudeCli` did `args.push(prompt)` with
`stdio: ["ignore", …]`, so the CLI got no input → exit 1 on EVERY session. The
"E2B sandbox is DEAD / Paused sandbox not found" is a downstream teardown-race
mislabel after the CLI exits (the sandbox is fine; `check_sandbox_health` fires
after the session is torn down).

Deepest owned cause (Step 5a): the harness invoked an external CLI with a
contract (positional prompt) that the installed CLI version no longer honors,
and no cemented test exercised the real invocation (the claude-code blackbox
deliberately skips the E2B roundtrip), so a CLI upgrade broke 100% of sessions
silently. Codex's ws-server uses `codex exec <positional>` which is correct for
that CLI, so it is not a sibling of this bug.

## Solution

`e2b-templates/claude-code/ws-server.mjs`: deliver the prompt on stdin — drop
`args.push(prompt)`, spawn with `stdio: ["pipe","pipe","pipe"]`, then
`child.stdin.write(prompt); child.stdin.end()`.

Post-fix, the same repro (unchanged, real OAuth token) runs to completion:
`system.init` → `tool_use: Bash` → agent output `[0, 1, 1, 2, 3, 5, 8, 13, 21, …]`
→ `result.success`, `final status: completed, exit_code: 0`.

Regression cemented: `back-end/src/tests/structural/claude-code-ws-prompt-stdin.test.ts`
(registered in `package.json` `test:structural`, run by `/deploy`). It fails if a
future edit reintroduces `args.push(prompt)`, a stdin-`ignore` spawn, or drops the
stdin write. Verified failing on the buggy invocation and passing on the fix.

Deployment note: the fixed `ws-server.mjs` reaches sandboxes via
`overlayClaudeCodeWsServer` at create time (backend uploads the local file over
the template's bundled copy), so it takes effect on the next backend deploy that
ships `e2b-templates/`. For defense-in-depth the E2B template image
(`E2B_CLAUDE_CODE_TEMPLATE_ID`) should also be rebuilt so the bundled fallback is
fixed too.

10k-agent behavior: no change to per-agent resource cost — one stdin write per
session; the fix simply makes each session succeed instead of exiting 1.

## Human feedback

None recorded.

## Reusable lesson

"E2B sandbox is DEAD / Paused sandbox not found" for Claude Code is usually a
teardown-race mislabel — check the in-sandbox `claude` exit first: under
`--output-format stream-json` the CLI reads the prompt from stdin, so passing it
as a positional arg makes every session exit 1 with "Input must be provided".
