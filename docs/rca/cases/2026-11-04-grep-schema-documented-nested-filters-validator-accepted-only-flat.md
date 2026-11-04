---
id: 2026-11-04-grep-schema-documented-nested-filters-validator-accepted-only-flat
date: 2026-11-04
title: grep schema documented nested per-source filters while the backend validator accepted only one flat shape, so documented calls failed with bare "Unsupported grep parameter" errors
surface: cross
component: data-grep-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/data/validate.ts resolveSourceSelection + validate.filters.ts requireFilterObject/rejectUnsupportedFilters — the validator read `filters` as one flat key set shared by every selected source, while GrepTool (agents/utils/tool_schemas.py) described "Nested per-source filters"; nothing bound the two copies of the per-source key lists
symptoms:
  - "Unsupported grep parameter: 'filters.agent_network'."
  - "Unsupported grep parameter: 'filters.messages'."
  - "Unsupported grep parameter: 'filters'."
  - "Unsupported grep parameter: 'filters.since'."
  - "POST /api/data/grep 500 GREP_FAILED Cannot read properties of null (reading 'trim')"
tags:
  - grep
  - filters
  - tool-schema
  - explore
  - code-agents
sources:
  - agent 87ea5453-ad84-495f-bc27-03178c628f64 (prod, filters.messages nested block)
  - agent f15b7a78-07b1-4763-9462-e0b957fd4846 (prod, filters.documents nested block)
  - agent 47134744-ba0f-4c86-a116-d0640131ffe6 (prod, filters.calendar nested block and /root task path in filters.path)
  - agent 650d512a-eaa2-445f-864d-ca17e03ef43a (prod, filters.since on agent_network + agent_trajectories)
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe (prod, filters without sources)
repro: back-end/src/tests/blackbox/data-grep-contract.cases.ts testGrepParameterContract (data-grep backend blackbox domain); agents/tests/blackbox/grep.blackbox.py test_grep_schema_filter_keys_match_backend_validator + nested-filter gating tests (grep agents blackbox domain)
status: fixed
---

## Problem

While testing code agents on a local stack at 28a7bfc99, an explore agent
called `grep(sources=["agent_network"], filters={"agent_network": {"path":
"/root/timed_counter"}})` and got `Unsupported grep parameter:
'filters.agent_network'.` The GrepTool `filters` description says "Nested
per-source filters. Each source accepts only its own keys: ... agent_network:
path", so the call followed the documentation. A read-only prod query
(BEGIN READ ONLY … ROLLBACK, `"Message"` rows with `toolName=grep`, last 30
days) found 174 such rejections across many shapes: nested blocks
(`filters.messages` 7, `filters.documents` 3, `filters.calendar` 1), filters
without a source (`filters` 9, mostly `filters: {}`), a time key on a mixed
agent selection (`filters.since` 4), `until` on messages (`filters.until` 2),
an agent address in agent_network `filters.path` (2), `filters.trace_path`
(2), null-valued keys (`filters.account` 1, `page_after` 4 with
`page_after: null`), and stale paging (`page_after`). Every error was the bare
`Unsupported grep parameter: '<x>'.` with no hint of the accepted shape.

## Diagnosis

Critical path: LLM tool call → agents `execute_grep` (source gating) →
`grep_activity` (drops top-level None) → POST /api/data/grep →
`validateGrepInput` → `resolveSourceSelection` / per-source parsers →
`InvalidGrepParamError` → 400 → tool result text the planner reads.

Binary search: the agents layer forwarded the documented shapes unchanged
(confirmed by the stored "Params Passed" blocks); the first wrong decision was
the backend validator. It read `filters` as ONE flat object shared by every
selected source (`requireFilterObject(params)` in each parser), rejected any
source-name key as an unknown filter key, rejected `filters` whenever no
`source/sources` was given (even `{}`), treated null values as present values
(`parseFilterString(null)` → `filters.path`; a top-level `person: null` reached
`.trim()` and returned 500), and required a flat key to be accepted by EVERY
selected source. Deepest owned cause (Step 5a): the per-source key lists exist
twice — `DATA_SOURCE_CONFIGS` in `back-end/src/domains/data/types.ts` and the
prose in the GrepTool schema — and the shape (flat vs nested) was described in
one copy and implemented differently in the other, with no test binding them.
The schema copy had also drifted (agent_network `role` missing). The error
class carried only a parameter name, so no rejection could say what to send.

Archive searches: "Unsupported grep parameter filters nested agent_trajectories
source" and "grep schema validator mismatch tool parameter contract" — closest
relatives are 2026-10-25-agent-network-grep-rejected-advertised-record-kind
(same class, same file; its sibling recurrence is appended there) and
2026-08-04-grep-emits-pointers-no-tool-can-dereference (paths printed by grep
must be accepted back). This case is a relative, not a recurrence: different
first-bad rung (filter shape, not selector applicability).

Local repro: `cd back-end && bash scripts/run-blackbox-tests.sh data-grep` with
the new `data-grep-contract.cases.ts` on unmodified 28a7bfc99 code failed with
`grep contract violations (30)`, including every prod shape above and the 500.

## Solution

One filter contract, implemented once in
`back-end/src/domains/data/validate.normalize.ts` and fed by
`DATA_SOURCE_CONFIGS`:

- `filters` takes flat keys or per-source blocks keyed by source name (no
  filter key is a source name, so the two never collide); a `messages` block
  covers the message channels.
- A flat key, like the top-level `person`/`since`/`until` shorthands, applies
  to every selected source that accepts it and is rejected only when none
  does; nested blocks must use their source's keys.
- A printed path (or /root/... agent address) applies only to the source it
  belongs to; naming an unselected source's path is rejected with "add it to
  sources".
- Null values and empty objects are "not given". A nested block or a printed
  path names its own source when `sources` is omitted (generalizing the
  calendar/drive-only rule) and wins over until/order trajectory narrowing;
  otherwise flat filters apply to the default sources by the same rule, so
  the blanket `'filters'` rejection is gone.
- agent_network `filters.path` also accepts an agent address (/root/...), as
  agent_trajectories already did.
- `InvalidGrepParamError(param, hint)`: every prod-observed rejection now names
  the parameter the caller sent (`since`, `filters.since` or
  `filters.messages.since`) and says what to send instead.

Each parser now receives its source's effective filters, so the duplicated
`requireFilterObject`/`rejectUnsupportedFilters` calls and
`googleSourceOfPath` were deleted. The agents layer resolves the same implied
sources for connector gating, reads a nested `documents.document_source`, and
drops a skipped source's nested block, and flat or top-level keys only skipped
sources accept, when partial gating narrows `sources` (`SOURCE_FILTER_KEYS` in
`agents/domains/grep/config.py`, bound to `DATA_SOURCE_CONFIGS` by
`test_grep_source_filter_keys_match_backend_validator`).
The GrepTool `filters`/`since`/`until`/`order` text and the grep prompt now
describe this contract (approval-gated text; golden-reference review attached
to the branch handoff), and `test_grep_schema_filter_keys_match_backend_validator`
fails if the schema's per-source key lists ever differ from `DATA_SOURCE_CONFIGS`.

Known remaining design choice (adversarial review): a flat or top-level key
that only some selected sources accept narrows those sources and leaves the
others unfiltered, as documented in the schema ("applies to every selected
source that accepts it"), with no per-source applied-filters field in the
result. `filters.until` on messages is still rejected (messages has no until
filter); adding it is a feature, not part of this contract fix.

10k-agent behavior: pure in-request validation over a bounded param object
(≤13 sources × ≤8 keys); no new queries, connections, shared state or locks.
Status is fixed on branch `fix/grep-param-contract`, verified locally; it is not
yet deployed (the parent coordinator owns the combined deploy).

## Human feedback

None recorded.

## Reusable lesson

When a tool schema and its executor each carry a copy of the parameter contract, bind them with a test and make every rejection name the sent parameter plus the accepted alternative.
