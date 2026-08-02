---
id: 2026-07-04-unattended-export-bench-blocks-on-a-human-approval-gate
date: 2026-07-04
title: An unattended export benchmark stalls to timeout because the browser write-lock posts an email_send approval no human will answer
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "user-data-chatgpt-export-request — task has approval_handling: null, so the browser write-lock's email_send approval request has no responder in an unattended run"
symptoms:
  - "browser reaches auth.openai.com/log-in/password then posts approval_type: email_send"
  - agent waits ~140s and then hits the 600s task timeout
  - export DB-proof never satisfied because real exports arrive later by email
tags:
  - benchmarks
  - approval-gate
  - browser-write-lock
  - unattended-run
  - user-data-export
sources:
  - memory:project_user_data_export_bench_blockers
repro: none-recorded
status: open
---

## Problem

`user-data-chatgpt-export-request` cannot complete unattended. The browser reaches
`auth.openai.com/log-in/password` and triggers the write-lock approval gate
(`approval_type: email_send`, for an OTP/verification email). The agent posts the
approval request and waits for a human who does not exist in an unattended run —
stalling ~140s and then hitting the 600s timeout. The export's DB proof also cannot be
satisfied locally regardless, because real exports are delivered asynchronously by
email and nothing ingests them during the run.

## Diagnosis

This is NOT `wait_for` misuse by the agent — it is the browser write-lock system
behaving as designed, colliding with a task contract that never declared how approvals
are handled (`approval_handling: null`). An unattended benchmark that traverses a
write-locked action has no valid outcome: it can only stall. The second, independent
blocker is a task-shape problem: an assertion about asynchronously-emailed artifacts
cannot be proven inside the run window.

## Solution

Not resolved. The recorded direction is that an unattended export bench likely needs
auto-approve for login OTP/email actions, which requires user sign-off under the
no-benchmark-reward-hacking rule and so was not applied unilaterally. Separately
validated in the same session, so it is not the blocker: the browser flow works
end-to-end (the browser-use cache-bypass fix held, no cache-replay death) and the agent
does reach the ChatGPT login and export UI. Also ruled out — earlier ~108s backend deaths
were LOAD-induced (load average 37 from concurrent cross-workspace benchmark stacks),
not a kill-services defect; `kill-services.sh` is already worktree-scoped and `run.sh`'s
global port/pattern kill is cloud-only.

## Human feedback

The human's no-reward-hacking rule governed the outcome: auto-approving the login/email
approval changes the task's contract, so it needs explicit sign-off rather than being
quietly enabled to make the benchmark pass.

## Reusable lesson

An unattended benchmark that crosses a human-approval gate will always stall to timeout
— declare the task's approval handling explicitly rather than reading the stall as agent
misbehavior.
