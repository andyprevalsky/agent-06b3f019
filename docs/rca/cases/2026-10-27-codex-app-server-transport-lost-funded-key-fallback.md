---
id: 2026-10-27-codex-app-server-transport-lost-funded-key-fallback
date: 2026-10-27
title: Codex app-server transport had no ChatGPT OAuth → funded OPENAI_API_KEY runtime fallback
surface: harness
component: codex-code-ws-server
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/codex-code/ws-server.mjs runCodexAppServer ended the run on a failed turn; only the legacy exec path retried with OPENAI_API_KEY
symptoms:
  - "You’ve hit your usage limit"
  - usageLimitExceeded
  - "Expected status 200, got 400: {\"error\":\"output field required\"}"
  - Codex E2B smoke fails in /deploy backend coverage
tags:
  - codex
  - e2b
  - oauth
  - fallback
  - deploy-gate
sources:
  - task User Scale Bug Bash lane S20 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
repro: e2b-templates/codex-code/app-server.test.mjs
status: fixed
---

## Problem

From about 04:40Z on 2026-10-27, every `/deploy` backend coverage run failed the
Codex E2B smoke with `output field required`. The synced dev user's ChatGPT
account had hit its usage limit (`usageLimitExceeded`, until Nov 2). The session
injected the funded `OPENAI_API_KEY` alongside the OAuth credential. The default
app-server transport ended the run on the failed turn and never tried the key.
The legacy exec transport retries once with the key; the app-server port dropped
that contract. Production users whose ChatGPT plan runs out get a dead Codex run
for the same reason.

The smoke then failed for an unrelated reason. App-server reports a failed turn
only as events, so the transcript was empty. The test's `POST /output` returned
400 before the credit-skip and fallback checks could run.

## Diagnosis

1. Captured real-sandbox events: `turn/started` → `error` "You’ve hit your
   usage limit" → `turn_ended failed`, with no `auth_fallback` event.
   `GPT_API_KEY` was configured and not on cooldown in the test DB.
2. `runCodexAppServer` had no fallback branch, unlike the exec path (the
   `code !== 0 && !usingApiKey && OPENAI_API_KEY && oauthFallbackReason` retry).
3. Local repro: the new real-process `app-server.test.mjs` case drives a fake
   `codex` that fails OAuth turns with the exact usage-limit payload and
   succeeds after `codex login --with-api-key`. Before the fix it failed: the
   run ended with `turn_ended=failed` and no fallback. It passes after the fix,
   and the full suite passed 22/22 on 5 consecutive runs.

## Solution

- `CodexAppServer` records each turn's `turn/start` arguments, including a turn
  that fails in the same chunk as its response.
- A `recoverFailedTurn` hook can take over a failed turn: the error event is
  still emitted, but that turn's `turn_ended`/`final` are not.
- `runCodexAppServer`, when the failure classifies as an OAuth fallback reason
  and a funded key exists, does the following once:
  1. emits `auth_fallback`;
  2. stops the OAuth app-server;
  3. removes `auth.json` and logs in with the key;
  4. starts a new app-server, resumes the same thread and re-sends the same turn
     input. No new model-visible text is added.
- The smoke persists output only when there is some, so an empty transcript
  reaches its classification.

Real sandbox after the fix: OAuth usage limit → `auth_fallback` → funded-key
turn → "Quota exceeded". The funded key is also out of credits, so the smoke
records the deploy-approved SKIP with both paths genuinely exhausted.

10k-agent behaviour: at most one extra app-server process and one login per
session, only when OAuth fails. There is no shared state.

## Human feedback

None recorded.

## Reusable lesson

When a transport is replaced, port its recovery contracts with it, and keep a real-process regression for each runtime fallback.

## October28 local native fixture recurrence — cause OPEN

Batch12's fake-Codex fallback case failed after8153ms with no received events and no server Client-connected log. Its fake OAuth error and fake key login did occur. The connection loop discards its errors, then the later completion assertion reports an empty event list; original socket errors and the deleted fake journal are unavailable. Do not infer a funded-key/provider failure or change credentials, retry counts or deadlines.

One unchanged isolated native case passes483ms with private pre-cleanup capture: five ECONNREFUSED attempts precede OPEN, then the OAuth error, same-thread/same-input key retry and successful terminal event. All6 observed processes and the exact listener/temp directory are absent afterwards. This does not reproduce or repair the original socket failure. A private opt-in observer retains the connection boundary on the next original owning run without changing its waits/assertions. Exact report: plan:.context/deploy-fresh-20261027/rca-codex-direct-chat/REPORT.md.
