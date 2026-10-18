---
id: 2026-10-15-validation-capture-scope-retained-global-drain
date: 2026-10-15
title: Request-scoped validation capture test retained a global quietness prerequisite
surface: harness
component: agents-blackbox-capture-isolation
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: testBoundary_validationShortCircuitNoOutbound awaited a global capture drain before creating its request token or sending the invalid POST
symptoms:
  - Agent boundary capture buffer did not drain before validation short-circuit
  - https://openrouter.ai/api/v1/chat/completions
  - Validation failure should make 0 outbound calls
tags:
  - blackbox
  - capture
  - request-isolation
  - concurrency
sources:
  - PR #1510
  - commit 8a18144fb9dd503f65d964edf25b95f1acbe4dce
  - task .context/lantern-deploy-preflight/.context/test-runs/backend-coverage-failed-20261015-211819-1697884
  - task .context/lantern-deploy-preflight/.context/preflight-artifacts/agents-capture-rca/final-manifest.json
  - task /tmp/lantern-agents-capture-independent-final.json
repro: cd back-end && node --import tsx src/tests/unit/agents-boundary-capture-isolation.test.ts
status: fixed
---

## Problem

The normal backend coverage run on 8a18144f exited 1 after 509.6 seconds:
273 unit files passed and 198 of 199 blackbox domains passed. The agents domain
reported 244 passing checks and one failure. Its validation short-circuit case
failed while draining global captures; the remaining URL was OpenRouter chat
completions. Coverage thresholds and the mandatory teardown regressions were
not reached. The failed run's five recorded processes retired and both owned
backend ports closed through normal cleanup.

The failure happened before creating the validation request's capture token or
sending its invalid POST. It therefore does not establish that product validation
made an outbound call. The original URL-only failure message does not establish
which prior or sibling request produced that capture; that identity remains an
observability gap.

## Diagnosis

The case already gives its invalid request a unique `X-Capture-Token` and reads
only captures carrying that token. Token-filtered reads do not depend on the
global clear baseline. However, a preceding helper still required the shared
buffer to become globally quiet over eight 500-millisecond observations. Valid
traffic from another owner could fail that prerequisite before the request under
test ran. The global helper originated in ec909c440; b75d290444 later introduced
request-scoped assertions without removing the obsolete prerequisite.

The checked-in regression invokes the actual registered blackbox function,
native loopback HTTP, the real fetch-capture wrapper and the real
AsyncLocalStorage token middleware. An independent tagged owner completes an
OpenRouter capture before each capture observation. With the original helper,
the identical regression command exits 1 with the same global-drain error before
the invalid POST. With the helper removed, it exits 0. A second invocation makes
the invalid request itself emit a matching-token call and still rejects with
`Validation failure should make 0 outbound calls, got 1`.

Only external transport and local authentication/400-response fixture endpoints
are fake. This proves the registered test's capture-isolation contract, not the
production router's validation implementation or the original capture producer.
No external provider, real account or database query is needed for the replay.

Archive searches used the exact drain error and the behavioral terms
`validation short circuit capture contamination OpenRouter`. The October 3
GitHub first-capture selection case is related, but its faulty URL selection is
a different first-bad boundary. Relevant capture/test files were byte-identical
between the earlier ef90 candidate and 8a18144f. No separate in-flight targeted
repair was found.

The reference search covered Claude Code, OpenClaw, Hermes and Codex. The
applicable pattern is context-local attribution: Claude Code
`src/utils/agentContext.ts:15` explains why shared state cannot identify concurrent
agents; OpenClaw `extensions/feishu/src/client.read-authority.test.ts:46` scopes
real transport work through AsyncLocalStorage; Hermes
`agent/delegation_context.py:29` restores child-local context. Codex's task-local
OAuth budget is a different concern, with no direct shared-capture test analog.
The repair follows context ownership already implemented in Rose rather than
introducing another synchronization mechanism.

## Solution

Delete only the obsolete global-drain helper and its invocation. Preserve the
actual invalid POST, HTTP 400 check, error-response schema, capture-endpoint
HTTP 200 check, token filter and zero matching outbound assertion unchanged.
Do not clear intended-request calls, loosen the predicate, add a delay, increase
a deadline or alter product/provider behavior.

Add the causal replay and matching-token negative control to the normally
auto-discovered unit family as `agents-boundary-capture-isolation.test.ts`.
The formatted test was run unchanged against the original and repaired fixture:
exit 1 before, exit 0 after. The independent reviewer ran the same tiny owner
once, observed exit 0 and verified both file hashes before and after. The normal
unit runner recursively discovers this filename, and the agents blackbox domain
continues invoking the same registered boundary function. TypeScript, affected
ESLint, formatting and diff checks passed on the frozen two-file patch.

The original full backend failure remains failed evidence. These local checks
do not substitute for a fresh complete backend coverage run on the adopted
checkpoint, including thresholds and teardown regressions. The repair changes
tests only and adds no per-agent production work.

## Human feedback

None recorded.

## Reusable lesson

Assert request-owned outbound effects with the existing capture token instead of requiring unrelated concurrent traffic to become globally quiet.
