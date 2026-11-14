---
id: 2026-10-03-agentcard-setup-fixture-502-swallowed-stalled-setup-resume
date: 2026-10-03
title: A one-off AgentCard 502 on the setup fixture was swallowed after the attention was marked handled, stalling agent-payment-setup-resume to its cap
surface: agents
component: benchmark-runner
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py attention poll loop added the setup attention to seen_attention_ids, then the outer except printed "Approval check error" when configure_benchmark_agentcard_setup raised, so the setup was never retried or reported
symptoms:
  - "⚠ Approval check error: Failed to complete benchmark AgentCard setup: 502"
  - "AgentCard Organization MCP list_cardholders failed: Invalid or expired organization token"
  - "tree stalled — newest-active root 1721c141-c0a silent for 515s"
  - "agent-payment-setup-resume: FAIL"
tags:
  - agentcard
  - benchmark-runner
  - attention
  - stall
  - third-party-flake
sources:
  - PR #1401
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The deploy Step 6a AgentCard lane failed `agent-payment-setup-resume` with `tree stalled — newest-active root 1721c141-c0a silent for 515s` after 647s (`/tmp/g6a.log`, run dir `.context/benchmarks/1790985993-983375-97583`). The same task passed in the Step 6 smoke 25 minutes earlier on the same HEAD.

## Diagnosis

The agent reached One Time Agent Payment Setup and opened the `agentcard_user_cardholder_onboarding_required` attention. The runner POSTed `/api/test-payment/lifecycle/agentcard-setup` (`complete`) at 00:08:14Z. In the backend, `list_cardholders` returned `Invalid or expired organization token` after 2368 ms (00:08:16.669Z). In the same second, `get_onboarding_session` was being throttled with `API key rate limit exceeded`. The same secret served `get_onboarding_session` again at 00:08:31Z and on every later poll, so the provider rejection was transient. The route answered 502.

The poll loop had already added the attention id to `seen_attention_ids` and counted it before calling the fixture. The `RuntimeError` reached the loop's catch-all `except Exception`, which printed `⚠ Approval check error` and kept polling. Nothing ever completed the setup, and the agent waited on it until the stall detector fired. The fixture is idempotent (it resolves the cardholder and upserts the integration), so a retry was always safe. No surface reported the real cause: the verdict read as a stall.

Local repro: `test_agentcard_setup_retries_transient_upstream_failure` feeds the fixture one 502 followed by a 200. On the old runner it raises `Failed to complete benchmark AgentCard setup: 502 ...` on the first response. `test_agentcard_setup_attention_failure_fails_the_task_with_its_cause` asserts that the setup handler returns a task failure carrying the error, and it fails on the old loop. Archive searches for the symptom strings found the 2026-07-25 retired-credentials case (a permanent auth failure, not a flake) and no case about a swallowed attention-handler error.

## Solution

- `configure_benchmark_agentcard_setup` now retries a 5xx up to three times, after 2 s, 4 s, and 8 s, and logs each retry. A 4xx (for example 409 cardholder not ready) still raises immediately.
- If the setup fixture still fails, the poll loop returns `AgentCard setup fixture failed: <cause>` for the task, instead of leaving the agent to idle until the cap.
- Both new tests are registered in the `benchmark` agents blackbox domain, which runs in deploy coverage. They fail on the old runner and pass on the new one.
- This is runner-only. Product card issuance keeps its own org-runtime retry policy. Cost at 10,000 agents is unchanged: at most three extra fixture POSTs per affected benchmark task.

## Human feedback

None recorded.

## Reusable lesson

A poll loop that marks an event handled before acting on it must turn a failed action into a retry or a loud task failure, never a printed warning.


## 2026-11-09 v2 setup event compatibility

The unchanged `agent-payment-setup-resume` task failed in
`agentcard-v2-e2e-20261109-cohort-02-worlds`: its ordered gate expected
`agentcard_user_cardholder_onboarding_required` but received
`agentcard_user_connection_required`. The new REST routing adapter had put its
provider connection phase into the established product setup category. Preserve
the category and expose the v2 phase separately through `setupStatus`; continue
using the signed v2 connection URL. The default routing regression and unchanged
attention producer/ordered gate reproduce the old error and pass the candidate.
The original native failure remains recorded; browser rerun is required before
claiming the full setup/resume flow fixed.
