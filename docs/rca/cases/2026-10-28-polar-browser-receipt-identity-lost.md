---
id: 2026-10-28-polar-browser-receipt-identity-lost
date: 2026-10-28
title: Polar transcript loses task-scoped browser action receipt identity
surface: harness
component: polar-evaluator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser success persistence omits result.action_step before Polar projection
symptoms:
  - BU020 r2 C3 cites transcript row29 against native action-history step29
  - BU016 r2 unsupported user-provided File example is a distinct valid actor failure
tags:
  - polar
  - evidence
  - browser
  - citation
sources:
  - agent 821a6873-0789-4d1d-9345-fc49c670ceec
  - agent 242e9c75-8c4f-4be3-a3f7-61c09229da0f
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - plan: archive sha256 58f5558613b1cef9c1458e75fd04213de206ecfd49b70b8203f51aef19ab4e8a
repro: agents/benchmarks/polar_browser_action_identity_test.py
status: mitigated
---

## Problem

The normal controller export contains BU020 browser task
1f10bc06-8361-5d8f-8a99-fdb626378fd9's native action-history step29:
an evaluate action querying the visible submission confirmation. Its exact
parameters and successful result match persisted message index82, chronological
Polar row83. The internal verifier correctly cites native step29. Polar row29
instead contains a country selection. Native receipt identity was absent from
persisted metadata and therefore unavailable to the external rubric judges.
## Diagnosis

The source action index, budget iteration21 and chronological row83 are three
different namespaces.

## Solution

The repair carries the existing native receipt index through the existing
private persistence owner and labels it with the browser task ID in the judge
trajectory. Outer history order and row numbering remain unchanged. Unrecorded
tool result keys cannot forge the wrapper-owned index. Missing/invalid indices
remain unlabeled. No criterion, task, prompt, model, budget or historical score
is changed. Correct citation is evidence, not automatic task success.

The permanent causal controls replay the saved receipt sequence using real
ActionHistory recording, actual handler wrapper/persistence statements and
private owner, then all three actual Polar judge requests. Frozen source fails
three intended assertions; candidate passes. Controls cover duplicate indices
across browser tasks, absent/forged indices, privacy and unchanged parent
planning. The judge double always returns failure. Registered in the existing
benchmark-live-results gate. Missing original media remains a limitation;
no screenshot or new task outcome is claimed.

BU016 is separate: persisted actor message45 asserts the user supplied a
specific new File example. The actual task only asks to complete the form and
create a file if needed. The unsupported premise is present before deterministic
summary projection. Its genuine original FAIL remains OPEN, with no speculative
prompt patch. Both original task FAILs remain authoritative.

Primary comparisons opened: BrowserUse agent/views.py StepMetadata361-373,
AgentHistory488-495 and serialization545-581 preserve native step metadata with
actions/results (SHA256 f08c9e96df9e346ba87c0cd3ceb79a7d3a6c1f7764083a367ca8e10bb65c43ce).
Odysseys837814633ef948479abb3d142458f0acdb73fa65 groups source event steps99-128
and sends complete evidence to each rubric197-214. Its display renumbering165-172
is a contrary pattern, not a multi-browser identity solution. Its criteria44-47
still require applied and confirmed state; preserved identity cannot promote
an outcome. Exact Rose internal receipt and persistence boundaries establish
the domain-specific mapping. No provider, paid run, browser session or deployment
was performed by this owner.

## Human feedback

Parent required exact independent opened-reference review before protected application, scoped identity, unchanged criteria and original FAILs, plus phone/privacy/cancellation collateral. Final v3 SHA2562097009a61ac1cbe161adc35701fd0e844a4baa97e6df041c74a036af37d2265 received GROUNDED before application.

## Reusable lesson

Persist source-owned receipt identity with its task namespace. A chronological transcript row and a per-browser action index cannot substitute for one another.

Validation: exact final permanent controls against frozen runtime produce four
assertion failures (including ordinary original persistence loss and numeric
secret masking separately); patched controls pass. After exact application,
all 17 Polar/evidence/identity tests pass. Five isolated owning processes pass:
phone live completion/history, secret-reference masking, cancellation after
completed await, observation HTTP persistence and metadata HTTP serialization.
Four identity controls are selected by the registered gate keyword. RCA archive
validation and whitespace checks pass. Initial direct blackbox pytest collection
needed the repository's blackbox import path; no assertion was waived. Live
unchanged-task outcome and historical score correction remain unverified.
