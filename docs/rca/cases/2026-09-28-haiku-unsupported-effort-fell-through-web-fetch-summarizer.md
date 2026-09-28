---
id: 2026-09-28-haiku-unsupported-effort-fell-through-web-fetch-summarizer
date: 2026-09-28
title: Mini web-fetch summarizer sent unsupported effort to Claude Haiku 4.5
surface: cross
component: rose-claude-auth-body-builders
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/claude_auth.py build_anthropic_body and back-end/src/providers/rose/claudeAuth.ts buildAnthropicBody
symptoms:
  - "This model does not support the effort parameter."
  - "summarize_web_fetch Anthropic HTTP 400 on claude-haiku-4-5"
tags:
  - anthropic
  - haiku
  - effort
  - web-fetch
sources:
  - agent 227eb33c-3458-4598-983e-517fb5fd05db
  - agent b5e068c5-9db8-4572-a4e6-fa00aa8b77d5
repro: agents/tests/blackbox/rose.blackbox.py
status: fixed
---

## Problem

In the `spawn-sub-agents` predeploy smoke, both city research children used
`web_fetch`. The mini summarizer's Claude Haiku 4.5 request returned HTTP 400
with `This model does not support the effort parameter.` Its fallback took up
to 90 seconds for each fetch. The original task was still ACTIVE when its
480-second dynamic cap expired. The original run was
`agents/benchmarks/runs/20260928_180125_browser-biometrics-webdecoy,spawn-sub-agents,parallel-tool-calls,claude-code-agent,browser-smoke,chat-mode.json`
with root agent `227eb33c-3458-4598-983e-517fb5fd05db`.

## Diagnosis

The captured summarizer request selected `rose-1-mini`, which maps to
`claude-haiku-4-5`, yet the Python Anthropic body builder unconditionally set
`output_config.effort`. The backend mirror also unconditionally set effort and
adaptive thinking for the same model. Anthropic documents Haiku 4.5 as lacking
the effort parameter. Archive searches for the exact error and for Haiku
web-fetch fallback found related fallback latency cases but no recurrence of
this unsupported body field. The first bad boundary was model-specific request
construction, before any provider or fallback response. This is a contract
compatibility bug, not a model-intelligence failure.

The Python owning blackbox
`cd agents && venv/bin/python -c "import runpy; runpy.run_path('tests/blackbox/rose.blackbox.py')['test_haiku_body_omits_unsupported_effort']()"`
failed pre-fix at `assert "effort" not in body.get("output_config", {})` and
passed unchanged post-fix. The backend Rose blackbox, run with the local
`victoria` Postgres URLs, failed pre-fix with
`Haiku 4.5 must not receive adaptive thinking` (81 pass, 1 fail) and passed
unchanged post-fix (82 pass, 0 fail). An earlier backend attempt without those
DB variables tripped the production-database guard and was a test setup error,
not evidence of this bug.

## Solution

Both Anthropic body builders now omit unsupported controls for the Haiku 4.5
model family, including dated IDs, while preserving controls for supporting
models. The Python fix is in `agents/providers/rose/claude_auth.py`; the backend
mirror is in `back-end/src/providers/rose/claudeAuth.ts`. The Python Rose
blackbox suite passed 185 tests; the backend Rose blackbox passed 82 tests.
The exact unchanged `spawn-sub-agents` rerun had no further Haiku effort 400s
and several successful mini summarizations. It still failed at 519.3 seconds
because the Tokyo child remained active after its first research result used a
different official population series; that is a separate open problem. The
model capability check is local and adds no per-request I/O at 10k agents.

## Human feedback

The user insisted on iterating until the necessary models can be called
stably. No further direct human feedback on this particular request-body
defect was recorded.

## Reusable lesson

Gate Anthropic request controls by the selected model's documented capability in every body builder before relying on fallback routing.
