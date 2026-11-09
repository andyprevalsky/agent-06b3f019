---
id: 2026-11-08-rootless-setup-throttle-tripped-smoke-infra-stop
date: 2026-11-08
title: An AgentCard org-throttle 429 in a pre-creation setup fixture failed the task with no retry, and the rootless result was sealed as an unknown root-creation outcome that tripped the smoke campaign's infra stop
surface: harness
component: run-benchmark-root-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py configure_benchmark_agentcard_setup treated the structured agentcard_org_mcp_rate_limited 429 as terminal, and _finalize_owned_cloud_batch accepted graded_creation not_started only when fixture roots existed, so a provably rootless task became an unknown creation outcome
symptoms:
  - "Failed to prepare-residual benchmark AgentCard setup: 429 {\"error\":\"AgentCard Organization MCP rate limit exceeded\",\"code\":\"agentcard_org_mcp_rate_limited\",\"retryAfterSeconds\":null}"
  - "RuntimeError: owned cloud execution has an unknown root creation outcome"
  - "FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup acknowledgement"
  - one ERROR task counted as INFRA and cancelled every other deploy smoke job (1/13 stop)
tags:
  - cloudbench
  - deploy-smoke
  - agentcard
  - rate-limit
  - root-custody
  - payment-benchmark
sources:
  - fleet run 20261108-044317-3921131 (deploy cloud cycle b2dd65330217), task agent-payment-new-user-journey remote-logs/cloudbench-driver.log
  - commit cc3642ae2 (failed source)
repro: cd agents && python -m pytest -q benchmarks/cloud_batch_cleanup_test.py -k "rootless_setup_failure or lost_create_response_before" and the blackbox test_agentcard_setup_retries_only_the_structured_org_rate_limit in tests/blackbox/benchmark.blackbox.py (benchmark domain); on cc3642ae2 the actual runner's rootless row raises "owned cloud execution has an unknown root creation outcome" and the setup call raises on the first 429, on the fix both pass
status: fixed
---

## Problem

In the deploy smoke run, `agent-payment-new-user-journey` failed about 9 s after it started. The first
statement of its execution, `prepare_sandbox_payment_residual`, POSTed
`/api/test-payment/lifecycle/agentcard-setup` with `action=prepare-residual`. The backend answered 429 with
`code: agentcard_org_mcp_rate_limited`. That was the org-wide AgentCard MCP cap, shared by every workspace using
these credentials. The task became ERROR. Batch finalization then raised
`owned cloud execution has an unknown root creation outcome`, the guest refused its cleanup acknowledgement, and
the controller counted the job as INFRA. One infra job in the 13-job smoke reached the campaign stop, so every
other smoke job was cancelled.

## Diagnosis

Two independent harness defects, both in `agents/benchmarks/run_benchmark.py`.

1. `configure_benchmark_agentcard_setup` retried only 5xx responses and raised on every status below 500. The
   backend emits the structured throttle (`classifyLifecycleError` in
   `back-end/src/domains/test-payment/lifecycle-errors.ts`) only after its own bounded MCP retries are
   exhausted. Payment lifecycle reads and abandonment in the same file already treat this exact condition as
   transient. The setup fixture was the remaining caller that did not.
2. Root custody. `run_single_task` creates custody with `graded_creation = "not_started"` and changes it to
   `unknown` immediately before the graded `create_agent`. The setup error was raised before that point, so the
   row had `graded_root_creation_outcome = not_started`, no `owned_roots`, no `agent_id` and no live ids.
   `_finalize_owned_cloud_batch` exempted `not_started` only when fixture roots existed. A provably rootless
   row was therefore reported as an unknown creation outcome, even though no creation request had been sent.
   `not_started` alone is also not sufficient proof. A fixture first-run `create_agent` and the Codex runner's
   own `POST /api/agents` both run while graded creation is still `not_started`, and either response can be
   lost after a root was allocated. `test_cancelled_unknown_create_stays_fail_closed` already rejects a bare
   `not_started` row.

Local repro on cc3642ae2: the actual runner with `prepare_sandbox_payment_residual` raising the exact 429
produced the production row, and `_finalize_owned_cloud_batch` raised the exact production message.

## Solution

- Setup retry: `_agentcard_setup_rate_limit_delay` parses the JSON body and qualifies a response only when it
  is a 429 with `code == agentcard_org_mcp_rate_limited`. The delay follows the abandonment convention: a
  positive `retryAfterSeconds` is used, capped at 90 s; a null hint waits 30 s. The number of attempts is
  unchanged (1 + 3). Unstructured 429s and every other 4xx remain terminal. A persistent throttle still raises
  with its cause.
- Idempotency, verified in the backend source. `reset` and `complete` rewrite the user's setup row (`complete`
  first does read-only `list_cardholders` and KYC reads). `prepare-residual` resolves the cardholder with reads
  only, then calls cardholder-scoped `recover_funds`. That call moves the remaining residual into the org wallet
  and returns `nothing_to_recover` once nothing remains, so repeating it converges and cannot duplicate funds.
  The backend maps a throttle to 429 only as `agentcard_org_mcp_rate_limited`. For mutations, that code comes
  from a structured provider refusal; text-only throttles are classified only for read tools.
- Root custody: custody now also records `root_creation_attempted` (initially False), exported as
  `TaskResult.root_creation_attempted`. It is set to True before every root-creation request in the custody
  scope: inside `create_agent`, at the first-run fixture call site, before the Codex runner and at the graded
  `unknown` transition. Finalization accepts a rootless row as a proven no-root outcome only when all of these
  hold: no `agent_id`, no `owned_roots`, no live ids, not SKIPPED, not passed, `graded_root_creation_outcome ==
  not_started` and `root_creation_attempted is False`. The row keeps its ordinary verdict. A missing (`None`),
  tampered or True value, or a lost first-run or Codex create, still fails closed as unknown.

Regressions: `test_rootless_setup_failure_keeps_its_task_verdict_instead_of_unknown_creation` and
`test_lost_create_response_before_graded_creation_stays_unknown` in `agents/benchmarks/cloud_batch_cleanup_test.py`.
Both drive the actual `run_single_task`. The second test is the negative control and failed before the
first-run call-site mark was added. Also `test_agentcard_setup_retries_only_the_structured_org_rate_limit` in
`agents/tests/blackbox/benchmark.blackbox.py`.

10k-agent behavior: no new channels, queries or shared state. One boolean per task result; a throttled setup
waits at most three bounded windows rather than adding load.

Golden reference: not applicable (harness-only; no approval-gated hunk).

## Review follow-up (PR #1775)

An adversarial review found one fail-open in the first version: the minted-account composite runs its stages
through nested `run_single_task` calls, each with its own custody, so a stage whose create response was lost marked
only the discarded inner custody and the composite row looked rootless. Nested custody now links to its parent and
`_mark_task_root_creation_attempted` marks every enclosing task. Regression
`test_composite_stage_with_lost_create_keeps_the_outer_task_unknown` drives the real runner with a nested lost create
(red: outer `root_creation_attempted` stayed False; green: the composite stays "unknown root creation outcome"). The
new setup-retry blackbox test is now registered in `run_all_tests()` (the agents structural registration gate had
flagged it as never run).

## Google400 merge follow-up (2026-11-08)

Merging this fix into Google400 as `9e58aa18` initially retained a second,
metadata-only precreation exception. Gate: INTRODUCED by that composition.
The existing strict setup regression failed with `DID NOT RAISE RuntimeError`:
old stop metadata could admit a row whose canonical custody marker was missing
or contradictory. The original native RED is preserved, not relabeled.

Remove the obsolete metadata-only exception and use this case's existing shared
canonical custody predicate unchanged. `run_single_task` establishes custody
before the phone preflight and copies its marker into every returned result;
all creation paths mark it before a request. The old phone-positive fixture now
supplies that actual `False` marker, preserving every original assertion. No
new proof variant, task-name allowlist, unknown-root waiver or financial action
is introduced. The identical two-test command was RED (one fail, one pass,
1.58 s), then GREEN (two pass, 1.35 s). Lost-create and composite-custody negative
controls also pass; native supervisors are quiescent with no orphans or signals.
The complete owning phone-daily and cloud-batch-cleanup files also passed all
123 cases in 10.85 seconds with clean supervisor closure. Normal final-source
agents validation remains required.

## Human feedback

None recorded for the original incident. For the Google400 follow-up, the user
prohibits new card/mint/charge/close/reclaim loops. This source merge and its
offline regressions do not authorize those operations.

## Reusable lesson

A "nothing was created" proof must come from a positive marker set before every creation request, not from a
status that only one creation path updates. Retry fixtures only on the backend's structured transient code, and
only after confirming the action converges when repeated.
