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
  - agent eb589de0-4ad0-4d75-a986-c0543bf70f99
  - agent 7112ff50-b56b-4fef-812f-7b1b3263325d
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

The same failure recurred in the next `spawn-sub-agents` predeploy smoke,
`agents/benchmarks/runs/20260929_005253_browser-biometrics-webdecoy,spawn-sub-agents,parallel-tool-calls,claude-code-agent,browser-smoke,chat-mode.json`.
The root `eb589de0-4ad0-4d75-a986-c0543bf70f99` hit the 480-second dynamic
cap with its Tokyo child `7112ff50-b56b-4fef-812f-7b1b3263325d` still
active. The Tokyo worker log records eight `summarize_web_fetch` Anthropic 400s
with the same exact error. Two late fallback summarizations took about 90
seconds each. The run had 15 LLM calls, cost 1.0 cents, and 35.6% cache hit.

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

This is a recurrence because commit `129c9c084` removed both model-capability
guards, both owning blackbox regressions, and this case file while narrowing a
Foundry PR. The direct causal path was
`Tokyo web_fetch -> rose-1-mini -> Python Anthropic body builder -> unsupported
output_config.effort -> provider HTTP 400 -> slower fallback -> unfinished
explore child at the benchmark cap`. The backend body builder was a mirrored
contract defect on the chat path. Archive searches used the exact error string,
`spawn-sub-agents two children active timeout 480s`, `set_plan planner context
child explore population timeout`, and `explore depth deep over research answer
found no completion timeout`; the prior case had been deleted in the intervening
commit, so the repository search did not surface it until git history was
inspected.

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

For the recurrence, the same narrow guards and permanent blackbox tests were
restored. The Python test command above failed on the current pre-fix checkout
at `assert "effort" not in body.get("output_config", {})` (exit 1), then
passed unchanged after restoration (exit 0). The backend Rose blackbox with
both local `DATABASE_URL` and `DIRECT_URL` failed pre-fix with `Haiku 4.5 must
not receive adaptive thinking` (82 pass, 1 fail), then passed unchanged
post-fix (83 pass, 0 fail). The full Python Rose runner passed 186 tests;
backend `tsc --noEmit` and Python Ruff passed. The exact unchanged benchmark
passed on a fresh worker: `ROSE_USE_SYSTEM_PG=true scripts/run-bench --local
spawn-sub-agents` returned 1/1 passed in 305 seconds, 4.0 cents, with
78.2% cache hit. Its run JSON is
`agents/benchmarks/runs/20260929_011531_spawn-sub-agents.json`, root agent
`e282b3cb-c9b2-4469-8f03-7577676714e9`, and durable FE link is
`https://www.roselabs.ai/?agent-id=e282b3cb-c9b2-4469-8f03-7577676714e9`.
The new worker logs contained zero unsupported-effort 400s; a live Haiku 4.5
`summarize_web_fetch` completed successfully in 7,113 ms.

The Tokyo explore child also continued researching after it found an official
August 1, 2026 Tokyo estimate of 14,303,513 and established that a September
estimate was not yet available. Its own `execute_loop` request had expanded its
goal to include an October release despite the September 29 cutoff and selected
deep search. That is distinct from the deterministic provider-body defect and
did not prevent this verified run from passing. A canceled child's partial
research is not a valid substitute for its terminal result.

## Human feedback

The user insisted on iterating until the necessary models can be called
stably. No further direct human feedback on this particular request-body
defect was recorded.

## Reusable lesson

Gate Anthropic request controls by the selected model's documented capability in every body builder before relying on fallback routing.
