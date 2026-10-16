---
id: 2026-10-15-cerebras-projection-assumed-string-mapping-keys
date: 2026-10-15
title: Cerebras strict projection leaked TypeError for raw Python schema mapping keys
surface: agents
component: rose-cerebras-schema
classification: our-bug
problem_class: other
first_bad_boundary: agents/providers/rose/cerebras_schema.py object_properties counted len on non-string property names before validating them
symptoms:
  - "TypeError: object of type 'int' has no len()"
  - "cerebras_native_tools_incompatible_visible"
  - "cerebras_raw_schema_keys_native_client"
tags:
  - cerebras
  - schema
  - validation
sources:
  - PR #1510 review comment 4289126749
  - commit 19b3f5bb924e4354f0d9908136b94c54a6b2bd71
repro: agents/tests/blackbox/rose.blackbox.py
status: fixed
---

## Problem

CodeRabbit found a conservative-projection escape for Python-built schemas with integer property names. Normal offline `python scripts/run_blackbox_tests.py rose` from activated agents venv reproduced221 passes/2 failures at19b: existing projection family with new malformed-key vectors and a new registered public-client regression both raised the exact TypeError before HTTP. This is raw-input boundary hardening, not an observed Lantern failure or evidence of a live Cerebras remedy. Canonical Pydantic JSON schemas do not emit these invalid names.

## Diagnosis

`RoseClient.complete(tools=...)` accepts raw nested dictionaries. `_openrouter_tools` retains the parameters dictionary; `cerebras_complete` invokes `build_cerebras_body` before transport. `object_properties` assumed every property key supports len, while the conservative adapter catches only intentional ValueError. The same missing key invariant lets non-string schema keywords fail during unknown-key sorting/string construction. The actual complete-to-mocked-HTTP regression proves reachability, not merely a direct private-helper call. Ordinary JSON serialization already stringifies integer keys; no new serialization or coercion is introduced.

Archive searches "Cerebras non-string schema property key TypeError" and "conservative schema projection malformed fallback" found no same-boundary case. Existing numeric/required checks are related input hardening, not a prior repair for keys. All-branch history and open-PR search were checked before implementation; the finding remained present at19b.

## Solution

Validate string property names before counting them, and string schema keywords before set/sort operations at every walked node. Raise intentional ValueError into the existing visible non-strict path. Do not catch arbitrary TypeError, rewrite keys, close maps, or change original schemas, uniform all-or-none strict selection, local Pydantic validation, routes or retries. Invalid raw schemas may still be rejected later by ordinary JSON serialization/provider validation; this adapter does not promise to make malformed inputs valid.

The SAME normal rose command then passed223 checks. Broader normal `python scripts/run_blackbox_tests.py rose llm` passed223 Rose and228 LLM checks in13.3s, all HTTP mocked. Regression vectors include root/nested schema keywords and integer/boolean/null/tuple property names; existing compatible strict and immutable fallback assertions remain. Public-client control asserts one Cerebras request, strict=false, ordinary serialized parameters unchanged, caller input immutable and no other route. Ruff, format and compile checks passed. No paid calls, provider/DB work or benchmarks were launched.

Golden reference: `openclaw/src/agents/code-mode-mcp-api.ts:197` consumes Object.keys(properties), whose JavaScript keys are strings by construction. Python raw mappings lack that invariant; validating it explicitly converges on the same string-key boundary without normalization. Runtime work adds linear key validation only, no global state, I/O, per-agent storage or new contention at10k agents.

## Human feedback

None recorded.

## Reusable lesson

Validate raw mapping key types before schema accounting and preserve the adapter's explicit unsupported-schema path without rewriting caller data.
