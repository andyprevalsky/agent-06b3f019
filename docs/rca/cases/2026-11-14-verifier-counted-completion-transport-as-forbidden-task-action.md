---
id: 2026-11-14-verifier-counted-completion-transport-as-forbidden-task-action
date: 2026-11-14
title: Verifier rejected an authored reply because completion transport counted as forbidden tool work
surface: agents
component: verifier-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers/llm.py call_llm_structured_streaming prepends provider reasoning to the authored DAG response; subsequent verifier projection drops or mislabels that output and the rubric conflates completion control with task actions
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
repro: agents/tests/blackbox/reasoning.blackbox.py test_reasoning_authored_answer_excludes_provider_reasoning
status: fixed
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

1. The structured LLM parser prepended provider reasoning to the separate
   authored response field. Once task-tool attribution was fixed, a current-code
   live replay correctly rejected the explanatory preamble for exact-word
   noncompliance. The reasoning service now opts out of that presentation merge;
   ordinary loop callers retain it by default, and both retry paths forward
   the option. The same provider stream yields exact OK in the DAG and the
   existing thought-plus-answer presentation in ordinary callers. No text is
   stripped or inferred after generation.

2. `_filter_context_for_execute_verifier` preferred the first EXECUTE-tagged
   message over the earlier explicit transition. DAG reasoning has no phase;
   the first tagged row was a completion status chip after the reasoning. A
   local replay of the captured prefix exactly reproduced the original first
   verifier's reply-free request. Removing only the late phase tag retained the
   reply through the existing transition fallback. The owning integration test
   failed before the repair with the reasoning TOOL_RESULT absent.

3. Preserved DAG writing was serialized as TOOL_RESULT with tool_name reasoning,
   despite being an internally authored assistant result. The first repaired-path
   live replay still failed for prohibited reasoning-tool use, while extracting
   OK correctly. AUTHORED_RESULT now preserves its source and exact text without
   inventing a task tool invocation. Actual tool receipts remain TOOL_RESULT.

4. The verifier kept truthful model-origin completion invocation provenance
   (introduced by 9de48a21c15), but its rubric never distinguished the mandatory
   final-answer transport from task actions. The actor must submit completion
   through that transport; judging it as forbidden task work makes a no-tools
   reply impossible. Extraction coverage alone must still not imply completion.

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

Merged in [PR2099](https://github.com/Rose-Ai-Labs/rose/pull/2099) at
e158477bc23a0527df4500c3adf209b74ae1b7fd; all applicable production lanes passed. The repair preserves execution starting at the earlier of its explicit
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
- Earlier lifecycle-candidate negative controls rejected absent and wrong
  replies. Current-prompt controls separately rejected the original actual
  prohibited report_bug receipt and email claimed sent without a receipt.
  These are evidence of independent completion checks, not all fresh final-path runs.
- The final source-bound replay passed the original provider's separate
  reasoning and answer channels through the actual reasoning service/parser.
  It retained exact OK, preserved default-caller reasoning presentation, and
  the first-path live judge accepted in13.269s (task_completed=true, outputOK,
  extraction1.0). This is an isolated recorded-provider/live-judge test, not a
  fresh complete agent run. Earlier failed intermediate replays remain retained.
- Identical owning command before/after:
  `cd agents && source venv/bin/activate && BLACKBOX_CASE_FUNCTIONS=test_check_progress_keeps_completed_reasoning_before_completion_chip python scripts/run_blackbox_tests.py llm`
  Before exit 1: reasoning TOOL_RESULT absent. After exit 0: reasoning retained,
  goal preserved, planning evidence excluded, captured rejection not overridden.
- Prompt contract regression failed before, passed after. Full owning suites:
  llm 276/276, prompts 8/8, run-agent 105/105 and reasoning all pass. All four changed-test units passed five consecutive runs
  under eight CPU load slots via `scripts/select_affected_tests.py --stability`.
  The selector maps these tests into the ordinary agents-blackbox deploy lanes.

Private source requests, all failed and successful replies, raw rows, diagnostics,
worker logs, trial configs and hashes live under `.context/rca-no-tools` until
archived for closeout. They are not committed because they contain private
production context. Independent review exposed each first-path gap, and the final source-bound
producer/verifier replay accepted exact OK in 13.269s. Earlier rejected
intermediate repairs remain recorded. RCA-B16-2 was independently GROUNDED at
f3f060294defef913467af2a07fec80cc95a7a4c by thread
ph7b8w1efg50ndq894jzh141wd8j6h61; final packet SHA256
7e82c7f6df3331fa54bc5dc6d40f4994aab7618ff872a8f3b2e8b78229521999.
Three primary reference harnesses were opened directly for every scoped mechanism.
Reference analogs opened: Claude `src/query.ts:554` completes the final-response
path absent tool use; Codex `core/src/stream_events_utils.rs:356` and
`core/src/session/turn.rs:657` separate tool follow-up from turn completion;
Hermes `agent/conversation_loop.py:1685` separates tool execution from final
text; `agent/turn_final_response.py:88-99,125` preserves channel separation
and `:332-364` applies stop gates before persisting final output. Rose retains its verifier and completion
transport while converging on that lifecycle/task distinction. Ordinary rejection
feedback now contains the actual verdict and extracted output without appending
an unconditional instruction to produce fresh tool evidence. Existing
infrastructure-error guidance is preserved.

A neighbouring existing eval, `scripts/run-bench eval --only grep-agent-trajectories-code-tool-status`, passed 1/1 in 82.9s on f3f060294def. It correctly distinguishes tool FAILED from process exit0. Its stack processes/ports/database were retired; the generated card remains INCOMPLETE because the eval route did not emit a benchmark-owner receipt. Native PASS and cleanup proof are preserved separately; this reporting gap is not relabeled complete.

The final pre-merge source c41b933b246b8c7f9ced14bfff97c38fcb6657f7 passed all
17 selected deploy gates; the final cycle is READY. The earlier f3 source also
has retained validation evidence, but its results are not substituted for c41.
PR2099 merged as e158477bc23a0527df4500c3adf209b74ae1b7fd. All eight primary
runtime/regression files are byte-identical across reviewed f3, validated c41,
and the merge. The merged tree additionally contains 20 disclosed concurrent
main paths, including phone behavior/tests; this is scoped identity, not
whole-tree validation equivalence.

The retained f3 smoke record reports 11/11 actual tasks passed, no retries or
new failures, with three existing QUARANTINED_PASS labels. Its 11 fleets and
native canary have lifecycle/provider teardown receipts and supervisor exit0.
Final c41 smoke separately passed11/11, retained3 QUARANTINED_PASS labels and
verified all12 task/canary lifecycle releases with parent native exit0. Historical abandonment SKIP
remains separate and grants no current execution or financial-release credit.

Production verification targeted the actual merge. The first observer failed on
GitHub HTTP403 read quota. Read-only pool recovery then recovered the existing
workflow43662238673 attempt1 and durable job
9d44ab1182a10998f8bdf12ab425723eb0c79935d45702821d7f7360d46465bf.
The workflow itself failed on Fly wait_stopped HTTP408 in PREPARING. Its
original failure conclusion remains recorded. A first local resume lacked
FLY_API_TOKEN and failed; loading the existing documented agent-environment
credential fixed that local configuration without changing production auth.
The supported SAME-job recovery completed with SUCCEEDED, source/build e158,
attempt43662238673-1 and surface hash36c8f4ae94d7. No replacement job, forced
migration or timer-based release was used.

Native monitor --verify passed and reported cooperative_drain_complete with
the exact live pointer. Its old-queue open=? field remains a qualification;
the durable managed predecessor retirement certificate is the native proof.
The full native production command then passed all applicable lanes: Fly,
45/45 workflow-migration rows including synthetic fixture cleanup, and
[production semantics43665767816](https://github.com/Rose-Ai-Labs/rose/actions/runs/43665767816)
with all five jobs successful on their first attempt. Other lanes retained
native not-applicable omissions. Parent observed the full command exit0 and
owned descendants gone. The final c41 recorded-provider/actual-first-verifier
replay also passed in14.278s with exact OK, task_completed=true, score1 and its
GPT lease released. These proofs do not resume or sanitize the original paused
agent, whose actual report_bug violations remain failures.

At 10,000 agents this adds no requests, shared state, fan-in or polling. It adds
one existing-context scan and a static cached rubric paragraph per judge prompt.

## Human feedback

The user required reading actual work and evidence in active bug threads before
editing, reconciling existing ownership, completing RCA and then finishing deploy.
No implementation-specific correction or acceptance override was requested.

## Reusable lesson

Keep final-answer lifecycle transport distinct from task actions and preserve completed execution evidence before judging task constraints.

