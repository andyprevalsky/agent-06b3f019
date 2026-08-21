---
id: 2026-08-21-blank-spa-shell-unbounded-wait-burns-budget
date: 2026-08-21
title: Admin-bypass gate omitted from bundled-frontend set so Vite DEV over ngrok blanked #root
surface: agents
component: benchmarks-local-frontend-tunnel
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: benchmarks/local.py TEST_PAYMENT_FRONTEND_TASK_NAMES — gate-subscription-card-mint-admin-bypass opens a public Kernel tunnel to /test_payment but was not in the set that sets BENCHMARK_BUNDLED_FRONTEND=true
symptoms:
  - "Navigation produced blank SPA shell; reloading once"
  - "Page still lacked usable content after reload"
  - "blankSpaShell\": true"
  - "VITE v5.4.21  ready"
  - "gate-subscription-card-mint-admin-bypass"
tags:
  - blank-spa
  - vite
  - test-payment
  - navigation-ready
  - gate-subscription
  - bundled-frontend
sources:
  - agent b7b53dfb-20b4-4b8e-b019-432a315cee83
  - PR #1021
  - fleet run descend-20260820T202555Z-gate-sub
repro: agents/tests/blackbox/benchmark.blackbox.py::test_purchase_gate_benchmarks_enable_bundled_frontend_before_stack_start
status: fixed
---

## Problem

On gate-subscription-card-mint-admin-bypass pass@5, agent
`b7b53dfb-…` took **293s to request a payment card** vs a **~81s median** for
the four passing siblings (~**213s wasted** before checkout). The waste window
is filled with `blankSpaShell` / `rootChildren: 0` evaluates and model `wait`
loops, not mint/pay thrash. All five agents hit blank SPA; four recovered in
~30–50s; the fail agent stayed blank through 18:26:40Z.

## Diagnosis

Archive searches: `blank SPA shell lacked usable content`, `blankSpaShell Page
still lacked usable content after reload`, `BENCHMARK_BUNDLED_FRONTEND
needs_frontend_tunnel vite module graph`, `admin-bypass bundled frontend blank
SPA`. Novel relative of the known “serve a bundle through the public tunnel”
contract — not a prior closed case for this task-name omission.

Critical path:

1. `scripts/run-bench` → `benchmarks/local.py:configure_task_environment`
2. sets `BENCHMARK_BUNDLED_FRONTEND` only when `needs_frontend_tunnel(tasks)`
3. `needs_frontend_tunnel` = task ∈ `TEST_PAYMENT_FRONTEND_TASK_NAMES`
4. `run.sh --benchmark` serves Vite DEV unless that env is `true`
5. Kernel browsers load `{frontend_url}/test_payment` over ngrok

Evidence:

- Fail stack frontend log: `VITE v5.4.21 ready` (DEV server, not `vite preview`).
- Local owning-boundary: before fix,
  `needs_frontend_tunnel(["gate-subscription-card-mint-admin-bypass"])` was
  **False** and `configure_task_environment` left `BENCHMARK_BUNDLED_FRONTEND`
  unset; sibling `gate-subscription-card-mint` correctly set it to `true`.
- Worker log: all five agents `blankSpaShell` with `readyState: interactive`,
  title `Rose`, `rootChildren: 0` (HTML shell arrived; React never mounted in
  the 3s readiness window). Fail agent still blank at +~3min.
- Local measurement: Vite DEV `/test_payment` issues ~**786** requests / ~**247**
  script modules per browser; bundled preview issues ~**33** / **4** scripts and
  mounts in ~1.2s locally. Chromium ignores `as="video"` preloads (0 video
  requests) — video preload is not the blank cause.
- Network capture for the fail agent lacked early Document/Script rows (late
  Amplitude only) — a secondary capture gap, not the cause.

Root cause at the first-bad boundary: **admin-bypass was missing from
`TEST_PAYMENT_FRONTEND_TASK_NAMES`**, so the pass@5 stack opened a public
tunnel against Vite’s unbundled module graph. Five concurrent Kernel sessions
could not mount `#root` inside the harness readiness window; the model then
wait-looped on an empty shell until the 360s cap.

## Solution

Add `gate-subscription-card-mint-admin-bypass` to
`TEST_PAYMENT_FRONTEND_TASK_NAMES` so `configure_task_environment` sets
`BENCHMARK_BUNDLED_FRONTEND=true` (same contract as the other /test_payment
gates). Cement in
`test_purchase_gate_benchmarks_enable_bundled_frontend_before_stack_start`.
Also keep blank-SPA mount diagnostics in `wait_for_navigation_ready` for future
capture. Do not raise the 360s task timeout.

## Human feedback

User asked how much time was wasted and insisted on uncovering the blank-page
cause (add logging; do not stop until a correct /rca). Distinct from the
post-pay PAUSE race RCA.

## Reusable lesson

Every task that opens a public tunnel to `/test_payment` must be in
`TEST_PAYMENT_FRONTEND_TASK_NAMES` so the stack serves a bundled frontend —
never Vite DEV — to Kernel browsers.
