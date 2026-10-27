---
id: 2026-10-27-woken-verifier-fixture-used-nonterminal-default
date: 2026-10-27
title: Woken verifier fixture used an invalid nonterminal default instead of an explicit completion reply
surface: agents
component: workflow-blackbox-woken-verifier
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tests/blackbox/workflow.blackbox.py woken verifier scenario relied on default mock_call_llm_activity tool_name/params reply while run_agent consumes a flat tool discriminator
symptoms:
  - "wf_woken_subagent_verifier_judges_new_task_schema: woken sub-agent never reached its verifier"
  - "woken sub-agent reached fallback verification without dispatching its completion tool"
  - "has_tool_calls=False"
tags:
  - workflow
  - verifier
  - test-fixture
  - tool-protocol
  - false-positive
sources:
  - commit 8b1c38ff451f00d1cacb1c4f5fa8c05acc448e2c
  - plan:.context/test-runs/agents-coverage-20261027-011609-649722/workflow/manifest.json
  - plan:.context/deploy-fresh-20261027/rca-workflow-woken/final-receipt.json
repro: agents/tests/blackbox/workflow.blackbox.py::_run_all_workflow_tests (wf_woken_subagent_verifier_judges_new_task_schema)
status: fixed
---

## Problem

Full agents coverage on frozen 8b1c38ff failed the native woken sub-agent
regression with `woken sub-agent never reached its verifier`. Its other
workflow cases passed. The owning domain receipt records 328 seconds for the
whole domain; that is not the woken case's elapsed time. The supplied individual
workflow.log path did not exist; the original runtime evidence is retained in
`.context/deploy-fresh-20261027/agents-coverage.log`, with the domain manifest and
result under `.context/test-runs/agents-coverage-20261027-011609-649722/workflow/`.

The scenario starts a real local Temporal workflow with an original goal, a
finished prior summary and a NEW_TASK, then checks that schema generation and
the verifier honor the new task. Its loop produced 175 iterations of assistant
rows without tool declarations before the 60-by-0.5-second observation expired.
This is not evidence of a production verifier ignoring its schema.

## Diagnosis

The default mock LLM reply used `tool_name` and nested `params`. The production
run-agent preprocessor reads the flat `tool` discriminator and skips entries
without it. The outer list remains nonempty, so the empty-tool retry guard does
not terminate this sequence. No normal attempt_completion is dispatched.

A fast isolated run reached the 200-iteration limit within the observation
window. Its final fallback verifier populated the capture and made the old test
pass despite never dispatching the intended completion. This explains why a
passing isolated result did not establish the fixture's intended path; it does
not classify the failure as load or flakiness.

The unchanged owning case was selected by AST while retaining the native
WorkflowEnvironment, Worker, AgentWorkflow and mock activities. Under coverage,
an equal 200ms delay in the mock activity in both variants made the old reply
reproduce the exact original assertion after 102 iterations; the canonical
reply passed on iteration 1. This is a controlled latency input, not evidence
that the original host had an exactly 200ms delay per activity. A permanent
additional assertion checks the retained assistant history for the actual
completion declaration. Without injected delay, the old fixture fails that
assertion at its 200-iteration fallback; the final narrow candidate passes on
iteration 1. Exact commands, source hashes and logs are preserved in
`.context/deploy-fresh-20261027/rca-workflow-woken/`.

Archive searches were `woken sub-agent never reached its verifier` and
`wake workflow verifier schema wait polling`. The October 25 schema-unknown
startup case is related by verifier surface, but its first bad boundary is a
failed configuration read. No matching archived obsolete-mock-envelope case
was identified. This is a distinct test-fixture contract failure.

## Solution

The candidate gives this one woken scenario an explicit flat
`attempt_completion` reply through the existing `CUTOVER_LLM_SCRIPTS` mechanism,
retains all schema/goal/generation assertions, adds the real-declaration check,
and removes the scenario's script and queue captures in finally. It changes
only the owning case; the shared mock and the preceding group cases are
unchanged. All 1,241 existing assertion statements are preserved, with one new
assertion. No production code, prompt, model, schema or deadline changes.

A broader candidate that corrected the shared default was rejected by native
verification: 12 of 13 group cases passed, but `wf_transient_poll_burst_recovers`
requires a max_iterations terminal reason and instead completed. That control
intentionally needs nonterminal replies. The rejected 12/13 result is retained
in `after-group-selected-receipt.json`; it must not be relabeled as passing.

The final narrow source SHA256 is
`54539211fa2fe43295a39c61e4c8325d74a7660dfe69b204fc73da725d73b596`.
The final diff SHA256 is
`707427517274540e88c2eee110180a4daa3e98ea146ba0fa6e1ac9abc22a8d96`.
The same selected-native coverage driver is red before and green after.
The final complete 13-case native workflow group passed 13/13, including the
transient-poll max_iterations contract. Native contexts joined their owned
Temporal servers; observed owned process IDs were absent afterward. No live
provider, remote database or production task was called.

This case remains open pending parent-owned application and full canonical
workflow/agents coverage on the committed corrected source. The focused
native group does not replace that acceptance, any other deploy gate. No fresh Mac or production acceptance is claimed.

Golden test-producer analogs were read in
`openclaw/packages/agent-core/src/agent-loop.test-support.ts:110-115`,
`codex/codex-rs/core/tests/common/responses.rs:969-978`, and
`hermes-agent/tests/fakes/fake_llm_provider.py:383-405`: each fake emits the
actual protocol its consumer accepts. Their wire formats differ; Rose's exact
flat discriminator is established by its own run-agent preprocessor and the
existing scripted mock path. No matching producer was found in the searched
Claude test/mocking surface, and Kimi's tests directory was unavailable.
Production resource use at 10,000 agents is unchanged because this is an
offline fixture-only correction.

## Human feedback

The coordinating agent restricted this lane to the actual workflow gate failure, prohibited
speculative runtime/prompt/model/timeout changes and shared edits before review,
and assigned full acceptance plus archive/index ownership to the parent.
The parent reviewed the narrow candidate as the correct owning-scenario scope
and required this case to remain pending full committed-source acceptance.

## Reusable lesson

Give completion-verifier fixtures an explicit valid completion stimulus and assert that the intended tool path ran, so an iteration-limit fallback cannot masquerade as normal verification.


## Full native owning-domain verification on October 27

The committed correction at46bfbfb5 passed the full native workflow coverage domain in329.02 seconds during the canonical agents batch. That batch failed a separate code-sessions fixture; this receipt establishes the corrected workflow domain, not a green whole-deploy gate.
