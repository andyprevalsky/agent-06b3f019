---
id: 2026-08-04-grep-emits-pointers-no-tool-can-dereference
date: 2026-08-04
title: grep returns path-shaped identifiers no tool can dereference, so the model fed them to web_fetch and to grep's own filters
surface: agents
component: grep-tool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/data/format.ts — grep emits `path`/`pointer` identifiers (`network/<name>.contact`, `messages/<thread>/<id>`) that no tool in the explore agent's toolset accepts as input
symptoms:
  - "Unsupported grep parameter: 'filters.path'."
  - "Unsupported grep parameter: 'filters.account'."
  - "web_fetch failed with Firecrawl and Parallel Extract"
  - web_fetch called with a non-http string like network/+19729777432.contact
  - web_fetch called with a fabricated host like https://internal/messages/...
tags:
  - grep
  - web-fetch
  - explore-agent
  - tool-contract
  - data-domain
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: back-end/src/tests/blackbox/data-grep.blackbox.ts testEmittedPathRoundTrips + back-end/src/tests/unit/grep-path-roundtrip.test.ts
status: fixed
---

## Problem

An explore sub-agent of prod agent `e14d5abb` made four tool calls that could never
succeed, then ended on an error that cancelled its parent's DAG.

Rejected grep calls (reconstructed from the prod TOOL messages):

```
pattern "."  sources ["network"]   filters {"path": "network/Andy H. Ramcke.contact"}
pattern "."  sources ["messages"]  filters {"account": "+19729777432"}
-> {"func": "grep_activity", "error": "Unsupported grep parameter: 'filters.path'."}
-> {"func": "grep_activity", "error": "Unsupported grep parameter: 'filters.account'."}
```

Rejected web_fetch calls:

```
url "https://internal/messages/+19729777432.thread"
url "network/+19729777432.contact"
-> Firecrawl returned empty markdown; Parallel Extract returned no results
```

## Diagnosis

`network/+19729777432.contact` is not a hallucination. It is byte-for-byte what grep
itself emitted. `back-end/src/domains/data/format.ts` `buildNetworkMatch` builds
``path = `network/${name}.contact` `` where `contactName()` falls back to
`row.phoneNumber` for an unnamed contact; `buildMessageMatch` builds
``path = `messages/${thread}/${row.id}` `` with `threadName()` falling back the same
way. Those strings land verbatim in the explore agent's context
(`agents/domains/grep/repo.py:92` returns the backend JSON unmodified).

The model was therefore handed an identifier and had no operation that accepts one.
`grep`'s `person` filter is documented "Ignored for network and agent_network"
(`agents/utils/tool_schemas.py:475`), and no tool takes `path` or `pointer` as input.
It tried the only two doors available: grep's `filters`, and the one tool whose
parameter is called a URL.

Both doors were unguarded:

* `filters` is `Optional[Dict[str, Any]]` (`tool_schemas.py:462`) documenting every
  source's keys in one prose paragraph, so the source→key *binding* is not
  machine-checkable. The backend enforces a strict per-source allow-list
  (`back-end/src/domains/data/types.ts` `DATA_SOURCE_CONFIGS`, enforced at
  `validate.ts:152` `rejectUnsupportedFilters`); `network` permits no filters at all.
  Nothing on the agent side pre-validates, so the round trip is spent to learn it.
* `web_fetch` performs zero URL validation. `agents/domains/web_fetch/handler.py:117`
  is `url = tool_call.get("url", "")` and the string goes straight into the Firecrawl
  POST body (`repo.py:97`) and then Parallel Extract (`repo.py:139`). `urlparse` is
  imported in `service.py:15` but used only for filename derivation.

The backend is the correct side of the grep contract: `path` is a *synthesized output*
field, not a queryable column, so rejecting it is right. The defect is upstream —
emitting a pointer with no dereference operation.

Step 5a ladder:
1. Two tools errored — because the arguments were invalid.
2. The arguments were invalid — because they were grep's own output identifiers.
3. Those identifiers exist with no consumer — because grep presents local data as a
   filesystem-like namespace (`path`, `pointer`, and a "filesystem-like summary" at
   `agents/domains/grep/repo.py:123`) without shipping an operation that resolves one.

Rung 3 is the deepest owned cause and unifies both symptoms.

Note on documentation: the model was NOT under-documented. `tool_schemas.py:463-472`
names both `account` and `path` and states "Unsupported filters are rejected by the
backend for the selected source", and `tool_schemas.py:341` says the URL must be
"A fully-formed valid URL". The rules were present and ignored — which is why the fix
must be structural (typed contract / validation), not prose.

## Solution

Shipped for the two sources this incident hit. `back-end/src/domains/data/path.ts`
is now the single grammar: `build*Path` emits, `parseGrepPath` parses, and
`format.ts` builds every emitted path through it so the two halves cannot drift
apart silently again.

`filters.path` is now accepted on `messages` (and its channel aliases) and
`network`. It translates into the EXISTING resolution rather than new SQL: a
path's thread/contact segment is the same identifier space `resolvePersonId`
already handles (full name, phone, email, or person id), which is why an emitted
path resolves without a second matching implementation. A thread path without a
message id addresses the whole thread; with one it addresses that message. A path
printed for a different source is rejected as `filters.path` rather than silently
matching nothing.

Verification (identical command both sides):

    cd back-end && CONDUCTOR_PORT=55160 CONDUCTOR_WORKSPACE_NAME=pattaya \
      bash scripts/run-blackbox-tests.sh data-grep

  pre-fix:  FAIL data-grep — Expected HTTP 200, got 400:
            {"error":"INVALID_GREP_PARAM","message":"Unsupported grep parameter: 'filters.path'."}
            (byte-identical to the prod worker log)
  post-fix: PASS data-grep — 1 passed, 0 failed
  full backend suite: 116 passed, 0 failed

The test greps first and feeds the RETURNED path back, so it cannot pass by
agreeing with a hard-coded fixture.

All five emitting sources now round-trip, and the printed `account` label does
too. `filters.path` is accepted on messages (+ channel aliases), network,
agent_network, transactions, and documents; each translates the parsed components
into the existing structured filters rather than a second matching implementation.
`documents` keeps its original free-text substring behavior for any value that is
not a path this tool printed.

`account` previously printed `<name> ****<mask>` while the filter substring-matched
name and mask separately, so the printed label matched neither; `parseAccountLabel`
now decomposes it and matches both halves.

10k-agent behavior: the new filters resolve to an indexed equality
(`m."personId"`, `m.id`, `p.id`) via the existing resolver — one extra point
lookup per filtered query, no scans, no shared state, no per-agent fan-in.

## Human feedback

The user rejected the initial framing twice, and both corrections changed the
diagnosis:

1. "this is normal fine behavior" — on the DAG cancelling after a sub-agent
   failure. Correct: that is by design, and the sibling case
   2026-08-04-subagent-success-decided-by-last-event-not-evidence should not be
   fixed on the assumption that it is not.
2. "really grep doesn't take a path???" — the claim that no tool accepts a path
   was wrong. `documents` does. The real defect is that `path` means an emitted
   address on the way out and a raw-column substring on the way in.

The user also asked why `path` is not universal, given grep's stated design, and
required an audit of whether `person`/`since` share the drift. They do not
(`from`/`to`/`contact_id` resolve correctly via `person`); `account` does.

## Reusable lesson

Never emit an identifier from one tool that no other tool accepts as input — a model
holding an un-dereferenceable pointer will feed it to whatever parameter looks closest.

## Recurrence — 2026-08-19 (agent a6b8593a-bd41-4a18-8eca-667cbf0020ba)

Same class, new source. An explore child grepped `sources: ["documents"]`, and
match #25 printed verbatim:

```
**25. source: documents path: documents/generic/User snapshot V1 bootstrap/user-snapshot-v1-bootstrap**
```

7s later the model called `web_fetch` with that exact string.

**What held:** `assert_fetchable_url` rejected it non-retryably before any
provider call — zero Firecrawl/Parallel spend, and the agent recovered on the
next iteration. The guard added by this case did its job.

**What did not hold:** the model still chose `web_fetch` over `grep`
`filters.path`, which `documents` accepts. Two concrete gaps in the affordance,
both in `agents/domains/web_fetch/service.py:93-97`:

1. The rejection message exemplifies only `network/<name>.contact` and
   `messages/<thread>.thread`. `documents/…` — the shape that actually recurred —
   is not exemplified.
2. It says "read them with the grep tool instead" but never names the parameter
   (`grep filters.path`), so the model is told the tool and left to rediscover
   the argument.

The structural half of the original fix (grep round-trips paths) is sound; the
*discoverability* half is prose that the model must infer. Because the guard
contains the cost, this recurrence is logged rather than re-fixed — but it is the
second observed instance, so the next occurrence should raise the affordance into
the tool schema/result rather than the error string.

The rendering fallout of this particular occurrence has its own cause and case:
docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md.
