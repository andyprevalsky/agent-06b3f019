---
id: 2026-10-29-spawn-output-schema-wire-omission-rejected-browser-start
date: 2026-10-29
title: Generic spawn schema allowed omission of the output contract required by browser runtime
surface: agents
component: spawn-agent-json-schema
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SpawnAgentTool exported output_schema as omittable on the native wire although browser runtime required a value, so Kimi calls accepted by the wire contract failed before browser creation
symptoms:
  - "output_schema is required when type='browser'."
  - "All 1 waterfall models failed for pool rose-1-oss"
  - "Expected isolated browser session metadata was not observed"
  - "No browser agent trajectory was recorded"
tags:
  - spawn-agent
  - output-schema
  - native-tools
  - webdecoy
sources:
  - commit b962a7b02a836e8a9ce775f3fb433dd5b9db5fbd
  - commit 28ba7952dcc7b14628e7dc602e96d4e74d35193b
  - agent 87fef157-8807-4cf2-a7e9-536d6824d1ff
  - plan:.context/deploy-fresh-20261027/group4-final-b962a7b02a83/rca-webdecoy/required-nullable/FINAL.json
repro: agents/tests/blackbox/rose.blackbox.py
status: open
---

## Problem

The unchanged browser-biometrics-webdecoy task failed in45.3s on sourceb962,
with9messages and no browser trajectory. The root tried to spawn a browser to
complete the public FCaptcha demo, but the native tool calls never passed
argument validation. This is not a biometric score or CDP failure.

## Diagnosis

Root87fef157-8807-4cf2-a7e9-536d6824d1ff first reached execution at03:25:28.9Z.
Foundry returned deployment_disabled for DeepSeek-V3.2, so the configured
rose-1-oss waterfall served Kimi-K3. Six successful native Kimi responses omitted
output_schema. The first was rejected at03:25:36.343228Z, worker.7.log108.
After three failed LLM activities the root became FAILED at03:26:05.890419Z.
The evaluator subsequently reported missing isolated-browser metadata and zero
steps. The Foundry configuration error is a separate captured upstream event;
this correction does not claim to repair it.

The captured generic spawn JSON schema listed type/task_name/goal as required
and allowed output_schema to be absent. Its description did say it was required
for browser/code/general-purpose/for-each, and the Pydantic runtime enforced that
condition. Local replay of the exact arguments proved the wire schema accepted
the omission while the real runtime rejected it. A conditional allOf prototype
was rejected because the native schema projection dropped that metadata; no
conditional-provider feature was assumed.

Archive searches covered literal output_schema-required/browser and behavioral
spawn/optional/required/nullable. The browser-start-url and startup-verifier-schema
cases were read through Solution and Human feedback. They are relatives, not the
same boundary; this change does not infer a missing output contract or silently
continue without it. No model-intelligence diagnosis is claimed.

## Solution

A JSON-schema-only hook marks output_schema required on generic SpawnAgentTool
and NoGP schemas; desktop and planner subclasses inherit it. Its existing type
remains nullable. The explore-only PLAN tool is unchanged. Runtime validators
still reject browser missing/null; generic explore can use explicit null and
existing programmatic omission remains accepted. No schema value is generated
for a model, no prompt changes, and no strict flag or provider setting changes.

Root applied reviewed patch3c945808d7c8041edd65b68a355988cd8b9a35ef7fc3435f11621be072b6ded7
in28ba7952. This repairs the declared wire contract. Actual non-strict Kimi
compliance and the unchanged WebDecoy outcome remain open.

## Design choices

The existing generated-schema boundary forwards required keys to native
OpenRouter, Responses, Anthropic and Cerebras adapters. Required-nullable
encoding avoids a new conditional keyword and preserves the existing generic
explore exception. Cerebras now retains the existing null branch because the
key is required. A blanket provider strict mode, fabricated default output,
model change, prompt nudge or relaxed browser validator was not introduced.

Independent review GROUNDED exact3c945 against Codex required-nullable output,
OpenClaw authored-schema/strict-mode separation, and Hermes required-argument
validation. Contrary direct-Moonshot null stripping is recorded; this route is
OpenRouter and already carried the null union. At10k-agent scale the change is
one list append during schema construction, without network, queues or locks.
Production trajectory exposure is unmeasured, not zero.

## Verification

The registered native Rose domain uses five adapters and all generic spawn
model variants. It checks explicit required-key and nullable wire encoding,
unchanged browser missing/null rejection, valid browser output, generic
explore-null/omission, and unchanged explore-only omission.

On identical final fixture04be3419679a483f0b7e14a146e6339926b3aad9c5227e7166ad420963849575
and native run_blackbox_tests.py rose argv: original259PASS3FAIL in9.4s;
candidate262PASS in9.6s. Removing only NoGP's hook gives261PASS1FAIL at the
new required-key control; candidate source was restored afterward. Two prior
assertions were deliberately strengthened to the new contract: required-list
includes output_schema and required Cerebras output retains null. The other1159
old assertion ASTs remain;11 were added. No all-old-assertion identity claim.

Full canonical agents coverage on28ba completed04:00:01Z, exit0,474.1s:
123domains,214cache tests,173unit tests;85percent coverage against80threshold.
This is a fresh full native command, not composition. The exact test processes
joined; no paid inference was used in the local causal proof.

An initial private source copy included large tracked benchmark history and
exhausted disk. Only that incomplete private copy was removed and code-only
inputs rebuilt. Original active-run ENOSPC failures and partial cancellation
receipts remain recorded; they are not erased by this schema proof. Setup-only
missing-import attempts are retained and excluded from final native counts.
No production or Mac acceptance is claimed.

The unchanged full smoke rerun on source
28ba7952dcc7b14628e7dc602e96d4e74d35193b reached real browser execution
for root c0728173-3be3-4462-bffd-131d1930b275, then failed at the original
420-second task bound (424s recorded duration, final status PAUSED). This is
a distinct later outcome, not the original 45-second missing-key rejection.
No runtime cause is established for that timeout. The cohort was later
interrupted for material main integration, native and outer exit 130, with
matching benchmark and stack cleanup receipts clean. This case therefore
remains OPEN for the exact complete benchmark outcome.

## Human feedback

None recorded for this schema correction. The coordinator authorized the narrow
wire change and two stronger test expectations; those are review constraints,
not additional direct human feedback. Separate user overrides for an observed
Kernel permission failure and two old mints do not waive this task.

## Reusable lesson

When a runtime requires a nullable field for a generic tool, distinguish an
explicit null from an omitted key in the emitted schema and test every native
adapter; textual guidance alone does not establish a wire contract.
