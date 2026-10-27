---
id: 2026-10-27-workflow-mock-used-legacy-completion-envelope
date: 2026-10-27
title: Workflow LLM mock used a legacy completion envelope and could verify only after exhausting the loop
surface: agents
component: workflow-blackbox-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tests/blackbox/workflow.blackbox.py mock_call_llm_activity returned tool_name/params while run_agent consumes flat tool calls
symptoms:
  - wf_woken_subagent_verifier_judges_new_task_schema
  - woken sub-agent never reached its verifier
  - scripted completion must finish in one call, got 200
tags:
  - workflow
  - test-fixture
  - tool-call-contract
  - false-positive
sources:
  - commit 6230916b01
  - commit 68769c08d3
  - commit 68c20779a
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

A required agents-coverage gate encountered while deploying the frontend browser
fix failed workflow.blackbox.py's woken-subagent case. Its captured run had 193
text-only iterations before the unchanged verifier wait elapsed. All other 120
agent blackbox domains passed. Isolated runs could falsely pass after exhausting
200 iterations because that fallback also invokes a verifier.

## Diagnosis

The mock completion returned `tool_name` and nested `params`. The real dispatch
path consumes the flat `tool` field and top-level arguments, so it ignored this
supposed completion and continued the loop. The fixture's other scripted branch
already used the correct flat envelope. The original assertion checked only that
a verifier ran and received the regenerated schema; it did not distinguish normal
completion from loop exhaustion.

Permanent coverage now also requires one LLM call for this scripted immediate
completion. The exact existing woken case was reduced by AST to isolate it while
preserving its real Temporal worker, activities, production loop and assertions.
The unchanged command was `agents/venv/bin/python .context/multi-browser-43082b47/workflow-gate-triage/focused_repro.py`.
With only the mock envelope restored to its old shape: exit 1 in 10.687 seconds,
`scripted completion must finish in one call, got 200`.
With the corrected envelope: exit 0 in 2.666 seconds, the same case passed.
Logs are permanent-before.log and permanent-after.log in that private directory.
An initial launcher that resolved the venv interpreter symlink lost its site
packages; those invalid-venv logs are explicitly excluded from causal evidence.

Archive searches used `woken sub-agent never reached its verifier` and
`tool_name params mock workflow verifier`; no matching fixture cause was found.
This is a relative of verifier-contract incidents, with a distinct test-owned
boundary. Golden-reference mock/tool-call searches covered claude-code-src,
Codex, OpenClaw and Hermes; none defines Rose's private flattened mock envelope.
The owning reference is the actual run_agent dispatcher and the existing flat
scripted branch of the same fixture, rather than a provider-specific envelope.

## Solution

Make the default mock return the same flat completion envelope as the actual
LLM activity. Clear this case's existing per-agent activity counter before launch
and assert that the scripted completion reaches verification after one LLM call.
Preserve the schema assertions, runtime code, loop limits and verifier wait.
The full-domain check also exposed poll-retry scenarios that intentionally
require loop exhaustion: those fixtures now explicitly return an empty tool-call
list while in progress, instead of depending on the same malformed completion.
Their original loop-exhaustion assertions remain unchanged.
The existing workflow blackbox domain is registered in the normal agents
coverage runner and /deploy Step 4g. Full-domain and full-coverage results are
recorded in the deploy receipt rather than inferred from the isolated pass.
This test-only correction adds no production queries, subscriptions or work at
10k agents.

## Human feedback

The active user task is frontend display and labels only. This repair changes
only a mandatory test fixture and strengthens its assertion; runtime execution
semantics remain unchanged. No separate feedback on this fixture was recorded.

## Reusable lesson

Make completion fixtures use the runtime's real tool-call envelope and assert normal completion so a terminal fallback cannot create a false pass.
