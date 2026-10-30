---
id: 2026-10-28-failed-browser-hydration-retained-live-custody
date: 2026-10-28
title: Completed browser hydration failure kept resume custody locked for the native lease
surface: back-end
component: browser-resume-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/resumeLifecycle.ts retained STARTED custody after a caught checkpoint hydration failure despite a known native candidate
symptoms:
  - 'Timeout after 903s (task timeout=900s)'
  - 'page.goto: Timeout 30000ms exceeded'
  - 'Browser resume is still in progress'
  - agent-payment-setup-resume remained ACTIVE after card issuance
tags:
  - browser
  - resume
  - custody
  - hydration
  - agentcard
sources:
  - PR #1627
  - agent 1ffdb87d-5074-49fb-8267-56826e799531
  - commit 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
repro: back-end/src/tests/blackbox/browser-session-hydration-failure.cases.ts
status: open
---

## Problem

`agent-payment-setup-resume` reached its 900-second deadline while ACTIVE.
Setup completed at 17:59:52.162Z, and the card was ready at 17:59:58.702Z.
Kernel created the replacement browser in 1641ms (18:00:00.677–18:00:02.318Z).
Checkpoint restoration then threw a 30-second navigation timeout at
18:00:36.467Z. Two later browser attempts spent 170.8s and 170.9s waiting on
resume custody. The root's final wait began at t677.44 and crossed the deadline.
All 23 captured native LLM attempts completed successfully (98.292s total,
overlapping their parent activity spans). Payment account exhaustion and host
memory contention are not established causes of this incident.

Evidence is retained in the integration worktree's
`agents/benchmarks/runs/20261028_184816_8ff8bf29-94aa-47a5-860a-4b22375cb93c_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json`
and `.context/benchmarks/1793210144-1947645-89896/logs/backend.log`.
The independently generated waterfall and phase table are under
`/var/tmp/deploy-1627/rca/agentcard-setup-resume-{waterfall.txt,evidence.md}`.
The waterfall's full 3071s envelope includes later cleanup; it is not the task duration.

## Diagnosis

Critical path: checkout -> payment setup -> issued card -> browser resume ->
Kernel creation -> logical checkpoint hydration -> thrown page.goto -> durable
resume custody -> later browser attempts -> root wait -> task deadline.

Step 5: What: completed failed hydration left the logical browser unusable.
Where: `withBrowserResumeLifecycle`'s error path released rejected allocations
but never settled a failed hydration. Why: a caught in-process error was treated
as an unknown/crashed owner, so every later attempt waited on the existing
STARTED lease. Proof: the retained timestamps and real-database local regression
below. Problem: logical inconsistency in lifecycle completion contracts.

The archive was searched for literal timeout/setup-resume, payment/setup stall,
and hydration-outcome terms. The 2026-10-23 rejected-provider-create case is a
relative, not the same failure: this native creation succeeded and hydration
failed later. No provider billing or navigation-network cause is claimed.

The original standalone repro was executed unchanged on the buggy code:
`bash /var/tmp/deploy-1627/rca/agentcard-setup-resume/run-repro.sh`.
It printed `resume #2 FAIL after 30.1s: Browser resume is still in progress`.
The identical command after the fix printed `resume #2 PASS in 0.0s` and
`custody=RELEASED/ready`, with a new ACTIVE native and exactly one released failed candidate.

The permanent regression was also run before the fix and failed with
`completed failed hydration must not retain in-flight custody`, actual STARTED,
expected RELEASED. The unchanged regression passes all six cases after the fix.
It uses real User, BrowserContext, BrowserSession and ToolSideEffect rows and
replays the captured error at the lifecycle owner boundary. The separate real
Chromium fixture exercises the actual checkpoint restore and subsequent state
continuity, including the late page.goto failure.

## Solution

Reuse the existing raw native-release helper for the failed candidate; do not
harvest partial credentials or retire the logical browser. Check the current
owner, binding and user-control state before cleanup. Only after the provider
confirms the exact candidate ended, atomically keep the logical row PAUSED and
release custody. Preserve the original error. Unknown release results, live
natives, changed bindings, user control and lost ownership retain their fence.
Crash/expired-unknown hydration behavior is unchanged.

Deleting custody is unsafe because it prevents duplicate paid native allocation.
The repair therefore unifies native cleanup through the existing helper and
guards one settled transition rather than adding retries or timeout policy.
At 10,000 agents, work remains keyed to one task and one native candidate; the
extra provider check and database transaction run only on failed hydration.
There is no new polling, fan-in or shared state.

Coverage: `runBrowserHydrationFailureCases` is called by
`runBrowserResumeCustodyCases`, which `browser-session.blackbox.ts` invokes in
the normal browser-session domain. The existing provider-lifecycle fixture now
also asserts late-navigation recovery and preservation of the saved browser
state on Steel and Kernel. The /deploy backend coverage gate runs this suite.

Golden reference: not applicable (no prompt, schema, trajectory-injection or
other explicitly approval-scoped file changed). Backend restart is required;
no worker restart or migration is required.

Status remains open until the exact unchanged benchmark outcome is verified.
The owning-boundary and real-Chromium proofs establish the mechanism, not the
full benchmark's post-fix result.

## Human feedback

The user required a local failing-to-passing repro, unchanged task/timeouts and
assertions, permanent /deploy coverage, isolated database/port, and preservation
of other agents' work. During account-limit changes the user reassigned Codex
from reviewer to sole author. The prior author's partial edits were preserved.

## Reusable lesson

Settle a caught failed hydration only after exact native cleanup and atomic ownership checks, while retaining custody for truly unknown outcomes.
