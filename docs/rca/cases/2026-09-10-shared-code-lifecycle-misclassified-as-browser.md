---
id: 2026-09-10-shared-code-lifecycle-misclassified-as-browser
date: 2026-09-10
title: Evidence publisher treated a code-agent terminal as a browser needing a recording
surface: harness
component: durable-evidence-publisher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The browser evidence validator inferred browser identity from shared task_started and task_complete actions despite explicit code-agent identity
symptoms:
  - "FE link browser validation failed"
  - "has no correctly attached recording"
  - "spawn_claude_code_agent"
tags:
  - evidence
  - browser-recording
  - code-agent
  - task-identity
sources:
  - PR #1299
  - agent 2b027e4b-75f3-4013-8d8d-67830d580383
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

The unchanged `claude-code-agent` smoke task passed in 61.7 seconds, but the
canonical evidence publisher rejected its durable frontend link. It demanded a
browser recording for task `60740827-574e-438d-aa52-af072af24721`, which was a
Claude Code task. Run `63368a7a-25f2-4222-8e0a-235f66f06f15` and its captured
messages establish the task identity without making a provider availability
assumption.

## Diagnosis

Code-agent producers emit `task_started` and `task_complete`, just as browser
producers do. The captured task used `toolName=spawn_claude_code_agent`; its SDK
and history messages also carried `agentType=code`. The evidence validator
classified either shared action as browser evidence without consulting that
identity, then demanded a recording that code tasks do not produce.

The first bad boundary is
`validate_browser_agents_terminated_with_recording`, not the successful code
task, browser teardown, or recording storage. Archive search found the earlier
missing browser-validation case from August 31; this is a distinct false
classification introduced by applying that browser contract to another agent
type.

The permanent regression adds the captured code lifecycle shape to the existing
publisher suite. Before the repair, its no-browser assertion failed. No provider
request or application service was needed to reproduce the defect.

## Solution

Track explicit code and browser identity across the complete task event stream.
Exempt identified code tasks from browser recording checks unless the same task
also has explicit browser evidence. Preserve the existing checks for unknown
legacy lifecycle identities. A code marker cannot hide a browser recording
failure, including when the two identities arrive in either order.

The focused regression and the enclosing `durable-evidence-links.test.sh` suite
pass after the repair. Republishing the same unchanged run then verified the
durable frontend link with 20 messages and published its actual last LLM dump:
https://www.roselabs.ai/?agent-id=2b027e4b-75f3-4013-8d8d-67830d580383

Private red/green and live publication logs are retained under
`.context/acceptance/evidence-code-identity-*`. This changes only evidence
classification; it adds no agent requests, provider sessions, polling, or
per-agent runtime state. Processing remains linear in the supplied messages and
stores one small identity record per task.

## Human feedback

The user requested completion without repeated permission questions and ten
sequential cloud slices of ten with zero infrastructure failures. No benchmark
prompt, timeout, evaluator, or agent recovery behavior was changed.

## Reusable lesson

Bind evidence requirements to the task's explicit agent type before interpreting shared lifecycle events.
