---
id: 2026-07-24-expired-agent-api-record-treated-as-fatal-evidence-loss
date: 2026-07-24
title: Evidence collection treated an expired agent API record (404) as fatal even though retained ClickHouse logs were still available
surface: infra
component: auto-rca-evidence
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: backend evidence collection — a non-2xx from the short-lived agent API record aborted collection instead of falling back to retained logs
symptoms:
  - agent API record returns 404 during Auto-RCA evidence collection
  - RCA aborts for lack of evidence while ClickHouse still holds the logs
  - historical workflow dispatch rejected over the affected-user name
tags:
  - auto-rca
  - clickhouse
  - evidence-collection
  - retention
  - fallback
sources:
  - PR #881
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

While investigating production run `30064099414`, the affected agent's API record
had already expired and returned 404. Evidence collection treated that as fatal and
gave up — even though the retained ClickHouse evidence for the same agent was still
present and sufficient.

## Diagnosis

The agent API record is short-lived by design; retained worker logs in ClickHouse
last far longer. Evidence collection ranked the API record as a required source
rather than as the preferred one, so a normal, expected retention boundary read as
"no evidence exists". The deepest owned cause is a single-source dependency in the
evidence path: any RCA started after the API record expired became structurally
impossible, which is exactly the case an automated post-hoc RCA hits most often. A
related strictness bug rejected historical workflow dispatches over the
affected-user name.

## Solution

Evidence collection now falls back to retained ClickHouse logs when the expired
agent API record returns non-2xx, and fails closed only when _every_ evidence source
is empty — preserving fail-closed behavior while removing the false-fatal. Also
allows a sanitized affected-user name on historical workflow dispatches so older
runs remain investigable. Validated by `scripts/tests/auto-rca-workflow.test.sh` and
the lifecycle blackbox suite.

## Human feedback

None recorded.

## Reusable lesson

Rank evidence sources by retention, not by convenience — an expired short-lived
record must degrade to the longer-retained log store, and only an all-sources-empty
result may fail the RCA.
