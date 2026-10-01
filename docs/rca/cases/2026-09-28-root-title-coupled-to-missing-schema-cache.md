---
id: 2026-09-28-root-title-coupled-to-missing-schema-cache
date: 2026-09-28
title: Completed mass-agent root had no title after response-schema cache miss
surface: agents
component: helpers/finished.py mark_finished
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/finished.py mark_finished persisted COMPLETED without deriving a title from verified structured output
symptoms:
  - "Declared evaluator t7-meaningful-task-title failed: Root task title is missing"
  - "Strict read-only benchmark cache miss for response_schema"
tags:
  - fast-cache
  - response-schema
  - generated-title
  - mass-agent
sources:
  - agent 680fd6e2-4c5e-4aa9-acf0-55ec1ff2f976
  - benchmark run fb70e869-bd6b-44cc-b6b2-ea5938f54423
repro: agents/tests/blackbox/finished.blackbox.py
status: fixed
---

## Problem

The exact local `test-mass-agent-run-0` run completed its root and all 50
first-level children in 384.5 seconds, with zero live LLM spend and 13 of 14
declared evaluators passing. The remaining evaluator rejected the root because
`Agent.title` was null. The run record is
`agents/benchmarks/runs/20260929_014123_test-mass-agent-run-0.json`; its root
is `680fd6e2-4c5e-4aa9-acf0-55ec1ff2f976`. Its
[durable FE viewer](https://www.roselabs.ai/?agent-id=680fd6e2-4c5e-4aa9-acf0-55ec1ff2f976)
was verified reachable with 268 messages after the 45 MB run bundle upload
retried through transient TLS EOFs.

## Diagnosis

The runtime tree had 51 `COMPLETED` agents and a final root Task Complete card
with eight grounded output fields, including `positioning_statement` and
`top_creators_analysis`. Earlier in the root worker log, the initial
`response_schema` call had a strict read-only Fast Mode cache miss and logged
`Failed to generate response schema`. The canonical local seed dump's
`FastModeCacheEntry` COPY has zero rows, so this was a real missing cache row,
not an intermittent read error. Strict replay correctly refused live model
fallback and preserved zero spend. The title had been coupled to the optional
startup schema result, while the completion path had enough verified output
to name the task but never did so. The first bad boundary was the terminal
write of `COMPLETED` with a null title.

Request path: root prompt → optional schema/title generation → cache miss →
50-child research and verifier → structured Task Complete outputs →
`mark_finished` status PATCH → null title in the Agent row → benchmark title
evaluator failure.

Archive searches used `Root task title is missing response_schema strict cache
miss` and `Fast Mode replay completed root untitled missing generated title`.
The September 5 generic schema-cache title case is related, but its failure
was a cache **hit** with a placeholder `Task Output` title. This case is a
cache **miss** with no title. Its prior solution already provides
`meaningful_response_schema_title`, which can interpret the verified output
field names without a new title model call.

The owning regression command, run from `agents/`, was:

```bash
PYTHONPATH=.:tests/blackbox venv/bin/python - <<'PY'
import asyncio, runpy
namespace = runpy.run_path('tests/blackbox/finished.blackbox.py')
asyncio.run(namespace['test_mark_finished_untitled_root_uses_verified_output_for_title']())
PY
```

Before the fix it exited 1 at `assert title_request is not None`: the only
PATCH was the terminal status. The unchanged command exits 0 after the fix.
The full `finished` blackbox domain reports 7 passing cases. It is discovered
by the agents blackbox runner, which `/deploy` runs under coverage for agents
runtime changes.

## Solution

Before the terminal status transition, `mark_finished` now derives a root
title from verified `structured_response` field names using the existing
schema-title normalizer and sends it through the backend's `generated_title`
API. That API applies the candidate only to a root whose title is still null,
so a human rename and an earlier good LLM title win. Children do not make the
extra request. The original schema cache miss remains logged; no live model
call is permitted by this change. A failed title write is logged and the
verified task still reaches `COMPLETED`.

The exact unchanged benchmark command,
`ROSE_USE_SYSTEM_PG=true BENCHMARK_SKIP_WMH_BUILD=1 bash scripts/run-bench
--local test-mass-agent-run-0`, passed after the fix: 51/51 agents completed,
18/18 declared evaluators passed, zero live model spend, and a 508-second
task duration. The run record is
`agents/benchmarks/runs/20260929_015858_test-mass-agent-run-0.json`, run ID
`91907645-09a7-4f17-80fd-3e402e905f9f`, root agent
`e822e258-90be-4400-9bae-8dc9d5980e68`. Before the local database was
torn down, a direct Agent-row read confirmed
`Creator Brand Strategy|COMPLETED`. The durable
[FE viewer](https://www.roselabs.ai/?agent-id=e822e258-90be-4400-9bae-8dc9d5980e68)
was verified reachable with 268 messages.

## Human feedback

The user required diagnosing the other failing deploy gates and did not
authorize weakening benchmark criteria. The prompt, evaluator, fixtures,
timeout, and expected tools of the mass-agent task were unchanged.

## Reusable lesson

Do not couple user-visible task identity to an optional startup schema when
the verified completion already contains enough structured evidence to name
the root safely.
