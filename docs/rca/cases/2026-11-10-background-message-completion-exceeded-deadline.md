---
id: 2026-11-10-background-message-completion-exceeded-deadline
date: 2026-11-10
title: Background message smoke completed after its unchanged deadline
surface: agents
component: agent-workflow-completion
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: root completion summary started only after the attempt_completion verifier returned, adding a serial LLM call before durable COMPLETED
symptoms:
  - "Timeout after 182s (task timeout=180s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
tags:
  - background-agent
  - completion
  - flaky
sources:
  - PR #1905
  - commit b8655088c4d90dd884e22786ca33f5c2bfb02cd7
  - PR #1946 (merged d39e7e64092ddc90273b2b376c4b294516acc79c)
repro: scripts/run-bench background-agent-message-smoke --ref b8655088c4d90dd884e22786ca33f5c2bfb02cd7 --foreground
status: mitigated
---

## Problem

The existing task natively failed at 182.7 seconds with its original 180-second budget and ACTIVE status. The real forwarded message resumed the same research agent and both structured records were correct. A verifier score of 1.0 did not satisfy the completion deadline. The normal runner's single unchanged retry passed: classification FLAKY, with the first FAIL retained.

## Diagnosis

Authentic native requests and logs show verified-output readiness at T+168.493, followed by a successful 15.899-second summary generation. Durable COMPLETED was persisted about T+185.4. Display and verification had already taken 39.143 and 74.079 seconds. The reason those service times increased remains OPEN; no provider outage, credit exception or intelligence limitation is established.

Strict read-only materialization recovered eighteen complete base calls and eighteen updates, with full authentic messages, model configuration, schemas and outputs. The accepted earlier execution retained sixteen plus sixteen. All original native artifacts and request hashes are private and unchanged. An in-memory timing reduction illustrates the ordering only; its zero-delay counterfactual is neither a source fix nor a provider replay.

Gate: NOT_INTRODUCED, narrowly for source effects versus accepted 8b46515e5 and observed main58be9c. Independent review checked the complete changed-path inventory, all sixteen actual executed guest helper payloads, native image/dependency identities, configuration and timing owners. Relevant changed branches were positively excluded on this trace, including backend chat-only paths and archive draining after terminal status. Whole environment/service-time causality remains UNKNOWN. Different live cross-workstream occupancy was observed but is not attributed as contention.

## Repair diagnosis (2026-11-11)

Authentic dumps of the failed root and the accepted 8b46515e5 root (strict R2 materialization, same gpt-6.1-sol / xhigh configuration) separate three effects:

| Call | Failed TTFT / round trip | Accepted TTFT / round trip |
| --- | --- | --- |
| wait_for turn | 8.66 / 8.66 s | 2.08 / 2.09 s |
| send_message_to_agent turn | 10.73 / 10.73 s | 2.95 / 2.97 s |
| display turn | 23.32 / 39.11 s | 10.52 / 24.85 s |
| attempt_completion turn | 8.05 / 8.06 s | 2.77 / 2.77 s |
| verifier_execute | 14.75 / 74.04 s (2,392 output tokens) | 12.61 / 18.19 s (916) |
| completion_summary | 15.31 / 15.88 s | 8.61 / 8.98 s |

1. Provider time-to-first-token was uniformly about 6 s higher on every call of the failed run (environment; not source).
2. The slower root turns delayed forwarding until 03:08:30.6, after the first explore run had already finished (03:08:24.2): the task's accepted completed-first race. The verifier then reasoned at length about that procedural caveat (1,062 reasoning characters versus none) and emitted 2.6x the tokens before still scoring 1.0.
3. The root's completion summary is an independent presentation call over the same conversation, yet it started only after the verifier returned, so its whole round trip sat on the critical path between verified output and COMPLETED.

Recorded history (119 attempts) shows a long latency tail: p90 about 145 s, maximum 187 s. Items 1 and 2 are external/model variance and are not changed. Item 3 is a harness ordering defect that converts every slow verifier into a longer completion.

## Solution

The root workflow starts the unchanged `generate_completion_summary` activity (same model, effort, prompt and context) when the execute-loop verifier starts, via `run_agent(on_verification_started=..., on_verification_settled=...)`. `_mark_complete` adopts it only after that verdict passes; a rejected, interrupted or errored verdict discards it with its usage still accounted, and a failed or empty speculative summary falls back to the existing serial call. The final summary row is still posted before `mark_finished`/COMPLETED. Only the verifier's own structured output is absent from the speculative prompt, where it was awareness-only. Sub-agents and plan-phase verification keep the serial path. For the failed trace this moves durable COMPLETED from about T+185 to about T+170. Regressions: `run_agent.blackbox.py::completion_summary_hooks_bracket_verifier` and `workflow.blackbox.py::wf_root_completion_summary_overlaps_verifier`.

10k-agent behavior: at most one extra concurrent activity per root attempt_completion and no shared state; a rejected attempt costs one discarded summary call, which is accounted.

Validation: 6/6 clean-provenance cloud runs of the unchanged task on 0dc8b53 (67-102 s, verifier→final summary 0.7-0.8 s versus 9-16.8 s before); assigned command PASS on 0dc8b53 (82.8 s) and on merged-source 9520bffa4 (103.1 s, agent 9d391ff7-97e9-45e2-9e1a-4863a84c9d22); deploy gate round on 93920b74a PASS 17/17 with smoke 11/11 in one round. Production: Fly worker cutover verified at d39e7e6409.

## Remaining causes (owned follow-up)

Later occurrences on heads without the fix (FLAKY 48f4f224 root 058a97e4 via PR #2097; FLAKY 88cc1f54 root 1863ceae via PR #2044) show two further causes the overlap does not remove:

1. **Verifier-forced second cycle (about 80 s).** `_TASK_COMPLETION_DIRECTIVE` in `agents/helpers/llm.py` and `_admit_task_completion` cap a 1.0 score to 0.5 when a later message described the agent as "still running" but the forward resumed a completed agent, an outcome this task explicitly accepts (`allow_resume_after_completion`). Fixing it needs a verifier wording change (golden-reference review / approval).
2. **Planner turn blocked on the response-schema refresh (5.6-13.9 s).** `run_agent.py` awaits `get_response_schema()` before every planner turn, which waits for a mid-run refresh; that delay is what makes the forward lose the race. Ordinary turns do not need the new schema (the verifier waits for it itself).

Both are owned by the PR #1946 repair thread (https://boxes.dev/thread/ph77xckbcc8jvnqeaaw3x92tg18j0eb4); main carries the task's quarantine marker until that follow-up passes 5 consecutive times. Evidence: `/project/pr1946-evidence/followup-48f4f224/report.md`.

## Human feedback

Keep original FAIL and single-retry PASS distinct. Do not fabricate absent context, label ordinary latency an outage, weaken assertions or deadlines, or infer source attribution from a green baseline alone. The positive executed-producer exclusion is separate from the still-open latency diagnosis.

## Reusable lesson

Measure verified-output readiness, final publication and durable completion separately. A passing verifier cannot replace the native deadline outcome.
