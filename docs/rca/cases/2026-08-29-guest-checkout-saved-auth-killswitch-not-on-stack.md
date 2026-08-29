---
id: 2026-08-29-guest-checkout-saved-auth-killswitch-not-on-stack
date: 2026-08-29
title: Guest-checkout Blue Bottle still injected cookie_bundle because BENCHMARK_DISABLE_SAVED_BROWSER_AUTH never reached the backend stack
surface: harness
component: local.py / cloudbench-run.sh / benchmarkBrowserAuth.ts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/local.py start_services — only set BENCHMARK_DISABLE_SAVED_BROWSER_AUTH when --anon; guest-checkout tasks set it in run_benchmark harness os.environ only
symptoms:
  - guest checkout is not directly demonstrated
  - auth_source": "cookie_bundle"
  - cookies_injected": true
  - benchmark_disable_saved_browser_auth": false
  - Guest-checkout task: disabled saved browser auth material
tags:
  - blue-bottle
  - guest-checkout
  - browser-auth
  - benchmark
  - cookie-bundle
sources:
  - fleet run 8ff68fad-785a-4654-bb8f-9fa36bf87ff6
  - agent 054ad971-067b-451d-bb2c-011c88d307cc
  - agent f989235e-b72b-4615-9e02-0791dec649af
  - PR #1069
repro: agents/benchmarks/spawn_contract_guest_auth_test.py
status: mitigated
---

## Problem

Blue Bottle k=5 (`scripts/run-bench --local` ×5, Hub run `8ff68fad`) finished **0/5**.
Three trials reached payment with correct item/total/pickup grounding, then the
semantic judge failed solely on guest checkout. Every trial's `session_init`
showed `auth_source=cookie_bundle` and `cookies_injected=true` even though the
harness printed `Guest-checkout task: disabled saved browser auth material`.
The isolated stack manifest recorded `benchmark_disable_saved_browser_auth: false`.

## Diagnosis

1. `should_disable_saved_browser_auth(blue-bottle)` is True (guest checkout, no live fixture).
2. `run_benchmark.run_single_task` sets `BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true` in the
   **harness process only**.
3. Cookie selection runs in the **backend** via `benchmarkSavedBrowserAuthDisabled()` reading
   `process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH`.
4. `local.py start_services` only exported that env when `--anon` / `anon_steel_profile` —
   Blue Bottle does not use `--anon`.
5. Result: all five sessions injected the synced cookie bundle → no guest-checkout UI path →
   judge correctly fails.

Sibling failures in the same k=5 (max-steps without payment; write_lock instead of
payment_approval; single-turn judge `No JSON content received`) are separate classes and
remain open.

## Solution

- `tasks_require_disabled_saved_browser_auth(task_names)` in `spawn_contract.py`.
- `local.py start_services` exports `BENCHMARK_DISABLE_SAVED_BROWSER_AUTH` when any selected
  task needs it (or `--anon`).
- `--use-existing` fails closed if guest-checkout tasks are selected but the live stack
  lacks the flag.
- `cloudbench-run.sh` exports the same flag into `STACK_ENV` when guest-checkout tasks are
  in the batch.
- Cemented by `agents/benchmarks/spawn_contract_guest_auth_test.py`.

10k-agent behavior: one boolean env on the stack; no per-agent fan-in.

## Human feedback

User required a k=5 pass alongside tree-aware semantic evidence, and asked for `/rca` of
the failing runs before increasing rollout. Guest-checkout payment language in spawn goals
remains allowed (write-lock catches before purchase).

## Reusable lesson

A harness-only `os.environ` kill-switch is not a kill-switch — export it into the backend/worker
stack env (or an equivalent per-request flag the injector reads) before the first browser session.
