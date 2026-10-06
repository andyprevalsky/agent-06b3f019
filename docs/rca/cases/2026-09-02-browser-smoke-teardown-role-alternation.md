---
id: 2026-09-02-browser-smoke-teardown-role-alternation
date: 2026-09-02
title: Browser FE teardown FINISHED reused spawn toolCallId and aborted smoke with role_alternation
surface: agents
component: spawn-browser-agent-v3 / context-validator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py `_emit_browser_task_terminal_for_fe` — posts FINISHED teardown on the spawn toolCallId without excludeFromModel"
symptoms:
  - predeploy smoke browser-smoke fails with role_alternation dual-write
  - agent actually completed the example.com heading task
  - OAI view shows consecutive tool-calling assistants (spawn then attempt_completion)
  - only "Browser session closed after teardown" remains as the spawn tool result
  - browser abandonment hides specific user rejection feedback from model context
tags:
  - browser-smoke
  - context-validator
  - role-alternation
  - exclude-from-model
  - teardown
sources:
  - agent dabeeb92-8607-4a38-8762-61878aa0dfbd
  - PR #1197
repro: agents/tests/blackbox/context_validator.blackbox.py::test_browser_teardown_exclude_from_model_preserves_spawn_tool_result
status: fixed
---

## Problem

Pre-deploy smoke failed `browser-smoke` with role_alternation even though the
agent completed the example.com heading task successfully.

## Diagnosis

FE teardown posted FINISHED on the spawn `toolCallId` without
`excludeFromModel`, so the model-facing transcript lost the spawn tool result
and showed consecutive assistant tool-calling turns.

## Solution

Mark FE-only browser teardown terminal events `excludeFromModel` so they do not
mutate the spawn tool result the context validator / model transcript require.

## Human feedback

Smoke aborted on context validation while the durable FE agent had already
succeeded; failure was harness dual-write, not task failure.

## Human feedback

None recorded.

## Reusable lesson

FE-only side effects that reuse a toolCallId must be excluded from the model
context, or dedup/role_alternation validators will fail a successful agent.

### October 1 full-review recurrence: abandonment replaced rejection feedback

Finding 4155225075 identified another producer of FE-only browser terminal
events. The manager persisted the user's specific rejection feedback, then
emitted `Browser automation stopped` with the same tool-call ID. The actual
event serializer retained both rows, but the shared model-context converter
kept only the later generic ERROR result. This is a functional loss of feedback,
not a separate cybersecurity investigation or evidence of a model failure.

Archive searches used `abandon feedback context exclude model approval rejected`
and `last finished error tool result overwrite post message context`. This case
and the August 4 converter-invariant case identified the shared dedup boundary.
The earlier repair protected `_emit_browser_task_terminal_for_fe`; the newer
`_browser_abandoned_resume_event` omitted that metadata contract. Its nine call
sites already emit a specific model-facing FINISHED/ERROR outcome before the
FE-only terminal.

The owning local reproduction drove the actual manager with a populated
`UserRejectedError.rejection_message`, serialized each yielded event through
the real `handle_tool_event`, and converted those persisted rows through the
real `convert_context_to_messages`. It confirmed specific feedback persisted
but absent from the model context, while the exact browser task still had one
ERROR terminal. The existing fixture originally set only the exception message,
leaving `rejection_message` empty; that initial control is preserved and is not
counted as proof of feedback loss.

The permanent existing manager fixture now includes this real serialization
path and requires one correctly paired tool result containing the original
feedback. It failed with `FE closure erased the user's rejection feedback`
before the fix, then passed unchanged after adding only
`excludeFromModel: True` to the abandonment terminal's metadata. The original
FE task identity, terminal count/status, pending resume and cancellation
assertions remain intact. The neighboring existing seven payment-abandonment
controls and original teardown/context regression also passed. This adds no
model calls, provider actions, prompts, task changes or new verification stage.
Private paired logs, source hashes and the initial fixture gap are preserved
under `.context/acceptance/proof87-review-event-context-rca/`.

Independent review verified the owning production boundary, unchanged RED/GREEN assertions, retained failure controls and existing gate registration. The fix is constant metadata per already
emitted task event at 10,000 agents; it adds no shared state, fan-in or extra
I/O. This causal regression does not grant fleet credit or retroactively change
any original benchmark result. Final source-bound deployment and acceptance
proof remain separate requirements.
