---
id: 2026-11-15-deploy-agents-recover-relied-on-sparse-github-schedule
date: 2026-11-15
title: A failed worker-deployment FIFO head waited hours because deploy-agents.yml recovery ran only on GitHub's best-effort */10 schedule
surface: infra
component: deploy-agents-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: .github/workflows/deploy-agents.yml job `recover` — `if: github.event_name == 'schedule'` made the cron the only trigger that resumes a failed FIFO head, and GitHub fires that schedule only every 4-7h
symptoms:
  - "Resume interrupted worker deployment"
  - "FAILED_ATTEMPT_CADENCE"
  - "cron: \"*/10 * * * *\""
  - "Cooperative Fly deploy + generation cutover"
tags:
  - deploy
  - fly
  - github-actions
  - schedule
  - recovery
  - cutover
sources:
  - PR #2215 (merged 85f05ea3f9527058cd54657e83297a36cf267e1d; production fly lane deploy-agents run 43822304711 PASS)
  - task https://github.com/Rose-Ai-Labs/Rose/actions/workflows/deploy-agents.yml schedule runs 43581876308, 43613997758, 43638808239, 43657839978
  - task https://github.com/Rose-Ai-Labs/Rose/actions/runs/43669103359 (failed head 7aab4aa1)
  - PR #2147 (case 2026-11-15-fly-cutover-connect-failed-write-and-orphaned-lease-recovery-409)
repro: scripts/tests/deploy-agents-recover.test.sh
status: fixed
---

## Problem

When a push run's "Cooperative Fly deploy + generation cutover" fails, its durable job stays at the FIFO head with a recorded failure. Agent deploys then stall until some other controller resumes that head.
`GET /repos/Rose-Ai-Labs/Rose/actions/workflows/deploy-agents.yml/runs?event=schedule` shows 131 schedule runs in total. Recent ones were created at 2026-11-14 02:51Z, 09:43Z, 16:08Z and 20:41Z, then 2026-11-15 00:22Z, with none from 00:22Z to 06:00Z. Earlier gaps reach 23h (2026-11-07 15:13Z to 2026-11-08 16:05Z). The cron says `*/10 * * * *`, but GitHub runs a few per day.

## Diagnosis

- **Only one automatic trigger.** The `recover` job was gated `if: github.event_name == 'schedule'`, and the `deploy` job runs only for push and `workflow_dispatch`. A failed deploy therefore had exactly one automatic path back: the next schedule tick, or an unrelated later agents push.
- **The trigger was best-effort.** GitHub documents scheduled workflows as delayable or droppable under load, and the measured cadence is 4-7h. The queue's own 600s failed-attempt cadence (`worker-deployment-queue.ts run --if-idle`, `FAILED_ATTEMPT_CADENCE`) was never the limit.
- **Why possible:** the design treated the cron as a timely watchdog, but no test asserted that a failure starts recovery. `workflow-deployment-migration.test.sh` checked only the deploy path.
- Repro: `bash scripts/tests/deploy-agents-recover.test.sh` was run on an origin/main tree (c3efd5060f) with the new script copied in. It exits 1 with `AssertionError: recovery must follow the deploy job it recovers`. Without the script, it fails with `missing failure-triggered recovery entry point`. After the fix it exits 0.

Options evaluated:
- `workflow_run` on failure: needs a second workflow file, and a failing recovery cannot re-trigger itself. Rejected.
- A non-cron watchdog (backend cron dispatching the workflow): a new credentialed moving part outside the workflow. Rejected.
- Chosen: a bounded retry inside the same run, in a job that `needs: deploy`.

## Solution

- The `recover` job now `needs: deploy` and runs on `always() && (github.event_name == 'schedule' || needs.deploy.result == 'failure')`. The schedule stays as a fallback.
- Both triggers run `scripts/deploy-agents-recover.sh`. The script reads the FIFO head and runs it only through `worker-deployment-queue.ts run --job-id <head> --if-idle`, so the Postgres global lease, FIFO order and 600s cadence still decide admission, and it never overlaps a running cutover.
- On `FAILED_ATTEMPT_CADENCE` the script sleeps until `retryAt`; a `retryAt` more than 600s away is refused. On `GLOBAL_LEASE_BUSY` it polls every 30s for up to 1800s. The global lease is also held briefly by non-FIFO holders, such as the backend worker-process recovery cron, that never run the head; the independent verifier caught this. A failed cutover counts as an attempt. The script stops after `RECOVER_ATTEMPTS` (default 3) failed cutovers and exits 1 loudly. Job timeout: 330 min.
- Regression: `scripts/tests/deploy-agents-recover.test.sh` (structural gate `deploy-agents-recover`). It asserts the job's trigger, and runs the real script against a fake queue CLI. Scenarios: cadence wait then resume, bounded failure, a briefly busy lease then resume, a lease busy past its budget, empty queue, and a `retryAt` beyond 600s. Every cutover call must be `run --job-id <head> --if-idle`.
- 10k-agent behavior: deploy-time only. At most one extra Blacksmith job per failed deploy, at most 3 cutovers plus 2 cadence waits. No agent hot-path work.

## Human feedback

None recorded.

## Reusable lesson

Never make a GitHub `schedule` the only path that resumes a failed deployment. It is best-effort and fires hours apart. Start recovery from the failure itself, through the same lease and cadence gate.
