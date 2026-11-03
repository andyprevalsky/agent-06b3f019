---
id: 2026-10-14-wmh-structured-consumer-bypassed-validated-recording
date: 2026-10-14
title: WHM structured replies bypassed canonical consumption and validated recording
surface: agents
component: wmh-rose-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: WHM content-only done guard and missing caller-owned structured cache write
symptoms:
  - Valid synthetic submit_response rejected as empty WHM content
  - Commentary included in native structured prediction
  - Structured WHM completion did not reach cache_set
tags:
  - wmh
  - structured-output
  - demo-cache
sources:
  - PR #1453
  - commit fda4bcb5ef2837c09073af8bc81b24bd45d78fb4
repro: agents/benchmarks/wmh_structured_cache_test.py
status: open
---

## Problem

With the newly authorized response model held identical on both controls, the
WHM content-only guard rejected normal synthetic tool replies and included
commentary. Rose deliberately defers recording structured replies until the
caller validates them, but WHM had no caller-owned validated write. The worker's
same 28 controls produced 13 failures on baseline and passed with the candidate.
This is an integration defect, separate from Run17's zero native cache hits.

## Diagnosis

The first bad consumption boundary concatenated content instead of using Rose's
structured item selection and synthetic-output decoder. The first bad recording
boundary ended after collect/native validation without the write required by
Rose's schema-mode contract. A Pydantic dump would also erase original duplicate
keys before native validation; therefore validation must use original bytes.

Golden owning code read: `RoseClient.collect`, `StructuredOutputAccumulator`,
`helpers.llm._content_from_structured_rose_response`, the normal caller's deferred
structured write, and `providers.fast_cache.rose_cache.cached_complete`.
Unifying with those consumers removes the redundant content accumulators.

## Solution

Both WHM guard paths use Rose's accumulator and decoder. An optional decoder
argument preserves original tool arguments and enforces WHM output cardinality;
its ordinary default is unchanged. Duplicate JSON keys, nonfinite values,
unexpected tools and conflicting final content remain rejected. Native validation
precedes the stock cache API call; cache replay never writes again. The key uses
normal request material including the response schema, exact call correlations
and unchanged policy identity. Existing owned recording/write policy is preserved.

Root's actual stock cache → Rose.collect → WHM controls pass for both text and
synthetic-tool recordings, with one mocked live stream, one write and a subsequent
hit. Wrong-call cached values reject without another live stream or write. These
use HTTPX MockTransport and a private in-memory API fixture, not the retained DB.
Two initial control errors used the wrong API endpoint and token-access shape;
their logs are retained and the corrected controls exercise batched get-many and
the native completion usage object. The final registered test is included in the
owning world-model-harness selector. Full native service/build coverage, actual
retained persistence and unchanged fundraising PASS remain open.

## Human feedback

The user authorized the missing output schema and requested an audit against
normal Rose calls. No context, retrieval, prompt, model selection, clock, sampling
or benchmark changes were made. The root rejected its own proposed blanket cache
disable check after the worker demonstrated it contradicted the existing approved
owned recording policy; no such check was applied.

## Reusable lesson

Consume structured responses through Rose's canonical selectors, validate their
original bytes natively, and perform the caller-owned cache write only afterward.
