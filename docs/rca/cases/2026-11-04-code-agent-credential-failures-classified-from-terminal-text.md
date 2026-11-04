---
id: 2026-11-04-code-agent-credential-failures-classified-from-terminal-text
date: 2026-11-04
title: Code-agent credential failures were classified by matching terminal text, aborting healthy sessions and turning a token expiry into a fatal error
surface: cross
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py check_fatal_errors over terminal.get_display() (and back-end/src/domains/claude-code/service.ts detectAndMarkExhaustion over the persisted transcript)
symptoms:
  - "CLAUDE_CODE_FATAL: Claude Code received a 401 from the Anthropic API. The user's credentials need to be refreshed."
  - "[ClaudeCode] Fatal error detected in output, aborting"
  - "Failed to authenticate. API Error: 401"
  - code agent aborted after echoing or grepping "API Error: 401" or "Please run /login"
  - claude_code integration rate-limited 24h and needs reconnect after an agent printed "Not logged in"
tags:
  - code-agent
  - claude-code
  - e2b
  - oauth
  - token-expiry
  - string-matching-classifier
  - multi-day
sources:
  - commit cff49e7725
  - commit 28a7bfc99 (base; parent's live local-stack repro of the echo command)
repro: agents/tests/blackbox/code_sessions.blackbox.py::test_expired_claude_token_pauses_and_the_retry_resumes_on_a_fresh_lease, ::test_auth_strings_in_tool_output_and_prose_never_abort_a_healthy_session; back-end/src/tests/blackbox/code-agent-login-rejection.blackbox.ts (banner-text cases)
status: fixed
---

## Problem

Two failures of one mechanism, on base `28a7bfc99`:

1. A healthy code agent was aborted when its own terminal showed a credential
   banner string. The parent reproduced it live on a local stack: the code agent
   ran `echo 'debug note: our log viewer shows the literal text API Error: 401
   and Please run /login in old entries'`; Bash exited 0, and within 2 s the
   worker logged `[ClaudeCode] Fatal error detected in output, aborting`
   (`error="Claude Code received a 401 from the Anthropic API..."`). The task
   failed `CLAUDE_CODE_FATAL` (non-retryable) and the root planner retried into
   the same failure. Rose code agents work on the Rose repo, whose
   `config.py` contains every one of these strings.
2. A Claude sandbox holds an access token only (no refresh token, since the
   2026-10-26 case). When that token expires during a multi-day run, the
   non-interactive CLI prints `Failed to authenticate. API Error: 401 ...
   authentication_error ... OAuth token has expired`, which matched the same
   patterns: the run died non-retryably and told the parent to "re-sync
   credentials", although a re-spawn re-leases a fresh token.

The backend repeated the mistake on the persisted transcript:
`detectAndMarkExhaustion` regexed the whole output, so an agent printing
`Not logged in` put the user's or pool login on a 24 h cooldown plus
needs-reconnect, and on the funded key a 30 min cooldown for every user.

Local reproduction (real `ws-server.mjs` + scripted CLI):
`cd agents && python /var/tmp/t2/run_sel.py tests/blackbox/code_sessions.blackbox.py <tests>` (the
suite runner is `python scripts/run_blackbox_tests.py code_sessions`) failed on
base with `ApplicationError CLAUDE_CODE_FATAL: Claude Code authentication failed
(401)...` for both the expired-token run and the parent's echo command.
`bash scripts/run-blackbox-tests.sh code-agent-login-rejection` failed on base
with `no cooldown` / `the funded key is not touched` for the banner-text cases.

## Diagnosis

Path: CLI stream-json → ws-server events + display text → activity monitor
(`_run_agentic_loop`) → `check_fatal_errors(terminal.get_display())` →
`ApplicationError(non_retryable=True)`; and terminal snapshot →
`POST /api/claude-code-session/:taskId/output` → `detectAndMarkExhaustion`
regexes.

- Why 1: the display is the union of tool commands, tool output, assistant
  prose and injected turns, so any agent text containing a banner matched.
- Why 2: credential state was inferred from rendered text even though the CLI
  emits a structured signal: the SDK sets `error: "authentication_failed"` on
  the assistant message for every 401/403 (`claude-code-src/src/services/api/errors.ts:1176`,
  `entrypoints/sdk/coreSchemas.ts:1258`), and the ws-server already forwarded it
  as `cli_message`/`assistant.api_error` (added for C15 billing). Usage limits
  and out-of-credits were already structured (`rate_limit_event`,
  `billing_error`) and reported through `report_code_usage_limit`; only the
  rejected login still went through text.
- Why 3 (deepest owned): two classifiers of the same fact existed in parallel
  (structured C15 events and text patterns), and the text one ran first and
  was terminal. Stop: the next rung is the CLI's own message format (third party).

## Solution

Delete, then unify (Step 6a):

- `agents`: `FATAL_ERROR_PATTERNS`, `check_fatal_errors` and the display fatal
  branch are gone. `login_unusable_from_event` reads Claude's structured
  `authentication_failed` the same way it reads Codex's `login_unusable`, so a
  rejected Claude login checkpoints and pauses the session (C15) and the parent
  gets the exact `code_session_id` retry; the respawn re-leases a credential
  and the ws-server resumes the CLI with `--resume`. Credential feedback is
  built from structured events only (`build_credential_feedback`), with the
  ws-server's sha256[:16] fingerprint of the held token.
- `back-end`: `persistOutput` no longer reads the transcript; it accepts the
  structured `credential_feedback` and marks only a rejected login
  (`markRejectedLogin`, classified by `codeLoginRejection.ts`, see the sibling
  case `2026-11-04-sandbox-login-rejection-marked-revoked-without-stored-credential-check`).
  Rate limits and billing stay on the structured C15 report.
- Seven integration lifecycle cases that cemented banner regexes were retired
  (`integrations.registration.ts` counts/hashes updated); their structured
  equivalents live in `code-agent-login-rejection.blackbox.ts`.

Golden reference: Claude Code never aborts on a 401; `withRetry.ts:232-251` +
`utils/auth.ts:1373-1391` reload the stored credential and use it when it
differs from the failed token, otherwise refresh. Codex
`login/src/auth/manager.rs:1850-1862` (UnauthorizedRecovery) reloads then
refreshes. OpenClaw types auth failures (`failover-error.ts:181-193`). Rose
sandboxes cannot refresh, so the equivalent is pause → re-lease → `--resume`.

Open follow-up: proactive re-lease before `expiresAt` is not built. The
reactive path loses only the in-flight request; a proactive one needs the
expiry plumbed into the sandbox and a turn-boundary pause, and in-activity
re-lease would change the C15 contract ("the activity never fails over on its
own").

10k agents: classification now reads one structured event per failure instead
of substring-scanning the whole display every silence window, and the backend
does at most one indexed integration read + decrypt per rejected login. No new
channels, polling or shared rows.

## Human feedback

Andy asked for "fix all via /rca" (delegated cluster T2). The parent supplied
the live repro command and asked for it to be the regression input. No
approach was rejected.

## Reusable lesson

Classify provider credential failures only from the CLI's structured error fields, never from terminal or transcript text the agent itself can print.
