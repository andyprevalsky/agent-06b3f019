---
id: 2026-07-20-anthropic-key-zero-credit-balance-breaks-e2b-claude-code
date: 2026-07-20
title: Anthropic key with $0 credit balance broke the fallback-free E2B Claude Code path
surface: infra
component: claude-code-e2b
classification: third-party-failure
problem_class: other
first_bad_boundary: ANTHROPIC_API_KEY account returned Anthropic 400 "Credit balance is too low"
symptoms:
  - '"Credit balance is too low" in worker/backend logs'
  - claude-code-agent smoke times out at 334s after 6 claude_code re-spawns
  - browser-biometrics-webdecoy hits COST_LIMIT_REACHED at 124c of 120c
  - integration-health credential gate reports Anthropic healthy anyway
tags:
  - anthropic
  - billing
  - smoke-benchmark
  - e2b
  - claude-code
  - no-fallback
sources:
  - commit d1d5a005c
  - memory:project_anthropic_credit_balance_blocks_deploy
repro: none-recorded
status: mitigated
---

## Problem

A `/deploy` smoke run went 4/6 on 2026-07-20. Both failures traced to one cause:
the Rose Anthropic account behind `ANTHROPIC_API_KEY` (present in both
`agents/.env` and `back-end/.env`) returned Anthropic 400 **"Credit balance is
too low"**. `claude-code-agent`, normally ~60–110s, looped to a 334s timeout;
`browser-biometrics-webdecoy` hit `COST_LIMIT_REACHED` at 124 credits against a
120-credit cap.

## Diagnosis

The E2B Claude Code CLI is hardwired to Anthropic via `ANTHROPIC_API_KEY` with
**no waterfall fallback**, so it returned
`{"provider":"claude","text":"Credit balance is too low"}`, the verifier scored
0.0, and the root agent re-spawned `claude_code` 6 times until the task timed
out. The browser task degraded differently: claude 400'd every
`browser_use_step`, forcing the OpenRouter waterfall onto Gemini, which is worse
at biometrics and burned the cost cap before observing the isolated-session
metadata. The 4 passing tasks survived precisely because their claude calls do
fall back. A second, compounding defect: the Step 4c credential-health gate
(`back-end/src/tests/blackbox/integration-health.blackbox.ts`) validates **auth
only**, so a valid key with a $0 balance passes the gate while failing every real
call.

## Solution

The fix is a billing action, not code: top up that Anthropic org or rotate
`ANTHROPIC_API_KEY` to a funded key in `agents/.env`, `back-end/.env`, Fly
(`navi-whisper-lux`) and Render. Commit d1d5a005c makes the Claude Code path
fast-abort on the real "Credit balance is too low" wording instead of burning a
timeout in re-spawns. The recorded follow-up for the gate is a tiny billable
probe (1-token completion) that distinguishes 401 (auth) from a credit/balance 400. The same root cause also destabilizes the prod `chat-lifecycle-ratchet`
gate at Step 13b, which fails a different random path each run (first-response
spikes of 6–15s) because of the claude-400 → slow-waterfall fallback.

## Human feedback

Treated explicitly as a billing escalation, not a code bug: no fallback was to
be added to the Claude Code path, no timeout bumped, and no benchmark weakened.
Re-dispatching the prod Step 13b gate blindly was also rejected — each run spawns
real prod agents and costs money, so the instruction was to surface it to the
user instead.

## Reusable lesson

When claude-code-agent times out with repeated re-spawns or a browser task hits
COST_LIMIT, grep the run logs for "Credit balance is too low" before blaming
code — and never treat an auth-only credential gate as proof a provider key can
actually bill.
