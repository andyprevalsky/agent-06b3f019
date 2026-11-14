---
id: 2026-10-31-r142-background-browser-spawn-accounting
date: 2026-10-31
title: Background browser start receipts were counted as generic spawns
surface: harness
component: benchmark-logical-tool-count
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _logical_tool_count_key ignores producer-issued backgroundAgentType on the background start receipt
symptoms:
  - expected spawn_browser_agent count one but got zero
  - hidden FINISHED spawn_agent has backgroundAgentType browser
  - native PAUSED and progress zero remain a separate failure
tags:
  - r142
  - logical-tool-count
  - background-browser
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - agent c2aefaf5-4b2d-4a56-ab37-80a90f57c625
  - plan: original run SHA95959d7b3817e180200a2c0ef07e128a79c90605a9acf23cb536ef9a4b26ee8e
repro: registered logical_tool_counts_typed_background_browser original-message fixture
status: open
---

## Problem

It33 R141 task polar-odysseys-1211fbaa6464 ran on715/patchnone. Original message4 records a FINISHED background browser start, with runInBackground=true, backgroundAgentType=browser and identical backgroundTaskId/toolCallId. It is hidden from the UI, but still records a logical invocation. The native task remained PAUSED/progress0 and failed; accounting does not explain or repair the pause.

## Diagnosis

All seven original normal files and full run SHA95959d7b verify; the extracted fixture message equals the original message4. The exact original counter on the first295 messages returns agent_init1/spawn_agent1/browser_session_auth2. The workflow producer stores type in backgroundAgentType for this path; the counter recognizes only agentType=browser or the model-facing requested-call type. The first bad transformation is therefore at the logical count key, not absent browser execution.

The producer is BackgroundTaskMixin._start_background_spawn, which emits this typed hidden start receipt under the same call ID before launching the executor. AgentWorkflow._handle_tool_event preserves its metadata. The existing background_tasks consumer already reads backgroundAgentType. A hidden row alone is not sufficient browser evidence, and a start receipt does not certify task completion.

## Solution

Candidate8c0d43f8df60f856e1709cd4834ee312f35a2e2d59d2a2a3325073df07310a63 normalizes the producer-bound browser type in the existing key function. It requires the true background marker and matching nonempty string task/call ID, and rejects conflicting canonical type. It retains the existing dedup set: a model request, repeated start and completion under one ID count once. It does not change task criteria, native step budget, pause behavior, UI visibility or original grades.

The identical actual-counter reproduction fails on715 and passes on the candidate. The permanent registered original-message test likewise fails then passes unchanged. Seven counter tests pass, including progress, cache, exact-count failfast, minimum/forbidden checks and model-facing routing; five consecutive new-regression passes were recorded. The original prefix becomes agent_init1/spawn_browser_agent1/browser_session_auth2 with no other count changes. Independent reviewer B qualified the exact8c0d43f8 snapshot after separately verifying all7 original members, message4 and the full295-message prefix; seven registered controls and additional identity negatives passed. Integration remains coordinator-owned and pending. The full benchmark outcome remains OPEN; no rerun or task-PASS claim is made.

Delete/unify: removing the background receipt would change workflow/UI/inbox semantics. Another counting pass would add a second dedup authority. Unifying the current key derivation with the existing producer contract avoids both. Conflicting or malformed metadata is not guessed from goal, title or address text.

Two exact-source archive searches covered backgroundAgentType/logical_tool_count_key and browser-spawn/logical-count symptoms. The Eventim count-key case and the August3 Amazon passkey case's accounting section were read, including Solution/Human feedback. This is a related missing representation in the existing normalization; it does not repeat Eventim's task-definition change or provide passkey proof. Golden external references: not applicable to this ordinary local producer/consumer accounting correction; exact producer, persistence and existing consumer sources are in the review packet.

## Human feedback

The user prioritizes native failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

Normalize every producer-supported typed invocation into one logical count key, while keeping invocation accounting distinct from task success.
