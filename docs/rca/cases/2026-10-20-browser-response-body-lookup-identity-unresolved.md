---
id: 2026-10-20-browser-response-body-lookup-identity-unresolved
date: 2026-10-20
title: Response body lookup failed although another capture preserved each HTTP 200 body
surface: agents
component: browser-network-recorder
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Candidate unproven: BrowserNetworkRecorder._fetch_response_body issues Network.getResponseBody for an unresolved per-attempt session and request identity
symptoms:
  - Browser network response body capture failed
  - No resource with given identifier found
  - CDP -32000 for request IDs 2470.36 2470.37 2470.68
  - Failed to poll queue metrics
  - namespace rate limit exceeded
tags:
  - browser
  - response-body
  - cdp
  - queue-metrics
  - recovered-warning
  - open-triage
sources:
  - PR #1552
  - commit 64e5cc2dd83dfc346797b97e7c0f5fd749713250
  - agent 915ab997-c174-4297-80ac-15347120342f
  - benchmark run 6d381188-2d83-46d3-a2d5-2cfb460bc173
  - agent ae879bf0-c5a2-41df-a7f8-a46d8d4d5d60
  - task browser-biometrics-webdecoy
repro: none-recorded
status: open
---

## Problem

Complete source is browser-response-warning-triage.txt. In browser-deploy/.context/
benchmarks/1792462236-438247-20002/logs/worker.log, requests 2470.36,2470.37,2470.68
fail body lookup at :236/:247/:562 (02:12:15.351928Z, .595780Z, 02:12:22.933136Z).
Each subsequently has a 284-byte HTTP 200 body captured within 0.762/0.789/0.869 ms,
with duplicate byte-identical files. This is another capture succeeding, not a retry
of the failed call. Task COMPLETED at 02:15:19.375501Z and passed in 205.6 s.
The later local producer batch reports 9/9; that is not a new run or whole-deploy verdict.

## Diagnosis

recording.py:3779 calls getResponseBody; :3946 catches its failure. Entry keys use
generation+requestId, not session ID (:3389-3393); completions can schedule multiple
captures (:3539/:3559). Final index has four sessions and one generation. A session
change at worker.log:317 is a lead, not identity proof for the failed lookups.
Missing per-attempt session/target/event correlation prevents distinguishing duplicate
multi-session events, body lifetime loss or another CDP condition. Registry callbacks
replace a slot rather than accumulating listeners, so listener accumulation is unproven.
There is no controlled link to the viewport patch and no owning fail/pass reproduction.
Persisted stale body_error is an independently recorded case, not this failure's cause.

Literal body-error and behavioral capture/race searches found no same-cause case;
August 3 amazon-passkey-use-boundary-unobserved only shares diagnostic infrastructure.
Its Solution/Human feedback were read; no recurrence established.

Concurrent queue observation, not an additional diagnosed bug: four rate-limit episodes,
five warnings at :166/:631/:2735/:6526/:6580, each followed by fresh source=self queue
metrics at :212/:897/:2882/:6657. Backoff values were 1.070,1.249,1.039,1.689,1.803 s.
worker.py:1114-1140 publishes unknown on failure, backs off and resets on success.
Both literal and behavioral queue searches found the October 14 attention-worker case;
its Solution/Human feedback and queue note were read. That case's HTTP auth defect
is different. No actionable queue defect or competing caller is established here;
recovery does not mean namespace throttling was permanently fixed.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

## Solution

No fix. Capture per-attempt CDP method/request/session/target/generation and compare
failed/successful lookup ownership through the existing recorder blackbox boundary.
Do not add blind retries, lower warnings, claim a failed HTTP request, or expand the
viewport deployment. Leave expected recoverable queue backoff as an observation unless
new evidence establishes a violated contract.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Distinguish a failed CDP body lookup from HTTP failure and correlate attempt identities before assigning a session or race cause.
