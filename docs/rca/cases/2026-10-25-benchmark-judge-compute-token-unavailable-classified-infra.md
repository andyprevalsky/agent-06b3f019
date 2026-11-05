---
id: 2026-10-25-benchmark-judge-compute-token-unavailable-classified-infra
date: 2026-10-25
title: A benchmark judge that found the shared Codex token pool cooled down ended ERROR and counted as INFRA instead of a skipped test
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _run_single_task_as_run_user exception handler mapped the declared judge's untyped RuntimeError("Codex compute token unavailable for agentic benchmark judge") to status ERROR, which scripts/run-bench-campaign.py task_verdict counts as infra_failure
symptoms:
  - "Declared evaluator t7-schema-task-complete execution failed: Codex compute token unavailable for agentic benchmark judge"
  - "Codex compute token unavailable for agentic benchmark judge"
  - "GPT credentials not found for user 1f85ff25-6e29-4c1b-8739-f917bd101a30"
  - "GET /api/integrations/compute-code/credentials/token -> 404 (Delegated compute-token request status=404)"
  - test-mass-agent-run-0 ERROR classified INFRA under a 70-copy cloud fleet
tags:
  - benchmark
  - compute-token
  - judge
  - skip
  - campaign
sources:
  - agent ddc1c122-6786-4501-b0c9-dcdbe0b69718
  - agent 95f1069c-5e23-421b-a6b3-c37e6b9d40ba
  - fleet run 20261025-015409-23798
  - fleet run 20261025-015410-23850
repro: agents/tests/blackbox/benchmark.blackbox.py::test_judge_compute_token_unavailable_is_a_skipped_test_not_infra
status: fixed
---

## Problem

In the 70-copy cloud fleet on 016fca859, both test-mass-agent-run-0 copies finished
their agent run, then ended `task_status=ERROR` with
`Declared evaluator t7-schema-task-complete execution failed: Codex compute token unavailable for agentic benchmark judge`.
The campaign counted both as INFRA, which feeds the >=5% infra stop. The same task
passed its earlier single-copy runs.

Guest backend logs: the judge's `GET /api/integrations/gpt-code/credentials/token` got 404 at
02:10:01 and 02:11:07Z, then `GET /api/integrations/compute-code/credentials/token?tokenType=gpt`
was delegated to the prod authority and also got 404. The judge raised straight away.

## Diagnosis

The judge takes the lease-free path (no `lineageKey`), so lease capacity was not the cause.
Live-lease counts are computed only from recently used leases. Prod `Integration` rows (read-only)
show Andy's only CONNECTED `gpt_code` integration, `de25c911`, with `rateLimitedUntil=2026-10-25T02:14:21.208Z`.
The other one is limited until 2026-10-27.

Prod Render `GptCredentials` logs plus the guest worker logs show how the window was set:
- 02:03:46–48: several fleet guests got Codex 429s. They marked the token until the provider's own reset, `02:03:50.000Z`, a few seconds away.
- 02:03:49 and 02:03:50: the same guests' workflow `_on_tokens` re-marked the token with an uninformed 5-minute default (`agents/workflows/agent_workflow.py` passes `5 * 60, None`). That happened after the call fell through to the waterfall.
- 02:04:21: a browser-auth guest's TTFT stall marked the token for `_STALL_TOKEN_COOLDOWN_S = 600` (`agents/providers/rose/client.py`), until 02:14:21.

Both judge requests fell inside that window. The deepest owned defect is a contract
inconsistency. Repo policy already classifies a missing provider credential as SKIPPED
(`CLAUDE_CODE_CREDENTIAL_SKIP_REASON`, `CODEX_HARNESS_CREDENTIAL_SKIP_REASON`), but a judge
that can't get a token from an exhausted or cooled-down pool raised an untyped RuntimeError.
That became ERROR, and the campaign's `task_verdict` counts ERROR as infra.

Local repro (red on 016fca859): the new benchmark-domain test drives the real
`_fetch_agentic_judge_compute_token` (both token sources return 404) through the real
`_run_declared_evaluators`, then through `_run_single_task_as_run_user`. Result:
`status='ERROR'` with the exact production failure_reason.

## Solution

- `_fetch_agentic_judge_compute_token` raises a typed `ComputeTokenUnavailable` (a RuntimeError subclass), and `_run_declared_evaluators` keeps that type when it wraps the error.
- The task handler maps it to the existing SKIPPED status, unless the agent already failed its evaluation. The reason is prefixed `Compute token pool exhausted or cooling down:` and keeps the original message.
- `_ci_should_fail` permits that exact skip.
- `scripts/run-bench-campaign.py task_verdict` treats SKIPPED as a terminal task: not infra, not retried, not counted toward the infra stop. The scorecard already renders SKIPPED as its own category.

At 10k agents this adds no requests, rows or polling; it only changes how an
already-raised error is classified.

Observation recorded, policy intentionally unchanged: the provider's reset was 4 s away.
Uninformed marks (a 5-minute workflow re-mark after RoseClient had already recorded the
provider reset, and a 10-minute stall cooldown) kept the only Codex account unavailable
for about 10 minutes, fleet-wide and in prod. Golden references: claude-code-src
`src/services/api/withRetry.ts:530-545` caps per-request backoff at 32 s and honors
`retry-after`. Its 10-minute `MIN_COOLDOWN_MS` (`withRetry.ts:801`) is a per-process
fast-mode switch, not a shared credential ban. codex `codex-rs/codex-client/src/retry.rs:43`
uses per-request exponential backoff. Andy chose not to change the cooldown policy now.

## Human feedback

Andy (relayed by the /descend parent): "If some token pools get exhausted and like a bench
for testing those APIs fails, it's ok for it to be a skipped test, not a behavior we need
to force a fix on." Benchmarks are meant to affect prod token state, since they share
those tokens, so no bench-vs-prod isolation of cooldown marks. The retryAt bounded-wait
proposal and the cooldown-policy changes were dropped.

## Reusable lesson

When a benchmark consumer cannot obtain a shared compute token because the pool is exhausted or cooling down, raise a typed error that maps to the existing SKIPPED status with the exact reason, never an untyped error the campaign counts as infra.


## November3 c492 availability qualification

The native mass-agent task completed but its declared T7 GPT judge was not
executed: local credential404 at03:52:07.774 UTC and production-authority
404 at03:52:08.079-080 UTC produced the native SKIPPED row. Native artifact
SHA2566e19790e83953002ee2a2f300d8447551cd327bfd15b25964bfd3c519ea50ac2
remains immutable. Production read-only aggregates at01:05,04:12 and04:23
recorded the sole CONNECTED pooled GPT token cooling until
2026-11-04T07:59:37Z with no eligible CONNECTED alternative. Its updatedAt
02:08:49.785 UTC predates the failed judge request; expired rows were last
updated in October. The unchanged resolver correctly rejects that pool state.

Gate: NOT_INTRODUCED for unavailable shared compute quota/cooldown. The exact
native receipt and reason are qualified as SKIPPED_WITH_WARNING using
compute_quota_exhausted; no billing-credit exhaustion, successful judge
verdict, provider reset or repair delegation is claimed. Original outer FAIL
and inner SKIPPED remain retained, with unverified judge coverage. Exact
provider usage history and the originating reset event were not reconstructed.
The closure packet is SHA2569c677fbd2343a5cfe739f9cf8ae4da1a4936d29ca06a2cffe6ec2f8894b05a45.


## November3 2c1 exact availability recurrence

Occurrence65a38630079f40c385048ee3bd4e759a preserves mass artifact
SHA256b20f55ef8be28c5fd1785e723042f169321566f2c577ec55cc798b982c598707,
finished1793689407.4643824, source2c1acbc4ea40fbc9c8167ebb17c12df518bf32a9.
Native SKIPPED remains normalizedFAIL: agent4ca07cb0 ran, but required
T7 judge credential acquisition got local404 at06:49:09.273Z and
delegated404 at06:49:09.546Z. The unchanged resolver requests GPT tokens.
The06:51:06Z saved production aggregate records sole CONNECTED pooled GPT
row cooling untilNov4 07:59:37Z, last updated02:08:49.785Z before the
request; all other recorded rows EXPIRED. Gate NOT_INTRODUCED at this
availability boundary vs actual merge-baseff36510b8f58f0c71c8f3ff9c6a23ff22ba64638
→2c1acbc4ea40fbc9c8167ebb17c12df518bf32a9. Required judge coverage stays
unverified; no judge/taskPASS, billing-credit exhaustion or exclusive
provider-origin reset reason is claimed. The stored cooldown setter event
was not reconstructed. Actual source404/200 controls prove resolver parity
only; no live task retry occurred. Current capture correctly uses SKIP,
so this is availability recurrence, not recurrence of old ERROR mapping.

Current14otherchecksPASS independently. Native cleanup audit
336211298e68091114bca12fac48db73ed41e0ccc9d29bcd8b93424e04e5a8bd verifies
release; exact resources remain destroyed-provider-retained and retained
Hub owner obligation persists. The independently reviewed report-v3 has SHA256
2aab9c9b422d0fd2dcd3df55554b433905a88b11b099b68055d1a4d958060378;
the parent confirmation binds the exact native receipt and current authority.
No source/environment/provider
mutation or assertion/budget change. Parent owns canonical disposition.
