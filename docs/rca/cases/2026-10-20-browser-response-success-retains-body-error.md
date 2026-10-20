---
id: 2026-10-20-browser-response-success-retains-body-error
date: 2026-10-20
title: Successful response capture retained a stale body_error in its diagnostic index
surface: agents
component: browser-network-index
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Candidate unproven: recorder success updates body metadata without clearing body_error left by a previous capture attempt
symptoms:
  - status=200 terminal=true body_file present body_size=284 body_error=-32000
  - Successful response body capture retains prior body_error
tags:
  - browser
  - network-index
  - stale-error
  - response-body
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

browser-response-warning-triage.txt inspected network/index.json for requests
2470.36,2470.37,2470.68: rows beginning :590/:640/:1236 have status=200,
terminal=true, body_file present, body_size=284 AND body_error=-32000 at
:637/:687/:1283. Network artifacts reside in source-worktree .context/
browser-agent-recordings/ae879bf0-c5a2-41df-a7f8-a46d8d4d5d60/
a4e891f2-d577-51c0-bd95-86a1bbfdf082/network/.
The affected WebDecoy task passed in 205.6 s. Persisted mixed diagnostic state is
observed; neither HTTP failure nor an incorrect agent-visible response is established.

## Diagnosis

recording.py:3911-3945 updates successful body fields but does not clear body_error
assigned at :3947. query_requests at :4208-4213 prioritizes available body data, so the
index inconsistency does not prove agent-facing failure. This is distinct from why the
original CDP lookup failed, which remains in the response-body-lookup case.
No local failed-then-successful owning-path replay or consumer contract/fix proof exists.

The response family's literal body_error and behavioral stale-body/capture searches
found only the August 3 diagnostic-redaction relative; its Solution/Human feedback
were read. It does not establish this stale-state cause or a recurrence.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

## Solution

No code changed. Reproduce failed-then-successful capture on the same owned index row,
then assert the intended final error/success representation through query/export before
selecting a repair. Do not silently drop original failure history; distinguish attempt
history from final state. Parent owns any implementation and deploy decision.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Keep per-attempt failure history distinct from final successful response state in diagnostic indexes.
