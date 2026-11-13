---
id: 2026-11-11-python-archive-completion-clock-rejected-as-call-order
date: 2026-11-11
title: Python async archive completion clocks were rejected as call-order violations
surface: back-end
component: archive-llm-materialization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: archiveLlmMaterialization.ts groupCalls assumes every producer acknowledges its base encryption before update encryption, while Python observability submits independent archive executor jobs
symptoms:
  - Orphan or pre-base archive update
  - Archived LLM dump recovery failed
  - Matching updates have encryption completion clocks seven and twenty-four milliseconds before their bases
tags:
  - llm-dump
  - python
  - archive
  - async
  - clock
sources:
  - commit 4f00a16d3e58ba76e41f4aae5f9d9644e5b425c5
  - agent 8ae16570-27ba-4749-a783-8fb5c80792bc
  - fleet run 20261111-041150-2774998
repro: back-end/src/tests/blackbox/archive-llm-materialization.blackbox.ts through the unchanged normal blackbox runner, plus local replay of the original thirty-four encrypted objects
status: open
---

## Problem

The ordinary `4f00a16d3e58ba76e41f4aae5f9d9644e5b425c5` smoke campaign completed all fourteen graded tasks successfully and closed all fifteen canonical cleanup/source-consumer claims. Thirteen evidence publishers passed. The final mass-agent root's supplemental publisher exited one with `Orphan or pre-base archive update` and `Archived LLM dump recovery failed`. Its original 131-byte log has SHA256 `4160144b7e1f0fea5f00702f552bfc007d182d8ad683d18e951fe2aed59928e9`. The mass durable LLM evidence remains blocking; task grades and verified cleanup are separate facts.

## Diagnosis

**Gate: NOT_INTRODUCED relative to main `8046dcbc3a67e7d4241d8eb6171b5c1652b85f71`.** The compared Python observability writer, Python archive executor and TypeScript materializer are each byte-identical on main and the failed source. Their respective SHA256 values are `a004eaf579afdb961294ca4f1ca1e229c4bb5f97b2cafb572476ad8f9d66ab95`, `f935926edb5a81b911af7b8825962c2c0caf87188eea2f3f6f8c5ad202c1b181` and `5dd02a1b80ab7a9b3848e7e5dfa57738a60c5b71d8373a2f457aa64c247b0931`. This attribution does not waive the assigned recovery or make the failed publisher successful.

The path is Python `dump_llm_context` / `update_llm_dump` → `archive_json` → independent executor jobs → real gzip/AES-GCM encryption and immutable archive storage → strict envelope decryption → `groupCalls` → publisher. The retained cache contains seventeen bases and seventeen updates, with no orphan keys or duplicate bases. All envelopes validate and decrypt before the actual guard refuses two matching Python partial updates. Their recorded encryption completion timestamps precede their bases by exactly 24 ms and 7 ms. Both belong to the same subagent (ID SHA256 `9b62308659971950edff595dd7d2b8c9d397f38abe0f72592871268d574f2be3`). The remaining sources include the distinct Node UUID/ordinal protocol.

Python returns the expected archive reference immediately after submitting a base job. An update can consequently submit and complete encryption on another executor worker before the base encrypts. `encrypt_artifact` records `created_at_ms` after compression/encryption, so these clocks do not attest base/update submission order. Node's separately implemented writer does wait for its base acknowledgement; its strict chronology rule remains applicable. The consumer incorrectly imposed that rule on both protocols.

Two local proofs establish the boundary without network, database or model calls. First, the canonical materializer replays all original encrypted bytes and metadata from the retained cache and fails with the exact publisher error. Before/after seals prove all 103 original cache files unchanged. Second, the real Python async submission, executor, encryption, local transactional store and root drain reproduce an 11 ms inversion when a deterministic scheduling barrier delays the base before real encryption. The clock and cryptography are unmodified. This proves the producer mechanism; it does not reconstruct the historical thread interleaving.

Archive searches used `Orphan or pre-base archive update` and `async archive encrypt timestamp completion order`. The November 10 backend plaintext-guard case is related, but its first-bad boundary was an absent Node producer; here all base and update objects exist and authenticate. Its Node base-ACK, equal-time ordinal ordering, privacy and root-drain controls must remain intact. The November 7 partial-async-state fixture case concerns assertion setup, not these authenticated production records. No prior case substitutes for the two executed local proofs.

## Solution

**Ignored candidate only; canonical application, independent review and publication acceptance are pending.** A narrowly typed consumer branch recognizes only an exact lowercase twelve-hex Python base filename matching its dump identity, a valid base messages/count/call-site record, and a canonical matching Python timestamp/call-site update filename containing only production partial-patch fields. Root, agent and dump identities must all match. Only that positive protocol can interpret a pre-base encryption completion timestamp. Missing bases, duplicate bases, foreign identities, malformed names and replacement base messages still refuse. Node UUID/ordinal updates keep their original pre-base guard.

The consumer preserves every original ciphertext, metadata timestamp and decrypted record, and records an explicit `python-async-partial-patch` completion inversion fact in the private source proof. It does not retimestamp, filter, reorder to hide the failure, synthesize a base, or grant task/publication credit. The ordinary source ordering, update merge, base-call chronology and latest-call selection remain unchanged.

The new automatically discovered owning blackbox uses the captured seventeen base/update clock triples with synthetic identities and payloads. The unchanged normal runner observes RED on the original consumer and GREEN on the candidate, with ten controls including orphan, duplicate, foreign root/agent, wrong dump, malformed path, base replacement, Node pre-base refusal and Node equal-millisecond ordinal ordering. Original Node archive blackbox and original materializer unit/CLI controls are retained unchanged. Selected strict TypeScript and normal ESLint checks apply to the two changed TypeScript files; no rule or assertion is disabled.

The complete native cache also changes from the exact original rejection to seventeen materialized calls and seventeen applied updates, with precisely two interpreted completion inversions, zero network calls and all 103 original files unchanged. That local replay is causal recovery proof, not a canonical publisher retry or a new deployment result. The original publisher failure stays immutable. Normal durable publication and retrieval on the coordinator's reviewed source are still required before closeout.

## Human feedback

The existing human requirements preserve actual task outcomes, complete durable evidence, source ownership, privacy, original receipts and all assertion/time/concurrency budgets. The coordinator delegated cached-only RCA and explicitly prohibited new provider/R2/HTTP reads, task or publisher retries, credential fallback, tracked source edits and a competing deployment. The coordinator authorized an ignored candidate limited to the positively typed Python partial-patch protocol, retaining the Node/orphan/duplicate/envelope guards and original metadata. Those bounded implementation choices are coordinator constraints, not additional human approval or a claim of completed native validation.

## Reusable lesson

An artifact encryption completion clock is not a producer-independent causal ordering proof. Interpret each authenticated producer protocol explicitly while retaining its immutable original records and refusal rules.
