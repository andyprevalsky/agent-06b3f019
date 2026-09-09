---
id: 2026-09-09-planner-memory-sanitizer-context-free-regexes
date: 2026-09-09
title: Context-free memory redaction treated dates and public URL identifiers as private data
surface: agents
component: planner-memory-sanitizer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/planner_memory/bundle.py redact_reference_text
symptoms:
  - "phone number leaked: +19729777432"
  - "phone number leaked: 2026-09-11"
  - "[REDACTED-PAN] inside a public numeric URL"
  - "sensitive query values survived inside URLs"
tags:
  - planner-memory
  - pii-redaction
  - url-structure
  - luhn
sources:
  - plan:agents/benchmarks/runs/memory-compressor-20260909T180703Z.json
  - plan:agents/benchmarks/runs/memory-compressor-20260909T184905Z.json
  - plan:agents/benchmarks/runs/memory-compressor-20260909T211210Z.json
repro: agents/tests/blackbox/planner_memory.blackbox.py
status: fixed
---

## Problem

The production memory sanitizer both leaked private data and damaged valid
trajectory facts. The unchanged 74-case compressor run at
`memory-compressor-20260909T180703Z.json` passed 69/74: two records retained
`+19729777432`, the ISO date `2026-09-11` was classified as a phone number, and
a public TikTok video identifier was replaced with `[REDACTED-PAN]`. An
additional owning-boundary fixture showed that query values such as
`?email=andy%40example.com` and `?card=4242424242424242` bypassed prose-only
redaction.

The critical path was `archived message metadata and text -> trim_rows ->
redact_reference_text -> compressor payload -> CriticalPath -> memory injection`.
The first wrong value appeared in `redact_reference_text`, before the LLM call.
Archive searches for `phone number leaked`, `REDACTED-PAN`, and
`planner-memory pii URL` found no prior matching cause; this was a novel case.

## Diagnosis

`bundle.py` applied phone- and card-shaped regular expressions without parsing
URLs, validating card checksums, or excluding ISO dates. That made an arbitrary
long numeric URL path indistinguishable from a payment card and allowed encoded
PII in query parameters to avoid the prose patterns. The deepest owned cause
was using context-free patterns at a structured-data boundary; this also made
any future account ID, order ID, or encoded secret vulnerable to the same two
failure modes.

## Solution

URL spans are now parsed and transformed separately from prose. Sensitive
query keys and values, credentials, email addresses, E.164/formatted phones,
and Luhn-valid PANs are redacted inside URLs; non-Luhn public numeric IDs and ISO
dates remain intact. `inject.py` also sanitizes stored goals and the completed
rendered block so old or imported caches cannot bypass the fixed write path.

Permanent coverage lives in `agents/tests/blackbox/planner_memory.blackbox.py`
(`scrub_pii_and_secrets`, `scrub_numeric_urls_dates_e164`, and
`scrub_sensitive_url_values_and_goals`). The post-fix command
`cd agents && python3 tests/blackbox/planner_memory.blackbox.py` passed, and
the same production compressor entrypoint, `cd agents && python3
benchmarks/run_memory_compressor_bench.py --concurrency 4`, produced the final
cp-v7 report `memory-compressor-20260909T211210Z.json`: 74/74, including 11/11
large traces, with a maximum 10,356-message input. No network call was added to
the planner hot path.

## Human feedback

None recorded.

## Reusable lesson

Parse structured spans before redaction and validate ambiguous numeric values with their domain checksum instead of shape alone.
