---
id: 2026-11-06-grep-filter-split-assigned-json-proto-key-onto-plain-object
date: 2026-11-06
title: grep accepted filters {"__proto__": {...}} because splitFilters assigned the key onto a plain object, which swapped its prototype instead of adding a filter
surface: back-end
component: data-grep-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/data/validate.normalize.ts splitFilters — `flat[key] = value` on an object literal; for the own `__proto__` key JSON.parse produces, the assignment invokes the Object.prototype setter, so the key disappears from Object.keys(flat) and its value becomes flat's prototype
symptoms:
  - "POST /api/data/grep filters {\"__proto__\": {...}} → 200 instead of 400 INVALID_GREP_PARAM"
  - "grep with filters.__proto__.path searched calendar although no source was named"
  - "Unsupported grep parameter: 'filters.__proto__'."
tags:
  - grep
  - filters
  - prototype
  - input-validation
sources:
  - PR #1691 (CodeRabbit comment 4487727422, deferred under the three-round rule)
  - commit 05826f6dd4f260fdc3602ab3e63095d13d2ddc81 (main containing the contract normalizer)
repro: back-end/src/tests/blackbox/data-grep-contract.cases.ts cases 'JSON __proto__ filter key' and 'JSON __proto__ filter key carrying a path' (data-grep backend blackbox domain)
status: fixed
---

## Problem

CodeRabbit's last review on PR #1691 reported that `filters: {"__proto__":
{...}}` would be ignored instead of rejected. Replaying it through `POST
/api/data/grep` on main 05826f6dd confirmed it and showed it is worse than
ignored. `{"pattern": "Ledger", "sources": ["messages"], "filters":
{"__proto__": {"since": "2026-01-01"}}}` returned 200. `{"pattern":
"Ledger", "filters": {"__proto__": {"path":
"calendar/a@example.com/2026-11-02"}}}` returned 200 and searched calendar
("calendar has no Google account that granted access to it… No matches for
'Ledger' in calendar"): the hidden key's contents were read as inherited
flat filters and chose the source.

## Diagnosis

Critical path: body-parser `JSON.parse` (keeps `__proto__` as an own data
key) → `validateGrepInput` → `splitFilters` → `rejectUnplacedKeys` /
`sourcesNamedByFilters` / `filtersBySource`. `requireObject` → `dropNulls`
uses `Object.fromEntries`, which defines own keys, so the key survives to
`splitFilters`. There, `flat[key] = value` on `{}` is an ordinary property
set: for `__proto__` it calls the `Object.prototype.__proto__` setter, so
`flat` gains no key and its prototype becomes the caller's object.
`Object.keys(flat)` (key validation) no longer sees it, while `flat.path`,
`key in split.flat` and similar reads find the inherited values. Deepest owned
cause: the split built filter maps by assignment onto ordinary objects, the
one construction in this module that treats a data key as a special
operation; every other step uses `Object.fromEntries` or object spread, which
define own properties. Other assignment sites (`setOnce`, `effective[key]`,
`raw[key]` in validate.agent.ts) only write keys already matched against fixed
allow-lists. Relative of the 2026-11-04 contract case (same normalizer;
Object.prototype names were already fixed for source-name lookup in PR #1691
cycle 1). Archive search "__proto__ prototype filter key silently ignored
grep" returned no prototype-handling case.

Local repro: `cd back-end && TMPDIR=/var/tmp bash
scripts/run-blackbox-tests.sh data-grep` with the two new cases on 05826f6dd
failed: `grep contract violations (2): JSON __proto__ filter key: status 200
… JSON __proto__ filter key carrying a path: status 200 … No matches for
'Ledger' in calendar.`

## Solution

`splitFilters` collects flat and nested entries and builds both maps with
`Object.fromEntries`, so `__proto__` is an own key like any other. Key
validation then rejects it with the existing text: `Unsupported grep
parameter: 'filters.__proto__'. messages accepts person, since, path. …`.
No error wording or schema text changed. The same two cases pass after the
fix, 5 consecutive runs; data, data-coverage, data-google-sources,
agent-trajectories and code-sessions blackbox domains pass. 10k-agent
behavior: pure per-request validation, no new state or queries.

## Human feedback

None recorded.

## Reusable lesson

Build maps keyed by caller-supplied JSON keys with Object.fromEntries or Object.create(null), never by assignment onto a plain object, or a `__proto__` key rewrites the prototype instead of being validated.
