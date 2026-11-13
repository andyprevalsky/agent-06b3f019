---
id: 2026-11-13-cerebras-models-probe-unretried-cloudflare-edge-429
date: 2026-11-13
title: Live Cerebras /models probe failed deploy gates on unretried Cloudflare edge 429 pages from shared gate-VM egress
surface: back-end
component: cerebras-blackbox
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/tests/blackbox/cerebras.blackbox.ts live inventory read (moved to cerebras.live.cases.ts fetchLiveCerebrasModelIds) made one GET /v1/models and asserted response.ok without retry or status capture
symptoms:
  - "AssertionError [ERR_ASSERTION]: Cerebras /models must be reachable for the live probe"
  - "Cerebras /models must be reachable for the live probe: HTTP 429 cf-ray="
  - "backend-coverage-blackbox/blackbox:cerebras FLAKY ef18929c"
  - "new-test-stability backend-blackbox:cerebras 2/5"
tags:
  - cerebras
  - deploy-gate
  - cloudflare
  - rate-limit
  - flaky
  - blacksmith
sources:
  - PR #1953
  - PR #1932
  - PR #1884
  - commit e3dd3b912c7f2340203c569580664d1c1483cc96
  - task deploy-gate backend-coverage-blackbox GitHub Actions run 43065516821
  - task deploy-gate new-test-stability GitHub Actions run 43065514343
repro: back-end/src/tests/blackbox/cerebras.blackbox.ts
status: fixed
---

## Problem

`backend-coverage-blackbox/blackbox:cerebras` failed on the PR #1932 deploy gate (Blacksmith run
43065516821, 2026-11-11 17:10–17:26Z, source 47745e800) and failed 1 of 5 runs in new-test-stability
(run 43065514343), both with `AssertionError [ERR_ASSERTION]: Cerebras /models must be reachable for
the live probe`. Reruns passed. It also failed on 2026-11-09 (run 42650103040, PR #1708; repair PR #1884
was opened and never merged) and during the PR #1892 deploy on 11-11. PR #1932 quarantined it as
FLAKY ef18929c.

## Diagnosis

The live inventory read sent a single `GET /v1/models` and asserted only `response.ok`. It did not
retry or record the status, so one non-OK edge response failed the whole domain and left no evidence.
GitHub log downloads returned 502 during the RCA, so the original statuses could not be recovered.
600 concurrent Node fetches from the devbox all returned 200. The first fix (PR #1953, 5 attempts,
1/2/4/8 s, status in the assertion) then caught the real failure on the Blacksmith gate VM in
new-test-stability (round 9, 2026-11-12 19:38Z): `HTTP 429 cf-ray=a597ff6c490b8e3c-LAX <!doctype html>`
on all 5 attempts over about 15 s. Cloudflare's edge in front of api.cerebras.ai was serving its
rate-limit page, which is likely keyed to the gate runners' shared egress IPs, for longer than the
retry budget.

Local repro: the unchanged command `bash scripts/run-blackbox-tests.sh cerebras`, with a NODE_OPTIONS
preload that returns that 429 HTML for the first 20 s of `/v1/models`, fails on 6eaf97520 with the
exact gate signature.

## Solution

`fetchLiveCerebrasModelIds` (`back-end/src/tests/blackbox/cerebras.live.cases.ts`) retries only
408/429/5xx through `retryWithBackoff`: 7 attempts at 1/2/4/8/16/32 s, waiting out `Retry-After`
(capped at 30 s). Any other non-OK status fails at once. The assertion keeps its text and appends
`HTTP <status> after <n> attempt(s) cf-ray retry-after cf-error <body>`. The inventory assertions
are unconditional again, and the ef18929c quarantine marker is removed.

A hermetic case in the same domain pins the behavior:
- Retry-After parsing is correct.
- A 429 carrying `Retry-After: 1` recovers only after the wait.
- A 503 followed by 200 recovers.
- A 401 fails after 1 attempt with the status in the message.

Results on the fix:
- The 20 s window and the `Retry-After: 10` variant both pass.
- A 120 s persistent 429 still fails (`after 7 attempt(s) … cf-error=1015`).
- 5 consecutive live runs pass.
- Gate new-test-stability reports `backend-blackbox:cerebras 5/5` under 8-lane load, and
  backend-coverage-blackbox passes 262/262.

## Human feedback

None recorded.

## Reusable lesson

A live third-party probe in a deploy gate must retry transient statuses (including Cloudflare edge 429 pages) for longer than the edge's limit window, honor Retry-After, and put the status, cf-ray and body in its failure message.
