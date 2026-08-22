---
id: 2026-08-22-browser-event-ticket-judge-ignores-start-url-venue
date: 2026-08-22
title: Semantic venue judge ignored spawn start_url amc-metreon-16 despite H-05 URL grounding
surface: agents
component: benchmarks/tasks.json movie-ticket-seat-selection-semantics
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json movie-ticket-seat-selection-semantics judge_prompt — does not name spawn start_url / tool_call URLs as valid Metreon venue grounding
symptoms:
  - "independent venue grounding"
  - "browser output never shows an AMC Metreon 16 theatre URL"
  - "attention request cannot itself prove venue"
  - "amc-metreon-16"
  - "movie-ticket-seat-selection-semantics"
tags:
  - browser-event-ticket
  - faulty-evaluator
  - venue-grounding
  - spawn-start-url
sources:
  - agent b6b30344-20ac-4eff-8d81-769e0d1cb762
  - memory:feedback_descend_no_contract_relaxation
repro: agents/benchmarks/benchmark_tasks_policy_test.py::test_browser_event_ticket_judge_accepts_spawn_start_url_as_venue (pending)
status: open
---

# RCA: judge ignores spawn start_url for Metreon venue

## Problem

Parallel k=5 attempt `b6b30344-…` bought **Fri Aug 28 9:00 PM** Coyote vs Acme
seat A6 for $18.99 / $21.68 on amctheatres.com (runtime contract passed).
Semantics failed solely on venue: judge claimed browser output never showed
Metreon and that attention metadata cannot prove venue.

## Diagnosis

Trajectory ASSISTANT `tool_calls[0].start_url` =
`https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16`.
Task Started / USER also mention Metreon. H-05 already approved URL-grounded
venue (merchant may say `AMC Theatres`). Current `judge_prompt` never says
`start_url` / tool_call URLs count, so the LLM judge treated them as non-evidence.

Relative of H-05 / toast-semantic-receipt-values (semantic identity encoded too
literally).

Local repro (observed):

```bash
cd agents && python - <<'PY'
import json
from pathlib import Path
task=next(t for t in json.loads(Path('benchmarks/tasks.json').read_text()) if t['name']=='browser-event-ticket')
sem=next(e for e in task['evaluators'] if e['id']=='movie-ticket-seat-selection-semantics')
assert 'start_url' in sem['judge_prompt'].lower(), sem['judge_prompt']
PY
```

→ AssertionError (start_url absent from judge_prompt)

## Solution

Proposed: extend criteria + `judge_prompt` to treat spawn `start_url`, navigated
theatre URLs, and showtimes paths containing `amc-metreon-16` as venue proof;
do not require Metreon in the approval line item. Cement policy test. Rerun
unchanged `browser-event-ticket`.

## Human feedback

Andy previously approved relaxing Metreon substring-in-approval (H-05). This
case is the leftover gap: start_url still not named as valid grounding.

## Reusable lesson

When venue is proven by navigation, the semantic judge must explicitly accept
spawn `start_url` and tool navigation URLs — not only page text snippets the
judge happens to quote.
