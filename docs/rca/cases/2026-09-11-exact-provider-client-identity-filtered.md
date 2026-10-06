---
id: 2026-09-11-exact-provider-client-identity-filtered
date: 2026-09-11
title: Exact Steel cleanup verification used a client identity rejected by the edge client-signature filter
surface: agents
component: cloudbench-provider-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-exact-session-cleanup.py provider_request omitted the application HTTP client identity used by provider SDKs
symptoms:
  - "Steel exact session cleanup failed: HTTP 403"
  - "error code: 1010"
  - "backend closed the exact Steel session but independent cleanup rejected it"
tags:
  - steel
  - cloudflare
  - cloudbench
  - teardown
  - http-client
sources:
  - PR #1299
  - fleet run 20260910-231855-81195
  - agent ed8e2e7e-6f3c-4b10-97c1-87accd16e5f6
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_exact_provider_cleanup_identifies_client_without_accepting_forbidden
status: open
---

## Problem

The second slice of validation attempt nine failed. The backend reported the
exact Steel session closed, but the Python cleanup verifier received HTTP 403,
so the fleet correctly withheld teardown acknowledgement. The same root also
failed its terminal-recording deadline. These are separate failures; fixing the
HTTP client must not clear the recording failure or count this slice as accepted.

## Diagnosis

Read-only requests used the identical exact session ID, key, endpoint and method.
Python's default User-Agent received HTTP 403, text/plain `error code: 1010`.
Changing only User-Agent to `rose-cloudbench/1.0` received HTTP 200, the exact
matching session ID and `status=released`. Its creation timestamp was during
this root's browser recovery, excluding a historical seed row. The preserved
backend log confirms recovery selected Steel and later closed that exact session.

Steel's installed SDK identifies its client and requests JSON. The shared Python
cleanup helper did neither, allowing Cloudflare to reject its default urllib
identity at the edge client-signature filter. This is a request-construction mismatch, not
permission to treat 403 as terminal. The live comparison is retained privately at
`.context/acceptance/proof9-slice2-forensics/independent-steel-exact-get-user-agent.json`.
No credential values are recorded in the case or comparison receipt.

The local wire-level reproduction runs the actual helper against an HTTP server
replaying the captured 1010 boundary. Before the fix, the valid exact release
raised HTTP 403. The identical command passed after the fix and still rejects a
separate forbidden release:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloud_batch_cleanup_test.py -k identifies_client`

Before/after outputs are retained under `.context/acceptance/steel-client-repro-{before,after}.log`.
The benchmark blackbox runner automatically discovers this regression, and the
existing deploy agent-coverage gate runs that group. Full blackbox and live
benchmark verification remain necessary; this case stays open until complete.

Archive searches used `Steel exact session cleanup HTTP 403` and
`cleanup provider closed verification database dropped`. The July 22 Steel
parity case is a relative about CDP key placement. This incident is a different
REST client boundary. The September 11 recording/archive case owns the separate
recording failure and its error-capture recurrence.

## Solution

Identify the shared exact provider cleanup client with a truthful application
User-Agent and JSON Accept header. Keep the original authenticated endpoint,
exact session identity, response-size bound, HTTP status checks, and Steel
`success=true` check. Do not retry or reinterpret Cloudflare 403 as success.

This unifies request identity at the single shared provider boundary, covering
both normal finalization and stale-owner recovery. Removing provider verification
would delete the safety invariant rather than the bug; copying the entire SDK
into the dependency-light controller would add another runtime dependency.
At 10,000 agents this adds constant request headers and no extra requests,
provider inventory reads, parallelism, or rented resources.

## Human feedback

The user required ten consecutive sequential cloud slices of ten real tasks
without infrastructure errors, no repeated permission requests, normal 120-minute
backstops and a temporary five-minute limit for this validation. A recovered
failed slice does not satisfy that acceptance criterion.

## Reusable lesson

Give direct provider clients an explicit application identity while preserving strict authenticated terminal-response validation.
