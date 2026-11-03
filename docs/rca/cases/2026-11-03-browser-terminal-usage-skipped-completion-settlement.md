---
id: 2026-11-03-browser-terminal-usage-skipped-completion-settlement
date: 2026-11-03
title: Generic browser terminal accounting bypassed the existing root completion allowance
surface: agents
component: browser-completion-accounting
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: spawn_agent terminal browser usage entered root cost enforcement before completion settlement; the existing allowance accepted only the retired browser tool name and dictionary dispatch
symptoms:
  - Agent status: COST_LIMIT_REACHED (expected COMPLETED)
  - completed generic browser never reached the existing wrap-up lifecycle
  - Agent paused, waiting
  - browser-biometrics-webdecoy
tags:
  - browser
  - completion
  - accounting
  - background-agents
sources:
  - agent 79f9187b-7515-4597-90d0-b45a2a155da2
  - commit a2ee4b8de8f41ad92c85f3224a67be7a91a8258d
  - commit 72a8bd7bf7e3a92b5717d13d617c2954bf453fca
  - commit 9e25b6e006b9fd7f3f2d64b24f2d44a81772ece0
  - commit e2df81cd537521134d115fedfca41e54c17a0b31
repro: agents/tests/blackbox/workflow.blackbox.py::test_workflow_generic_browser_result_gets_existing_budget_wrapup
status: open
---

## Problem

The original local `BROWSER_PROVIDER=kernel bash scripts/run-predeploy-local`
run rejected Webdecoy root completion after its browser verifier accepted the
observed reporting result. Native run a249f48a records 306.8 seconds, 179
stop-time messages and reported 148.0c/$1.48. The worker separately records
148.60246750000002c; neither value replaces the other. The unchanged task cap
is 120c and its timeout is 420 seconds. The original wrapper exited 1 with
8 PASS / 1 FAIL / 1 credential SKIP; its mass batch did not execute. A separate
remaining mass launcher exited 0 with its native judge SKIPPED: no selectable
Codex token, with the sole connected pool already cooled before judging.
Provider balance is UNKNOWN. These facts establish no funding exhaustion.

Worker lines 12495 and 12875–12877 show verified browser reporting followed by
a 145.11100000000002c returned-usage charge, including 3.6784c browser service
cost. Backend line 9257 publishes COST_LIMIT_REACHED. Root background delivery
and wait_for then finish, but the root remains paused. Browser output reported
score "0.15", checkbox false, invisible submission false and "Bot detected -
form blocked"; negative site results are valid reporting evidence, not a
reason to change the task evaluator.

The first fresh unchanged local baseline on current main passed below the cap:
run 57eb7a31, root 7a8fa49e-e1d2-4940-ac02-4e9a3d9fb7d2, 105.2 seconds,
21.0c, COMPLETED, with native cleanup verified. It does not reproduce or erase
the original budget crossing. Original source attribution is NOT_INTRODUCED
against 72a8bd7/a2ee4b8: the telemetry ownership fence cannot generate preceding
browser decisions or change this byte-identical accounting/completion path.
That gate does not release this independently assigned repair.

## Diagnosis

Critical path:

    background browser -> verified task_complete ToolEvent + usage
      -> generic spawn_agent event handling -> workflow accounting
      -> root budget decision -> durable status -> benchmark COMPLETED check

The original helper introduced by e2df81cd5 only recognized spawn_browser_agent
and dictionary executor returns. Production uses generic spawn_agent, whose
legacy helper charges ToolEvent usage and returns a tuple. Thus the existing
completion allowance is unreachable on this actual path. An alias-only repair
would still publish terminal COST_LIMIT_REACHED before granting continuation;
the benchmark treats that published state as terminal. Separately, consuming
allowance in every _check_paused call treats stream/cost checks as new turns.
A genuine pause arriving during settlement must retain precedence.

The registered workflow regression executes real generic dispatch and usage
accounting with a verified terminal event and 119c + 2c against unchanged120c.
It was observed failing before the repair at the missing completion allowance.
It now also checks no premature durable budget stop, exact charges, ordinary
root mark_finished, background notification/result delivery, one complete turn,
real before/during pauses, unsuccessful/declined browser receipts, unrelated
explore usage, productive-work refusal and continuation consumption. The
run_agent regression exercises streaming and the normal completion verifier.

The deepest proven owned cause is a split completion/accounting contract:
verified terminal usage is interpreted as a stop before the existing browser
completion allowance can settle. The expensive original 63-action trajectory's
historical cause remains unproven; no model/provider explanation is asserted.

Archive searches used literal COST_LIMIT_REACHED/browser and behavioral
spawn/browser/completion/continuation/usage vocabulary. Prior timeout, action
parser, scheduler and response-error cases are relatives, not proof of this
cause. Actual prior repair conversations were read, including the earlier
136-decision/zero-completion-attempt run. No matching landed repair was found.
This is a newly reproduced lifecycle gap, not proof those historical causes
have recurred.

## Solution

Candidate settlement uses the existing accounting owner and completion flags.
Only a browser task_complete event with explicit success=true authorizes
completion settlement before publishing a stop. Every charge, usage row and
tree persist remains intact. The existing allowance is consumed at an actual
loop-turn boundary, with repeated stream checks preserving that same admission.
Its only permitted tool work is the normal completion path; rejection or an
unfinished turn reasserts the original budget stop. Genuine user/parent pauses
remain authoritative, and continuation retains pending/consumed state. No task,
model, provider, evaluator, prompt, timeout or cap is changed. No FCaptcha
forced-completion action rewrite is restored.

Simplification removes unreachable dictionary-dispatch allowance calls and
settles terminal browser events in the existing usage owner. No new polling,
resource, channel, subscription or database scan is added. At 10,000 agents,
state and admission remain constant per workflow; ordinary idempotent usage
writes and bounded status persistence retain their existing ownership.

Golden references inspected: Hermes agent/turn_finalizer.py:130–164 preserves
an explicitly retained candidate withheld by stop/verification gates or
requests a bounded iteration-budget summary; agent/chat_completion_helpers.py:2232–2266 discards summary tool calls.
The separate turn_iteration_prep.py:408 fallback grace flag does not enforce a
toolless finalizer and is not evidence for that claim. OpenClaw
packages/agent-core/src/agent-loop.ts:299–348 settles tool results before stop
and abort decisions. Prime prime-agent-runtime/src/rlm/factory.py:2340–2379
checks its elapsed-time/child-admission budget before every admission. Claude
Code src/QueryEngine.ts:972–1002 strictly enforces its USD budget with actual
usage and grants no completion grace. Rose differs on monetary policy because
it already has an explicit verified-browser completion allowance: this repair
connects that existing policy to its generic accounting path, permits only
normal completion/verification, and retains every charge. These are partial
ordering/admission analogs, not claims that another harness grants this same
USD exception.

The first adversarial snapshot review rejected three concrete races. New
registered controls reproduced a second/concurrent productive call escaping
refusal, a pre-LLM generation handoff consuming the allowance, and a child cost
signal publishing a terminal stop during awaited settlement. The stabilization
keeps refusal latched across the whole batch, admits after handoff/compaction,
and arms synchronously before persistence can yield. Additional controls cover
compaction, a real continuation snapshot restored through normal completion,
and an unrelated cost stop arriving during pricing, which must stay stopped.
An explicit user pause during persistence still blocks admission and cannot
consume the allowance. A further pre-acceptance schema-failure control showed
that native bounded preparation retries also need to retain the unused
allowance: the loop's existing iteration-refund owner now refunds that same
pending allowance, never an accepted response and never a real pause. The
accepted-response bookkeeping failure control proves no refund occurs after
acceptance. No original evaluator or assertion is relaxed.

Fresh changed-snapshot adversarial review and full original invocation/
deployment verification remain pending; this case stays open until those
outcome gates complete. Interrupted source-superseded test attempts retain
original cancellation/failed cleanup receipts and are not counted as passes;
owner-scoped reconciliation and external resource verification are tracked
separately from the final stable invocation.

## Human feedback

The assignment explicitly preserves Freedom and protected instructions,120c,
420s, all no-browser/error/behavior assertions, financial/provider facts, and
user/parent pause semantics. It rejects raising caps, weakening evaluators,
skipping the assigned task, inventing a provider pass, or restoring the earlier
forced-completion workaround removed at the user's request. NOT_INTRODUCED
applies only to source attribution, not repair ownership. Nobody will answer
questions; this owner must finish merge, production verification, cleanup and
a completed colored HTML scorecard autonomously.

## Reusable lesson

Settle verified terminal usage through the existing completion owner before publishing a budget stop, and count bounded continuation at turn boundaries while preserving real pauses and every charge.
