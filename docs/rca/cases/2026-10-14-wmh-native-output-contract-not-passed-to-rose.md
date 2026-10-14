---
id: 2026-10-14-wmh-native-output-contract-not-passed-to-rose
date: 2026-10-14
title: WHM did not pass its native output contract to Rose
surface: agents
component: wmh-rose-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseWMHProvider._complete_async prediction_request omitted response_model
symptoms:
  - response_model missing from WHM collect
  - json_object rather than defined native json_schema
  - Actual WHM request must carry its typed native output schema
tags:
  - wmh
  - structured-output
  - rose
sources:
  - PR #1453
  - commit fda4bcb5ef2837c09073af8bc81b24bd45d78fb4
  - benchmark run wmh-run17-retry1-e9afcffd-1791943658
repro: agents/tests/blackbox/rose.blackbox.py::test_wmh_native_response_model_reaches_foundry_http
status: open
---

## Problem

WHM validated its native output contract after generation but omitted the
`response_model` argument to Rose. Its JSON flag selected generic `json_object`.
The first retained Run17 request also encountered Azure JSON-input admission
failure. These are separate findings: the missing producer argument is proved;
new upstream schema admission and the fundraiser's timeout are not resolved by
an offline mock.

## Diagnosis

The same registered callback fails on the frozen source and passes with the
repair through actual WHM message construction, Rose.collect and Foundry's HTTP
converter under MockTransport. It covers the WHM JSON flag both on and off and
preserves ordinary JSON-object calls. A second control holds the exact archived
Rose messages from the first Run17 invocation and reconstructs HTTP conversion.
The original serialized HTTP request was not captured; no reply was invented.

The deeper owned gap is that the existing native contract was supplied only in
policy text and the post-generation parser, outside Rose's typed request path.
The fix unifies request construction with that path. Native validation still
owns call identities, all branches, probability totals, patches and state.
Read-only corpus checks preserve all 251 valid outputs and reject all 105
rejected attempts, including 19 that satisfy shape but fail native semantics.

## Solution

`wmh_response_schema.py` declares the existing timed, untimed and native-v3
shapes. Known protocols pass their model to Rose; unknown/legacy protocols keep
their previous request. Private captures include JSON-safe model/schema metadata.
There are no prompt, instruction-placement, retrieval, fixture, policy, sampling,
provider-order or timeout changes. The previous instruction-placement proposal
R17-FOUNDRY-INPUT-1 is set aside.

Arbitrary JSON patch values and open native state maps require the existing
`rose_openai_strict=False` adapter, also used by Rose's verifier. Strict schema
adaptation would narrow those values. This declares an output schema with local
validation; it does not prove provider-enforced grammar or acceptance of this
exact open schema by Azure. Azure's documented strict subset and the pinned SDK's
optional strict flag do not settle that question. Live admission and the unchanged
benchmark outcome remain open.

Golden sources read: `agents/providers/rose/schema.py`, the open-object verifier
model in `agents/helpers/llm.py`, and pinned OpenAI 2.26.0 response-schema types.
They prove local construction. The available Claude structured-I/O source is a
different protocol; other reference checkouts were absent and were not installed.
Independent bounded contract and runtime reviews passed. Root's final offline
checks passed 242 WHM cases and Rose's 228 cases, plus cache/stream suites; the
native service/build case was deliberately excluded. Proofs are privately archived
through the schema-integration handoff receipt.

## Human feedback

The user asked why WHM requested generic JSON instead of a defined output schema,
then explicitly authorized fixing the omission and auditing normal LLM-request
parity. Infrastructure repairs are auto-approved; unrelated WHM context changes
require approval. No new paid trial, merge or deployment was performed.

## Reusable lesson

Pass the existing typed native output contract through Rose and retain native
contextual validation without narrowing arbitrary JSON values.
