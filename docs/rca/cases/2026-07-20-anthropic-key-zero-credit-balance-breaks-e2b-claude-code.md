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
  - 'Credit balance is too low'
  - 'Your credit balance is too low to access the Anthropic API'
  - 'OAuth access token has been revoked'
  - 'Timed out after 240s waiting for Claude Code smoke output'
  - '[Claude result] Credit balance is too low'
tags:
  - anthropic
  - billing
  - smoke-benchmark
  - e2b
  - claude-code
  - no-fallback
  - oauth-revoked
sources:
  - commit d1d5a005c
  - memory:project_anthropic_credit_balance_blocks_deploy
  - agent bc-019ff52c-1af4-7932-b397-677856e94aac
  - PR #972
repro: back-end/src/tests/blackbox/claude-code.blackbox.ts
status: open
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

## Recurrence — 2026-08-12 (deploy gate for IndexedDB OOM fix)

**Archive class:** recurrence of this case (same first-bad boundary:
`ANTHROPIC_API_KEY` returns credit-balance-too-low on the fallback-free Claude
Code E2B path). Compounded by a dead OAuth pool.

### Evidence (local, this session)

1. Deploy stage `claude-code-e2b-smoke` failed:
   ```
   FAIL smoke -- Claude Code answers 2+2 (real E2B sandbox) -- Timed out after 240s
   Output: [Claude] Session started in /home/user
   [Claude] Credit balance is too low
   [Claude result] Credit balance is too low
   ```
   Log: `.context/deploy-runs/20260812-090713-20584/logs/claude-code-e2b-smoke-20260812-094803-143112.log`
   Session agent (cleaned after close): `c9bcb750-a8d7-41b8-987f-52f537efa70d`

2. Direct probe of `ANTHROPIC_API_KEY` (same key in `back-end/.env` /
   `agents/.env`):
   ```
   HTTP 400 {"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. ..."}
   ```

3. Prod `claude_code` pool: **1** CONNECTED active row; access token probe →
   `401 OAuth access token has been revoked.` Refresh grant previously
   returned `invalid_grant`. No second usable OAuth envelope exists in prod.

4. Linux/Cloud has no Keychain path; smoke correctly falls through to
   `ANTHROPIC_API_KEY` after OAuth is unusable — then hits this case's boundary.

### Why the earlier mitigation did not hold

- Billing was never restored on the shared Anthropic org (status stayed
  `mitigated`, not `fixed`).
- The Claude E2B blackbox still **hard-fails after 240s** on credit exhaustion
  instead of taking the deploy-approved loud funding SKIP that Codex already
  has (`codex-credit-skip.ts`). It only early-returns on
  `Invalid authentication credentials`, so "Credit balance is too low" burns
  the full timeout and blocks infra deploys (here: IndexedDB upload OOM /
  PR #972) even though credential-health treats Anthropic as warn-only.

### Searches run (Step 0.5)

- `OAuth access token has been revoked`
- `claude-code Credit balance is too low`
- `OAuth access token has been revoked claude-code e2b smoke`
- `indexedDB upload Zone Allocation failed` (separate relative; fixed in
  `2026-08-12-indexeddb-upload-json-codec-ooms-backend`)

### Open actions (not yet implemented — awaiting approval)

1. **Billing / OAuth:** top up the Anthropic org behind `ANTHROPIC_API_KEY`
   and/or mint a fresh Claude Code OAuth envelope into a CONNECTED
   `claude_code` row (prod + local DEV_USER).
2. **Harness (optional, mirrors Codex):** early-detect
   `Credit balance is too low` in
   `testSmoke_claudeCodeAnswersQuestion` and convert to a loud
   `CredentialExhaustionSkip` so funding state does not 240s-timeout-block
   infra deploys; keep bare OAuth-revocation-without-funded-fallback as a
   hard fail.
