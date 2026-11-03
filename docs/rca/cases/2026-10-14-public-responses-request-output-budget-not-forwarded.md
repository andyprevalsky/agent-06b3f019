---
id: 2026-10-14-public-responses-request-output-budget-not-forwarded
date: 2026-10-14
title: Public Responses wrappers dropped the Rose caller output budget
surface: agents
component: rose-public-responses
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Rose caller budget omitted from Foundry and funded OpenAI wrapper invocations and HTTP bodies
symptoms:
  - max_output_tokens absent despite an explicit caller max_tokens budget
  - Requested 16384 and 32000 limits did not reach public Responses HTTP
tags:
  - foundry
  - openai
  - output-budget
  - request-contract
sources:
  - commit 53fc17e2c822be9331a9c79e3451a517f75e890a
  - PR #1453
repro: agents/tests/blackbox/rose.blackbox.py::test_wmh_foundry_preserves_requested_output_budget and test_funded_openai_preserves_requested_output_budget
status: fixed
---

## Problem

The WHM requested max_tokens=16384 through Rose.complete. The Azure Foundry
invocation omitted that argument. The funded OpenAI Responses route also omitted
it across Rose, _try_openai_api_key and openai_api_key_complete. Both public API
wrappers reused the Codex body builder, which deliberately omits output limits
for the subscription backend. Neither wrapper restored the public API field,
so the provider default applied instead of the caller's limit.

This is separate from the original Azure JSON-input HTTP 400, Cerebras context
overflow, shape-valid incorrect recipient/state claims and fundraiser failure.

## Diagnosis

Two permanently registered owning regressions reach actual serialized HTTP via
MockTransport without generating a reply. The Foundry test uses actual WHM
request construction and Rose.collect. The funded API test uses Rose.collect,
the API-key helper, its wrapper and post_openai_responses_stream.

The identical Foundry assertion failed before integration and passed after:
worker 0.174117s to 0.199172s, root baseline 0.477543s. Its literal callback SHA256
is 48a2e836c8aad1c47335b48f5d700dafdb15437ac58368486caeed1d7acb6c5b.
The funded API assertion failed before integration and passed after:
worker 0.018004s to 0.020285s, root baseline 0.238755s. Its literal callback SHA256
is 2940eabcc67496e2b0338a062069b06683913b4273cc2d455a09074924e316a7.
Both unchanged callbacks pass in the final actual registered Rose suite.

Controls cover explicit 16384/32000, omitted and None budgets. An explicit budget
changes only max_output_tokens; omitted/None bodies equal the previous converter
body. The existing registered Codex contract and independent source checks
preserve the shared builder and OAuth subscription path. Model references derive
from the existing pool configuration. Real sockets, DNS and default HTTPX
transport were denied; only owning MockTransport was allowed.

The pinned OpenAI 2.26.0 SDK documents max_output_tokens as a generated-token
upper bound including visible and reasoning tokens. Azure's saved official
Responses API reference exposes the field. These sources establish the request
contract, without proving live server admission or enforcement.

## Solution

Forward non-None caller budgets through the public wrapper hops and add
max_output_tokens only in those wrappers. Optional defaults preserve omitted/None
behavior. Keep shared Codex conversion, OAuth behavior, model routing, prompt,
context, schema, sampling, requested limits, timeouts and retries unchanged.

The final combined offline checks pass 242 WHM cases, 230 Rose cases, 10 cache
client cases and 2 stream contract cases: 484 total. One native service/build
case was excluded; these checks used the pinned agents Python 3.11.9 environment.

Restoring the requested cap can expose incomplete replies sooner than the old
provider default. The 32000 case proves direct caller propagation, not same-model
larger-limit recovery. A subsequent owning reproduction showed the old subscription-style skip also
prevented the configured larger-limit stage on newly capped public wrappers.
`test_public_responses_uses_existing_larger_limit_stage` fails on that source
(root 0.037265s) and passes with a narrow route-capability repair (worker
0.024332s): public Foundry and funded OpenAI retry the same model at the existing
32000 limit before fallback. Subscription behavior remains unchanged. This changes
the executed public retry sequence and can incur an extra paid attempt within
existing configured limits/deadlines; no numerical budget is increased.
Exact Azure non-strict open-schema admission, live cap enforcement and unchanged
fundraising benchmark PASS remain open. No paid qualification was performed.

## Human feedback

The user asked to use normal typed Rose LLM requests and find request-path gaps.
Infrastructure repairs are auto-approved; WHM context and runtime context logic
need explicit approval. This repair restores an existing caller parameter.
No new prompt, context acquisition, provider routing or retry policy is introduced.
Original captures, prior private proofs, protected instructions and Freedom are
preserved. No merge or deploy is authorized.

## Reusable lesson

Public API wrappers must restore caller parameters deliberately omitted by a
shared subscription-backend converter. Verify every wrapper hop against actual
serialized HTTP and preserve default-body parity rather than changing the shared
builder.
