---
id: 2026-11-10-background-message-completion-exceeded-deadline
date: 2026-11-10
title: Background message smoke completed after its unchanged deadline
surface: agents
component: agent-workflow-completion
classification: undetermined
problem_class: other
first_bad_boundary: verified output was followed by serial final-summary generation before durable completion
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
repro: scripts/run-bench background-agent-message-smoke --ref b8655088c4d90dd884e22786ca33f5c2bfb02cd7 --foreground
status: open
---

## Problem

The existing task natively failed at 182.7 seconds with its original 180-second budget and ACTIVE status. The real forwarded message resumed the same research agent and both structured records were correct. A verifier score of 1.0 did not satisfy the completion deadline. The normal runner's single unchanged retry passed: classification FLAKY, with the first FAIL retained.

## Diagnosis

Authentic native requests and logs show verified-output readiness at T+168.493, followed by a successful 15.899-second summary generation. Durable COMPLETED was persisted about T+185.4. Display and verification had already taken 39.143 and 74.079 seconds. The reason those service times increased remains OPEN; no provider outage, credit exception or intelligence limitation is established.

Strict read-only materialization recovered eighteen complete base calls and eighteen updates, with full authentic messages, model configuration, schemas and outputs. The accepted earlier execution retained sixteen plus sixteen. All original native artifacts and request hashes are private and unchanged. An in-memory timing reduction illustrates the ordering only; its zero-delay counterfactual is neither a source fix nor a provider replay.

Gate: NOT_INTRODUCED, narrowly for source effects versus accepted 8b46515e5 and observed main58be9c. Independent review checked the complete changed-path inventory, all sixteen actual executed guest helper payloads, native image/dependency identities, configuration and timing owners. Relevant changed branches were positively excluded on this trace, including backend chat-only paths and archive draining after terminal status. Whole environment/service-time causality remains UNKNOWN. Different live cross-workstream occupancy was observed but is not attributed as contention.

## Solution

OPEN. Preserve the final-summary-before-COMPLETED consumer contract; a bare status reorder is invalid. Investigate the authentic captured requests and serial publication boundary without changing original task assertions, clocks, deadlines, models or cache data. No source repair is claimed here.

As an additional non-introduced FLAKY task, it carries the required in-definition quarantine metadata and a retained failed-test packet. It still executes all original assertions and reports its native result. Dispatch the independent repair goal only after PR1905 merges, on a different Bugs devbox with durable evidence. Link the actual repair thread in the reviewed records follow-up. This is not a waiver or handoff of the assigned chat evidence repair.

## Human feedback

Keep original FAIL and single-retry PASS distinct. Do not fabricate absent context, label ordinary latency an outage, weaken assertions or deadlines, or infer source attribution from a green baseline alone. The positive executed-producer exclusion is separate from the still-open latency diagnosis.

## Reusable lesson

Measure verified-output readiness, final publication and durable completion separately. A passing verifier cannot replace the native deadline outcome.
