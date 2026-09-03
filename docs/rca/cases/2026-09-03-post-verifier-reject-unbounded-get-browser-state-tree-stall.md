---
id: 2026-09-03-post-verifier-reject-unbounded-get-browser-state-tree-stall
date: 2026-09-03
title: Post-verifier-reject get_browser_state was unbounded and TREE STALLed on captcha freeze
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — after durable Verifier rejected message, bare await dom_service.get_browser_state(include_screenshot=False) with no asyncio.wait_for, inside the verifier try/except
symptoms:
  - tree stalled — newest-active root silent for 514s (threshold=510s, status=ACTIVE, messages=65, non_terminal_leaves=1)
  - Browser storage capture timed out after 15s before challenge recovery
  - Verification failed
  - IDLE 300.1s
  - Browser state captured
tags:
  - browser-agent
  - tree-stall
  - captcha
  - challenge-recovery
  - get-browser-state
  - verifier
  - polar
sources:
  - agent 2038f313-9912-43d3-99d7-a659c3c35c0c
  - commit 40c45707bfff4a34b094fd1a18e565ff122d5510
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_post_verifier_rejection_browser_state_fetch_is_bounded
status: open
---

## Problem

`polar-odysseys-440ed7f388a2` (The Pitt / Ponies / Amok Time watchlist) failed with
TREE STALL after a captcha/challenge path. Runtime evidence on agent
`2038f313-9912-43d3-99d7-a659c3c35c0c`:

1. Challenge recovery failed closed correctly:
   `Browser storage capture timed out after 15s before challenge recovery.`
2. Agent continued, later called `attempt_completion`; verifier returned 50% and
   emitted durable `Verifier rejected (50%) — continue task`.
3. Latency shows `⋯ IDLE 300.1s` immediately after that verifier path — equal to
   `BROWSER_STATE_REQUEST_TIMEOUT_SECONDS`.
4. Next durable chip: `Verification failed` / empty Error.
5. Another ~523s of silence → harness TREE STALL pause at ~514s silence
   (threshold 510s) while status stayed ACTIVE and Temporal keepalives continued.

## Diagnosis

Archive searches (storage capture timeout; TREE STALL IDLE get_browser_state;
challenge recovery captcha stall) hit relatives, not this exact boundary:

- `2026-08-03-challenge-recovery-storage-capture-was-unbounded` — storage capture
  is now bounded; this run proves that path failed closed in 15s. Not the stall.
- `2026-07-02-cdp-coupled-heartbeat-dies-in-cloudflare-freeze` — heartbeat was
  decoupled so Temporal survives CDP freezes; that makes silent CDP hangs look
  "alive" to Temporal while TREE STALL correctly kills message silence.

First-bad boundary in `_spawn_browser_agent_activity_v3_real` after the durable
reject message:

```python
current_state = await dom_service.get_browser_state(include_screenshot=False)
```

No `asyncio.wait_for`. Sibling verifier `get_browser_state` calls earlier in the
same block use `BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS`. On a captcha-frozen
renderer, browser-use burns the full 300s BrowserStateRequest timeout with no
new durable messages; keepalive heartbeats keep the activity warm; TREE STALL
fires. Because this await sits inside the verifier `try`, a timeout/error is
mis-labeled `Verification failed` and skips appending the rejection tool result
/ recording the wait action.

Local owning-boundary repro (pre-fix):
`test_post_verifier_rejection_browser_state_fetch_is_bounded` fails with
unbounded await at the post-reject site (~0.96s wall clock).

Classification: relative of the Aug 3 unbounded-await-during-challenge class and
the Jul 2 keepalive-vs-silence class; novel at the post-verifier-reject site.

## Solution

Landed:

1. Added `BROWSER_STATE_SOFT_TIMEOUT_SECONDS=10` and `BROWSER_STATE_SOFT_ATTEMPTS=2`
   (healthy IDLE gaps on the failing run sit near ~12s p95; 10s is the agreed
   soft bound). Main action-loop still uses the challenge-survival 300s budget.
2. Added `_get_browser_state_soft` — `asyncio.wait_for` per attempt, one retry,
   returns `None` on exhaustion.
3. Post-verifier-reject refresh calls the soft helper so CDP hangs cannot become
   `Verification failed` or burn ~300s of silence after a durable reject.
4. Blackbox: structural soft-call guard + retry/hang behavioral tests.

Exact polar `scripts/run-bench --local polar-odysseys-440ed7f388a2` fail→pass
remains required before marking this case fixed.

## Human feedback

None recorded.

## Reusable lesson

After a durable progress message, never put an optional CDP refresh in the same
unbounded try as the critical path — bound it and fail soft so TREE STALL never
sees hundreds of seconds of silence while Temporal keepalives lie.
