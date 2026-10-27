---
id: 2026-10-27-cutover-fixture-omitted-schema-persistence
date: 2026-10-27
title: Cutover fixtures completed delegated tools but omitted the root schema persistence contract
surface: agents
component: workflow-blackbox-cutover
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mock_set_response_schema and mock_fetch_agent_config never persist or return the opted-in root response contract, so native completion polls a permanently null schema
symptoms:
  - "wf_cutover_drained_browser_resumes_same_step_on_new_generation"
  - "wf_cutover_background_browser_resumes_in_background_and_notifies_once"
  - "TimeoutError after successful resumed browser verification"
  - "expected one LLM turn per generation (spawn, then complete)"
tags:
  - workflow
  - cutover
  - schema-persistence
  - test-fixture
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - plan:.context/deploy-fresh-20261027/rca-workflow-cutover/REPORT.md
  - plan:.context/deploy-fresh-20261027/rca-workflow-cutover/REPORT-extension.md
  - plan:.context/deploy-fresh-20261027/workflow-v4-peer-review/REPORT.md
repro: agents/tests/blackbox/workflow.blackbox.py::_run_parked_tool_cutover_tests
status: open
---

## Problem

Two browser cutover cases failed in full agents coverage. The reporter retained only str(exception), which is blank for both TimeoutError and a bare AssertionError. The foreground case was reproduced natively as a 60-second result timeout. The historical background exception remains untyped and unreproduced; passing a later background control does not prove its cause.

## Diagnosis

The native foreground history records two correctly owned browser calls on old/new generations, preserving the task, session, tool and step7. Its resumed result and100% verification are present. Completion then repeatedly fetches a null response_schema with one-second timers until the unchanged caller deadline expires. The generic fixture generator and persistence mocks never establish a schema. The same native four-case group also reproduced that completion wait for the code-agent case, while approval and background passed.

A schema-only candidate was rejected: unconditional verifier success caused automatic completion after the delegated result and skipped the fixture's explicitly required second-generation model turn. Three original assertions failed. The final correction models both parts of this specific scenario: generated schema is persisted and fetched, and the opted-in verifier rejects synthetic completion until the scripted model reply actually requests completion. This exercises an existing native rejected-autoattempt path; it is not a production requirement that every completed child needs another model turn.

The earlier woken fixture case concerns an invalid completion tool envelope. The October25 schema-unknown startup case concerns a failed configuration read. Both are related surfaces, not this missing fixture persistence boundary. Their Solution and Human feedback sections were reviewed.

## Solution

Only four cutover fixtures opt in. They retain an absent schema before generation, persist the declared delegated output contract, expose it through the existing config mock, and record the actual scripted completion request. The verifier's phase score remains unchanged for all other scenarios. Six new checks verify original goal generation and schema continuity; all1242 original assertions and all eight original result/poll/sleep expressions remain unchanged. All per-agent captures and workflow pointers are removed in finally.

Exact proposed source SHA256745c01167abc4e7c3ea96337332dd86209aca1ca3f699705e0849ce867cbe12b passed4/4 native cutover cases in123.565s. The preceding wider-marker candidate also passed4/4 but was rejected by the explicit nonopted-script scope control; final V4 passes it. Independent exact-byte review conditionally approves fixture scope. The initial red and final green use the same native owner and acceptance; their diagnostic wrapper history serialization differed, so they are not advertised as byte-identical wrappers.

Root applied the reviewed final correction. Full workflow and combined source acceptance remain pending. The original background failure remains OPEN. The native workflow reporter now prints exception type and the retained traceback for failed Temporal cases, preserving the owning line even when str(exception) is blank; failure acceptance is unchanged. More history capture remains available in the private observer if needed. No production workflow, model, prompt, deadline or financial behavior changed.

## Human feedback

None recorded for this failure. Repository and coordinator requirements preserve the original assertions and reject timeout widening or an unexplained retry-green claim.

## Reusable lesson

Model the fixture's persisted output contract and intended completion phase explicitly while retaining every generation, custody and once-only acceptance assertion.
