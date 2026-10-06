---
id: 2026-09-11-browser-gate-abandonment-omitted-terminal
date: 2026-09-11
title: Browser manager abandoned gate resumes without emitting a task terminal
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SpawnBrowserAgentManagerV3 returned after a rejected or exhausted gate without closing the task whose activity had paused for resume
symptoms:
  - "Cloud evidence finalization failed: TimeoutError"
  - "pause returned 200 but task_complete remained absent"
  - "purchase_cancelled followed by manager return"
tags:
  - cloudbench
  - browser-recording
  - gate
  - payment
  - task-terminal
sources:
  - PR #1299
  - agent be3e9990-ad3f-45dc-8230-70a94f9fe04d
  - task gate-kyc-card-mint (local run 20260911_112040_gate-kyc-card-mint)
  - fleet run 20260911-033741-76727
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_manager_abandoned_payment_resumes_close_exact_browser_task
status: open
---

## Problem

After correcting the deferred-cleanup user identity, the unchanged local KYC
benchmark still failed its durable evidence barrier. The business gate check
passed and root pause returned 200. The browser recording was already finished,
but its task had no task_complete message. Resource cleanup succeeded; the
benchmark remained ERROR. This does not count toward the ten-slice proof.

## Diagnosis

The activity returns awaiting_payment_card_approval and deliberately leaves its
browser chip open for a later activity resume. Its cleanup stops recording but
suppresses task_complete while browser_task_paused_for_resume is true. The
workflow manager then obtains payment approval and raises the KYC gate. Root
pause rejects that gate; the manager emits purchase_cancelled and returns.
There is no later activity invocation to emit the terminal that was deferred.

Captured local timing for root be3e9990-ad3f-45dc-8230-70a94f9fe04d:

- 11:19:20.379882 UTC: Kernel recording message saved.
- 11:19:20.520375 UTC: browser cleanup finished.
- 11:19:36.733 UTC: root pause returned 200.
- 11:19:36.870 UTC: purchase_cancelled persisted after KYC rejection.
- 11:20:36.739 UTC: archive barrier had expired; canonical DELETE began.

The exact-owned DB snapshot records synthetic owner
00000000-0000-4000-8000-000000000103, proving that this recurrence is beyond the
identity fix. The manager has nine analogous return paths: write rejection,
AgentCard setup retry exhaustion or timeout, subscription rejection or continued
block, KYC rejection or continued block, funding timeout, and missing auth
assistance request identity. The generic error event also discarded the known
browser task ID.

Archive searches found the September 6 payment-abandonment cancellation case
and August 22 write-lock status-chip case. Those fixed cancellation event identity
and FE handling respectively. This relative occurs after a completed activity
hands control to a gate: the manager abandons the promised resume. The publisher
and its 60-second recording barrier correctly refuse incomplete evidence.

## Reproduction

The exact canonical local KYC run failed before this producer fix with pause 200:

    /opt/homebrew/bin/bash .context/setup/run-kyc-owned-identity-repro.sh

It invokes scripts/run-bench --local gate-kyc-card-mint with the unchanged task
catalog and owned-batch cleanup contract, a 300-second root backstop, and the same
run-owned context link used for the earlier identity reproduction. Evidence:
.context/acceptance/kyc-owner-exact-local-after-identity.log and
agents/benchmarks/runs/20260911_112040_gate-kyc-card-mint.json.

The owning-boundary reproduction drives the actual workflow manager through the
existing payment gate fixture. KYC/subscription rejection, continued KYC/
subscription blocking, repeated setup, setup timeout and funding timeout all
failed because the manager exhausted without exactly one scoped task_complete.

    PYTHONPATH=agents agents/venv/bin/python -m pytest -q .context/setup/gate_terminal_repro_test.py

Seven cases failed before the fix and the identical command passed all seven
afterward. Logs are gate-terminal-repro-before.log and gate-terminal-repro-after.log
under .context/acceptance. The permanent blackbox test repeats all seven paths
and is registered in the owning browser suite.

## Solution

At each manager return that abandons a pending browser resume, emit a real
terminal event for the task the workflow owns. Preserve the existing typed gate
notification and emit task_complete with ERROR and the result's task ID, falling
back to the preallocated workflow task ID. The normal activity cleanup continues
to leave a pending resume open. Approval waits and successful resume loops do not
emit this abandonment terminal. Generic failures retain their known task ID.
No historical transcripts are edited and no recording or readiness requirement
is relaxed. This is an owner reporting actual task termination.

At 10,000 concurrent agents this adds one constant-size event per abandoned task,
with no inventory scan, poll loop or provider request. All execution, recording,
shutdown and provider limits remain unchanged: normal root 7200 seconds,
validation root 300 seconds, fresh recording barrier 60 seconds.

The exact unchanged local KYC command passes with both fixes in 72.8 seconds:
run 20260911_112644_gate-kyc-card-mint, root
c06f7817-42ff-4239-a3cc-9025212c0976. Its task outcome is PASSED, the owned cleanup
acknowledgement is clean, and the isolated stack is stopped. The canonical
evidence publisher verified all browser terminals and recordings at
https://www.roselabs.ai/?agent-id=c06f7817-42ff-4239-a3cc-9025212c0976 (27 messages).
The macOS wrapper changes only the artifact output directory; it runs every
canonical Hub and FE check without skip flags. Its manifest and last LLM dump
are under .context/acceptance/rca_evidence/c06f7817-42ff-4239-a3cc-9025212c0976/.

The full browser blackbox suite passes on macOS and Linux. The first Linux
review-container attempt lacked the Playwright headless binary; installing the
matching browser and native dependencies made the unchanged full suite pass.
Independent review additionally passed fifteen write/auth/error/cancellation
and pending-resume checks, including existing successful-resume controls.

Eighteen manager scenarios are now permanent: seven payment abandonment paths
plus eleven write/auth/error, exact-ID fallback, pending-resume and cancellation
cases. Both additions are registered in the browser blackbox runner. Independent
provider GET verifies the successful local run's browser terminal; Docker
confirms its exact isolated database container and volume absent.

The cloud KYC retry and fresh frozen ten-by-ten proof remain required; this case
stays open until that outcome evidence is complete.

## Human feedback

Finish without permission prompts. Count only ten sequential slices of ten real
cloud tasks with zero infrastructure failures, exact resource teardown and valid
durable browser evidence. Keep 120-minute normal backstops and temporarily use
five minutes for this validation. Explain deploy benchmark selection and a
global 20-benchmark budget proposal after completing the work.

## Reusable lesson

When an activity defers its terminal for a future resume, the workflow manager
must emit that terminal if it abandons the resume and ends the task.
