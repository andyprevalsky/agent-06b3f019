---
id: 2026-07-14-stale-browser-provider-env-rejected-after-merge
date: 2026-07-14
title: Stale `BROWSER_PROVIDER=browserbase` in .env was rejected by the merged provider allowlist, failing every browser spawn
surface: agents
component: browser-provider
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/browser/types.ts — provider allowlist narrowed to ['steel','kernel'] while .env still said browserbase
symptoms:
  - "Unsupported BROWSER_PROVIDER=browserbase; expected steel or kernel"
  - "agent-payment-test-shop timed out at 905s (was 133s pre-merge)"
  - browser session-init fails instantly, root retries browser 4x
  - "has_write_lock_resume_state:false on every browser attempt"
tags:
  - browser-agent
  - env-var
  - steel
  - kernel
  - timeout
  - merge-drift
sources:
  - memory:project_agentcard_lifecycle_test_infra
repro: none-recorded
status: fixed
---

## Problem

After merging 278 commits from main, the `agent-payment-test-shop` e2e task
timed out at 905s against a 133s pre-merge baseline. Worker logs showed
`spawn_browser_agent_activity_v3` failing instantly at `init_browser_session`
with `Unsupported BROWSER_PROVIDER=browserbase; expected steel or kernel`. The
root agent retried the browser four times (session-init at 20:39, 20:41, 20:47,
20:51 — all with `has_write_lock_resume_state:false`, so it never reached the
payment step) and then hit the 900s cap.

## Diagnosis

`back-end/.env` still carried `BROWSER_PROVIDER="browserbase"` and `agents/.env`
carried `kernel` with no `KERNEL_API_KEY` present. The merge from main migrated
the browser subsystem to accept only `['steel','kernel']`
(`back-end/src/providers/browser/types.ts`, default `kernel`), so both env
values were unusable: one rejected outright, the other missing its API key.
The pre-merge stack had been running on Steel.

Ruled out by evidence, not by assumption: it was not an LLM-fallback failure
(`openai_apikey.done` and `anthropic_apikey.done` both fired), not a bad
`product_url`, and not compute tokens. The first guess — inferred from
whole-log aggregate event counts — was wrong; the answer came from
`agent_latency.py` plus a worker-log grep filtered to the exact `agent_id`.

## Solution

Set `BROWSER_PROVIDER=steel` in both `back-end/.env` and the real `agents/.env`
target (`STEEL_API_KEY` is present, `KERNEL_API_KEY` is not). Note that
`agents/.env` is a **symlink** — the edit must land on
`/Users/andyprevalsky/conductor/repos/navi-whisper-lux-v2/agents/.env`. Follow-up
flagged in the record: verify prod (Render) `BROWSER_PROVIDER` is not also
stale-browserbase. Sibling failures prevented: any enum-narrowing merge that
leaves local envs on a now-invalid value produces the same instant-fail +
retry-to-timeout signature.

## Human feedback

None recorded.

## Reusable lesson

For a slow or timed-out agent, run `agent_latency.py` and grep the worker log
filtered to that exact `agent_id` before theorizing — and after a large merge,
re-validate env values against any allowlist the merge narrowed.
