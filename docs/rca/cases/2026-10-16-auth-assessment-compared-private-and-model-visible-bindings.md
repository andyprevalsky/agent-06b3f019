---
id: 2026-10-16-auth-assessment-compared-private-and-model-visible-bindings
date: 2026-10-16
title: Authentication assessment compared public bindings with private owner values
surface: agents
component: browser-auth-assessment-privacy-binding
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: authentication assistance validator compared model-visible realm and URL with private runtime values while action history was already projected
symptoms:
  - authentication_assessment_incomplete
  - The assessment does not describe the current realm and page URL
tags:
  - privacy
  - auth
  - owner-binding
  - model-visible-context
sources:
  - commit b6b2773fe2d7c045d3963410643f4d6a83125017
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
repro: agents/tests/blackbox/auth_handoff_verification.blackbox.py
status: open
---

## Problem

The actual DOMService privacy projection changes a secret-bearing realm, page
address and recipient before the model sees them. A local reproduction using
that real projection and the real assistance predicate accepts the raw control
but rejects the assessment describing the same native page in its public form.
The retained `private-url-predicate-proof.json` records those booleans without
publishing private values. This is a reproduced integration defect; no native
benchmark failure is attributed to it.

## Diagnosis

The merged handler passed private auth_options, auth_realm and current_url into
the predicate alongside ActionHistory.get_entries(), whose values already use
the model-visible policy. The predicate then required direct equality with the
public model response. The fresh-page check independently compared a projected
browser-state URL with the private routing URL. A valid public assessment could
therefore fail before the independent handoff judge ran.

Searches `authentication assistance realm mismatch privacy redaction` and
`masked page address action history secret reference binding` found the older
realm-transition and action-receipt cases. Their boundaries differ: this case
concerns representation consistency under the same privacy owner, not missing
inventory restoration or a missing observed result.

## Solution

The private candidate projects only owner-supplied realm, page and recipient
bindings through the existing DOM policy before comparing them with the model
assessment. It retains action-history protocol fields and compares fresh native
page identity in the private routing domain. The same owning twelve-control run
records eleven passes/one failure before and twelve passes/zero failures after
the projection correction, with zero attempted Python socket connections. Full
activity routing and redirect controls subsequently passed in the private
fixture, preserving the attention API's existing URL redaction. These remain
scripted activity checks, not native site or end-to-end outcome proof.

An additional actual ActionHistory.record_action control found an unsafe
counterexample in that first candidate: record recipient A under a secret
reference, rebind that reference to recipient B, then cite A's old public
receipts as evidence that B was exhausted. The candidate incorrectly accepted
the assessment. The private `rotated-alias-proof.log` records
`ROTATED_OLD_RECEIPT_ACCEPTED True` with zero attempted network connections.
The root did not adopt this privacy candidate; its exact original patch hash
and bytes remain preserved. The superseding production patch
`6141069e5f633040dda6ff5ad86d976ef3fa46721bb64930cb8a657353dd3103`
uses existing private redaction-state metadata to reject ambiguous realm/page
bindings and exhausted or past-recipient claims involving a rebound alias. The
SAME actual producer/handler-call negative now fails before and passes after,
with zero attempted network connections. A sibling that hides the false past
attempt behind a not_applicable or unavailable current row also fails before
and passes after. Stable current aliases retain their positive control.

This is intentionally conservative: without a retained generation identity,
even a genuine new B receipt after alias reuse cannot be distinguished safely
from stored A evidence. The repair rejects that exhausted/past-attempt proof
rather than inventing lineage. Ordinary dispositions without false attempt
claims remain available. The first rotation-guard full browser domain passed
in 110.9 seconds. The final exact-byte browser-domain run also passed in 104.8
seconds, with six Python connection attempts denied by the private guard; the
two related canonical domains passed in 9.4 seconds with zero attempted Python
connections. Earlier failed setup and fixture attempts remain retained. These
are local owning-domain results, not complete combined repository coverage or a
native task outcome. Passing representation-parity controls alone did not clear
the unsafe first candidate.

Do not invert cumulative secret aliases to establish authority. Previous aliases
exist for redaction and can be reassigned; the generic string resolver supplies
neither realm nor action provenance. Do not project ActionHistory a second time:
its owner deliberately restores integer step and action protocol fields after
redacting secret values. Preserve exact private backend routing and reject
foreign, stale or ambiguous public bindings. No identity permission, registration
fact, inbox health claim or automatic form action is added.

## Human feedback

The user requested fixing the failures and approval only at deployment. Neither
privacy protection nor the unchanged task/evaluator/timeout gates were waived.

## Reusable lesson

Compare a model response with the same public representation its authoritative
owner supplied, while preserving private execution identity and trusted protocol
fields in their own domain.
