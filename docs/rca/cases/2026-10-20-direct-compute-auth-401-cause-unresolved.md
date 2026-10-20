---
id: 2026-10-20-direct-compute-auth-401-cause-unresolved
date: 2026-10-20
title: Direct GPT and Claude credentials rejected before successful Foundry fallback
surface: agents
component: rose-direct-compute-auth
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Candidate unproven: provider authentication rejects selected GPT and Claude credentials with HTTP 401; precise credential cause absent
symptoms:
  - GPT/Codex HTTP 401
  - Anthropic OAuth HTTP 401
  - RoseAuthError
  - auth_error retained on successful Foundry metadata
tags:
  - compute-auth
  - http-401
  - oauth
  - fallback
  - open-triage
sources:
  - PR #1552
  - commit 64e5cc2dd83dfc346797b97e7c0f5fd749713250
  - agent 915ab997-c174-4297-80ac-15347120342f
  - benchmark run 6a650338-5a33-41fa-9e7d-32530efe8315
  - agent f46a9439-f0f6-4796-935a-3618eecfc651
  - task agent-payment-setup-resume
repro: none-recorded
status: open
---

## Problem

`browser-auth-warning-triage.txt` traces execute_loop request 71894f66 in source
`.context/benchmarks/1792462235-437737-75262/logs/worker.log:83-143`.
At 02:12:09.878769Z GPT returned HTTP 401; at 02:12:10.111289Z Claude returned
HTTP 401. Shared-key funding failures then occurred separately. Foundry served
gpt-6-sol-foundry; the LLM activity completed status=ok in 5571 ms.
The original triage cutoff saw the task running. A later existing local report-card
snapshot (02:27:57Z, preserved in incidental-archive-outcomes.json) reports this exact
task passed in 274.8 s. The four-task batch still had one running and one queued;
no full-deploy pass is claimed. Task pass is not credential recovery.

## Diagnosis

gpt_auth.py:822 and claude_auth.py:781 classify provider 401/403; client.py:1625,
1656-1669 rotates routes; :1969-1972 retains errors in successful fallback metadata;
helpers/llm.py:2937-2942 emits them. No whole-call deadline expired here: recovery
used the same 590-second call budget. Error-body length was logged, not response body;
expiry, revocation, account binding and refresh causes remain unresolved.
No subsequent direct GPT/Claude success establishes repaired credentials.

Literal HTTP-401/auth_error and behavioral credential-fallback searches found relatives.
Read matching Solution/Human feedback, notably April 18 permanent-null handling,
July 6 exhausted credential pool, August 5 transient Claude refusal, October 14
scoped revocation feedback. None proves the same cause: this transport really returned
401, unlike prior malformed-request/refusal cases. No true recurrence established.
Account/integration invalidation scope has its own separate October 20 case.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

## Solution

No repair performed. Recover selected credential identity and retained refresh/provider
response evidence through the credential owner; then replay the owning auth path.
Do not call a successful Foundry response restored OAuth or loosen auth/billing rules.
The deliberate missing-credential branches in the separate Claude Code suite passed;
its real 2+2 smoke passed too (9904 ms, suite 56/0), so those expected diagnostics
are not additional production auth failures.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Separate a recovered model request from the unresolved credentials that its successful fallback bypassed.
