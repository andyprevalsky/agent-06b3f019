---
id: 2026-10-27-code-session-fixture-observed-before-attachment
date: 2026-10-27
title: Code-session fixture measured keepalives before attachment and leaked its failed activity into the next case
status: open
surface: agents
component: code-sessions native blackbox fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tests/blackbox/code_sessions.blackbox.py starts its keepalive observation at the CLI journal before create-session returns and the activity attaches; failed observation then leaves the activity alive across fixture replacement
symptoms:
  - "attached sessions keep their sandbox alive: 2"
  - "AttributeError NoneType object has no attribute poll"
tags:
  - test-fixture
  - readiness
  - cleanup
  - keepalive
sources:
  - commit 46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277
  - plan:.context/deploy-fresh-20261027/rca-code-sessions/exact-pair-summary.json
  - plan:.context/deploy-fresh-20261027/rca-code-sessions/v2-validation-summary.json
repro: agents/tests/blackbox/code_sessions.blackbox.py::test_idle_past_every_old_limit_is_paused_not_failed_then_resumes
---

## Problem

At source46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277 the native coverage code-sessions domain failed `idle_past_every_old_limit_paused_then_resumes`: `attached sessions keep their sandbox alive: 2` (requires>=5). Its next case failed at SessionHome.start with `AttributeError: 'NoneType' object has no attribute 'poll'`. Original logs and manifest/results remain retained; copies are in this scratch directory. This is a native local fake-backend/loopback fixture failure, not evidence of a live sandbox/provider outage.

## Diagnosis

The first-bad observer boundary is CLI startup versus activity attachment. A local CLI can append runs.jsonl while the fake backend create-session response is still pending. The fixture starts its fixed2.5s observation from that file. A finite2.2s response delay leaves only about0.3s of attached monitoring; the real loop delivers two120-virtual-second keepalives then the fixture prematurely samples it. The native loop uses the unchanged120s keepalive interval and the fixture's existing2000x clock; no runtime clock or cadence was modified.

The assertion failure unwinds the fake backend's global patches and removes the sandbox process without cancelling/joining its activity. Captured first activity task140539435156096 survives initial home cleanup, then invokes close_session on backend1 (the next test) at81272.373610646. That method clears backend1's process while its start coroutine is polling it. This reproduces the reported second failure and proves a cascade, not an independent provider/startup defect.

A join-only candidate keeps the original count failure but makes all15 sibling cases pass. The complete candidate also moves the observation to actual attachment readiness and passes all16. This separates the two mechanisms. Original historical per-phase timings are not available; the bounded local response delay proves the boundary failure without claiming why original startup took its measured time or attributing it to load.

## Reproduction and verification

Native baseline command from agents (separate coverage/artifact paths under scratch): `coverage run --parallel-mode scripts/run_blackbox_tests.py code-sessions`. Baseline16 cases passed, domain17.4s; a pass is not a repair.

Causal same-command run: `bash .context/deploy-fresh-20261027/rca-code-sessions/run-native.sh`. It uses the same pinned coverage/native runner. bootstrap.py substitutes the single scratch test file through SourceFileLoader while preserving its original filename, imports and production source. Its instrumentation delays only the first fake backend response2.2s and records process/task ownership. All16 cases remain selected; backend/provider calls are stand-ins and WebSockets are loopback.

Before: domainFAIL19.6s, first requires>=5 but sees2; second sees cleared process. After V1 candidate: all16PASS18.7s with identical stimulus, superseded by coordinator review. The final identical-command V2 pair failed before (14 passed, 2 failed, 20.723s) and passed after (16 passed, 19.429s). Five V2 full-domain repetitions passed in 18.833, 18.780, 18.964, 19.176 and 18.918s. Final V2 receipts are in v2-validation-summary.json; V1 is superseded.

## Solution

Applied exact reviewed V2 candidate SHA256 `2b102443daf6c9509dfcd9cc428b05be4c927a716a32bb9be346c2f6076759eb`: bracket the first activity with cancellation/join while its own backend patches remain active; wait using the existing20s readiness helper until the first actual keepalive establishes attachment, then observe the existing2.5s in-flight interval. Keep the original>=5 assertion,2.5s interval,2000x scale,30s completion timeout and all cases. No runtime/prompt/production change. candidate-v2.diff is the exact coordinator-reviewed applied patch. V1 waited for five keepalives and was rejected by the coordinator because it pre-satisfied the count; only V2 is proposed for application.

## Archive relationship / references

Literal and behavioral searches retained in archive-literal.txt/archive-behavior.txt; exact rg for test names and error found no existing exact case. Related2026-10-23-claude-cli-initialize-deadline-shorter-than-cold-start concerns the production CLI handshake, a different first-bad boundary; its Solution/Human feedback were read. Parent should append to any independently identified matching recurrence; this scratch draft does not claim that unrelated case recurred.

Read local references: Codex sdk/python/tests/app_server_harness.py174-188 uses bounded observation of actual request count; OpenClaw src/music-generation/runtime.resources.test.ts167 awaits provider-start before lifetime assertions; Hermes tests/agent/test_deadline.py375-396 cancels/awaits the owner and confirms the inner operation cancelled; Kimi packages/klient/test/ipc.test.ts103-108 closes resources in finally; Claude src/services/mcp/client.ts1565-1568 awaits transport close. These support readiness and joined ownership, not any altered Rose runtime budget.

## Coordinator constraints

The active assignment requires retaining>=5, all deadlines and cases; no speculative scheduling diagnosis; proving whether the later failure is a cascade; no shared edits until coordinator review; parent alone owns archive/index/full gates. It permits bounded native local fixture runs. Freedom must remain intact. No new agents/worktrees or live provider/DB operations were used.

## Reusable lesson

Start lifecycle assertions from the consumer's observed readiness and join every owned activity before replacing its fixture or restoring its mocks.


## Final V2 verification supplement

The first-keepalive V2 passed the identical-command full16-case native coverage pair and five consecutive full-domain repetitions. Zero and one keepalive negatives fail and preserve all15 siblings. See RESULT.txt and v2-validation-summary.json for measured values. V1 results are superseded and must not be cited as V2 verification. The coordinator applied the exact candidate after all batch-2 commands exited. Full canonical agents coverage and deployment remain pending; narrow native passes do not certify those gates.

## Human feedback

No additional user feedback was recorded for this fixture. The coordinator rejected waiting for five keepalives before the measured interval, then accepted readiness on the first keepalive only after zero/single-keepalive fault controls preserved the count assertion.

## Combined-run observation on October 27

Batch 3 at e8e8cff1 passed this corrected first test and the following case; the domain then failed a distinct synthetic resize readiness case. The first-case count and cancellation/join correction remain covered. Full combined acceptance is still pending. The resize first-bad boundary is recorded separately in 2026-10-27-resize-fixture-request-preceded-cli-conversation.
