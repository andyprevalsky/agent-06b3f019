---
id: 2026-11-14-verifier-counted-completion-transport-as-forbidden-task-action
date: 2026-11-14
title: Verifier rejected an authored reply because completion transport counted as forbidden tool work
surface: agents
component: verifier-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers/llm.py execute phase projection drops DAG reasoning before the first tagged completion chip; utils/prompts.py leaves mandatory completion transport indistinguishable from task actions
symptoms:
  - "Verifier score: 50%"
  - "contrary to the user's explicit prohibition on using any tools"
  - "The separate task-completion verdict is not true"
  - "completed DAG reasoning reply removed by late first-EXECUTE boundary"
tags:
  - verifier
  - completion
  - lifecycle
  - phase-filter
sources:
  - agent b16f9e06-7b74-5d01-adb6-24314e18c78c
  - commit 9de48a21c156772390f830d76e5fa0e239d81cac
  - commit e49c701aaaf34c0cbac1b1234240846b630affbc
repro: agents/tests/blackbox/llm.blackbox.py test_check_progress_keeps_completed_reasoning_before_completion_chip
status: open
---

## Problem

A production root was asked to reply with the single word OK, finish, and use no
tools, create no code agents, file no bugs, and send no user message. Its owner
created this as a live `scripts/rose-delegate` parameter test; the CLI was only
an HTTP client to production, not a locally modified worker. The owner paused
the root after observing the loop. Pause did not cause the failure.

The final captured API snapshot contains 100 rows and 17 completed verifier
rejections. The first rejected for missing reply evidence. Nine subsequent
verifiers extracted the authored OK with extraction score 1.0 but returned
`task_completed=false` solely because `attempt_completion` was invoked. Runtime
correctly applied the independent verdict and displayed 50%. After the agent
actually called the prohibited `report_bug`, seven more rejections cited that
real violation. Those later rejections must remain failures.

## Diagnosis

Path: USER goal and schema → PLAN → reasoning DAG task → persisted reasoning
answer → post-DAG completion chip → `check_progress` → execute-phase filter →
verifier messages → independent completion verdict → rejection → next actor turn.

Four boundaries contributed to this incident:

1. `_filter_context_for_execute_verifier` preferred the first EXECUTE-tagged
   message over the earlier explicit transition. DAG reasoning has no phase;
   the first tagged row was a completion status chip after the reasoning. A
   local replay of the captured prefix exactly reproduced the original first
   verifier's reply-free request. Removing only the late phase tag retained the
   reply through the existing transition fallback. The owning integration test
   failed before the repair with the reasoning TOOL_RESULT absent.
2. The verifier kept truthful model-origin completion invocation provenance
   (introduced by 9de48a21c15), but its rubric never distinguished the mandatory
   final-answer transport from task actions. The actor must submit completion
   through that transport; judging it as forbidden task work makes a no-tools
   reply impossible. Extraction coverage alone must still not imply completion.

3. Preserved DAG writing was serialized as TOOL_RESULT with tool_name reasoning,
   despite being an internally authored assistant result. The first repaired-path
   live replay still failed for prohibited reasoning-tool use, while extracting
   OK correctly. AUTHORED_RESULT now preserves its source and exact text without
   inventing a task tool invocation. Actual tool receipts remain TOOL_RESULT.

4. The structured LLM parser prepended provider reasoning to the separate
   authored response field. Once task-tool attribution was fixed, a current-code
   live replay correctly rejected the explanatory preamble for exact-word
   noncompliance. The reasoning service now opts out of that presentation merge;
   ordinary loop callers retain it by default, and both retry paths forward
   the option. The same provider stream yields exact OK in the DAG and the
   existing thought-plus-answer presentation in ordinary callers. No text is
   stripped or inferred after generation.

The deeper class is a mismatch between execution lifecycle and task evidence,
not a special OK classifier or a request to suppress actual tool actions.
A more general removal of all invocation evidence was rejected: it would erase
real provenance and weaken action constraints. A code-only score override was
also rejected because correct output does not prove a requested action occurred.
The narrow prompt distinction is required at the semantic judge; the projection
repair separately preserves executed work without admitting PLAN/RESEARCH rows.
No synthetic user/tool recovery messages are added.

The initial checkout f0bc6ec277 predated the serving contract. Refreshing to main
6ecbd4aa97 revealed both the recorded invocation and independent verdict fields;
all local model experiments used the current Rose client and the exact captured
schema, GPT auth path, ultra pool, xhigh effort and original generation budgets.

Archive searches: `attempt_completion no tools`, `verifier 50%`,
`execute verifier missing reasoning phase boundary`. This is novel, with relatives:
`2026-10-13-execute-evidence-scope-discarded-user-specification` concerns the same
projection family but loses the USER goal, not executed reasoning;
`2026-11-07-verifier-history-stripped-card-receipt-image-urls-after-private-entry`
shows actor/judge projection divergence under a different mechanism;
`2026-08-03-purchase-verifier-flattened-authorized-blocker-branch` teaches avoiding
mutually exclusive completion conditions. Their Solution and Human feedback
were read; none authorizes hiding tools or changing acceptance criteria here.
Active project threads were read before edits. The chat-generator direct-answer
repair, completion-summary overlap repair, and spawn-migration owner all
confirmed their actual work does not own this verifier failure.

## Solution

Pending deployment. Preserve execution starting at the earlier of its explicit
Beginning Execute Phase transition and first EXECUTE-tagged row; set_plan remains
the legacy fallback only when neither is present, while continuing to discard tagged
PLAN/RESEARCH rows. Explain in the static verifier rubric that completion
submission is lifecycle transport, while actual task tools, messages, agent
creation and bug reports remain subject to the user's constraints. Preserve all
invocation evidence, independent completion verdicts, extraction and schemas.

Verification on the recorded request:

- Explicit paired model panel: original 0/5 accepted; candidate 5/5 accepted.
  All ten used `gpt-6.1-sol-gpt`, `gpt-token`, with leases released.
- Earlier exploratory original trials were one pass and one failure, retained
  separately: this ambiguity is stochastic, not deterministic for every call.
- Candidate negative controls rejected all four: absent reply, wrong reply,
  actual prohibited report_bug, and email claimed sent without a receipt.
- Current production-prompt builder replay passed, extracting OK and returning
  task_completed=true. These are isolated judge calls, not a fresh full agent.
- Identical owning command before/after:
  `cd agents && source venv/bin/activate && BLACKBOX_CASE_FUNCTIONS=test_check_progress_keeps_completed_reasoning_before_completion_chip python scripts/run_blackbox_tests.py llm`
  Before exit 1: reasoning TOOL_RESULT absent. After exit 0: reasoning retained,
  goal preserved, planning evidence excluded, captured rejection not overridden.
- Prompt contract regression failed before, passed after. Full owning suites:
  llm 276/276, prompts 8/8. Both changed cases passed five consecutive runs
  under eight CPU load slots via `scripts/select_affected_tests.py --stability`.
  Selector maps both files into the ordinary agents-blackbox deploy lane.

Private source requests, all failed and successful replies, raw rows, diagnostics,
worker logs, trial configs and hashes live under `.context/rca-no-tools` until
archived for closeout. They are not committed because they contain private
production context. Independent RCA review found the first-path gap; its live replay and negative
controls drove the authored-result projection fix. Final golden review is pending.
Reference analogs opened: Claude `src/query.ts:554` completes the final-response
path absent tool use; Codex `core/src/stream_events_utils.rs:356` and
`core/src/session/turn.rs:657` separate tool follow-up from turn completion;
Hermes `agent/conversation_loop.py:1685` and `agent/turn_final_response.py:53`
separate tool execution from final text. Rose retains its verifier and completion
transport while converging on that lifecycle/task distinction. Ordinary rejection
feedback now contains the actual verdict and extracted output without appending
an unconditional instruction to produce fresh tool evidence. Existing
infrastructure-error guidance is preserved.

At 10,000 agents this adds no requests, shared state, fan-in or polling. It adds
one existing-context scan and a static cached rubric paragraph per judge prompt.

## Human feedback

The user required reading actual work and evidence in active bug threads before
editing, reconciling existing ownership, completing RCA and then finishing deploy.
No implementation-specific correction or acceptance override was requested.

## Reusable lesson

Keep final-answer lifecycle transport distinct from task actions and preserve completed execution evidence before judging task constraints.
