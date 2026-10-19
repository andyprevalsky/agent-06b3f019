---
id: 2026-10-14-browser-observation-lost-before-credential-classification
date: 2026-10-14
title: Browser observation disappeared before saved-credential outcome classification
surface: cross
component: browser-credential-evidence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Browser action persistence dropped masked observed page state needed by credential classification
symptoms:
  - Failed saved login still offered on second run
  - Browser sees incorrect password while classifier sees no rejection
  - Stale credential unknown and working credential success
tags:
  - browser-auth
  - credential-propagation
  - evidence-transport
sources:
  - agent 19a23731-7c24-4b3c-820d-f5ab1a031879
  - agent 247942d2-f747-4f94-93dc-db7a1a39133f
  - fleet run 9c764f92-b304-499e-aafe-cdd381b3b8f5
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py browser_observation_credential_evidence_persistence
status: fixed
---

## Problem

Original e576 task browser-auth-failed-login-not-reoffered failed208.3s. Both
warmup and graded native histories showed rejected-login text after submitting
the freshest stale credential; the older working credential succeeded. Stale
remained enabled. This case records an isolated verified correction, not adoption.
Original verdict, clocks, credentials and canonical task were preserved.

## Diagnosis

Read-browser-state returns formatted_state and a generic message. Native history
keeps the observation; successful action persistence saved only the generic
message and optional credential_ref. Propagation queries persisted messages.
Its prompt correctly renders supplied text/metadata, but rejection never arrived.
Both actual original classifiers therefore returned stale unknown, working
success. Unknown correctly requests no mutation; refs2/applied1 is not a failed
disable write. Submitted refs, owner and realm matched.

Archive searches: failed saved login still offered; credential propagation wrong
password successful login disabled. Realm-transition stale-auth-context is a
relative, not a proven recurrence. Existing retry tests seed rejection text
and mock labels; history tests omit persistence. Golden reference Claude Code
src/utils/sessionStorage.ts around1028-1056 preserves transcript message content
and tool association. No equivalent credential classifier was established.
The owned class is observation transport; interpreting every prior retry as
credential failure would violate the existing submitted-and-rejected contract.

## Solution

Four runtime lines preserve the same already-masked read observation in dedicated
browser_observation metadata. Existing task/action/toolCallId plus native URL/time
retain provenance. Existing classifier rendering consumes it; actual parent
planner conversion stays identical. No classifier rule or instruction text changes.

Registered test executes the actual production persistence AST slice and real
HTTP serializer with synthetic evidence, isolating the paid loop. Identical
assertion fails original and passes candidate. Controls cover late evidence
beyond10k characters, known secret masking, planner equality, non-read/empty
observations and credential-ref preservation. Production masking order and real
classifier execution are not proved by that isolated test alone.

Unchanged canonical isolated run9c764f92-b304-499e-aafe-cdd381b3b8f5 passed191.9s.
Actual warmup classifier saw rejection, returned stale auth_failed and working
success, and applied both decisions. System/config hashes match the original
qwen-3.8-27b caller. Second-run native inventory offered only working enabled
password; signed in with no failed attempt. Related domains passed2/0 in52.2s.
Original FAIL208.3s remains separate. No additional call-only replay was needed.

Original four observations total3867characters versus32850 existing classifier
prompt characters. No silent truncation/keyword filtering. Larger pages may cost
more; existing masking covers known secret bindings, not arbitrary page secrets.
Local fix is verified; deployment integration remains held for review.

## Human feedback

User required isolated owning proof, unchanged canonical verification and original
campaign preservation. Parent required actual classification, disable/refreshed
inventory correspondence, no forced labels or weakened unknown rules, and exact
LLM-visible scope plus guards before adoption. Detector PASS is not user approval.

## Reusable lesson

Preserve actual masked observations with provenance across downstream classification boundaries instead of inferring failure from retries.
