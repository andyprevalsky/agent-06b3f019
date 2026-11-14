---
id: 2026-10-29-r78-schema-bound-final-presentation
date: 2026-10-29
title: R78 explicit schema-bound final answer presentation
surface: agents
component: workflow-final-presentation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Verified scalar survives completion but unconditional report presentation has no explicit value-only contract
symptoms:
  - Correct scalar output delivered in a labeled report despite a bare-answer request
  - Late accepted requirement changes could certify an older value during finalization
tags:
  - output-format
  - schema
  - finalization
sources:
  - commit 4016ffaf50aeee0eff1b242d9e348f54896fdc02
  - agent d8d6a92f-a83a-4ef4-b83a-51210db08b5c
repro: registered workflow and actual UI and notification entrypoint controls
status: fixed
---

## Problem

Original R71/R75 BU071 runs retained the correct integer 4 in structured output
but delivered labeled reports despite the user's bare-day instruction. The
original C2 failures remain unchanged. The R71/R75 case records their complete
original evidence and projection limits; this case records the subsequent
explicit presentation capability rather than claiming a retrospective pass.

## Diagnosis

The existing schema carried output shape but no presentation policy. Workflow
completion always generated a report; UI and notification consumers also assumed
report presentation. A judge-only rewrite would not fix actual user delivery.
The original R75 normal archive SHA256 is
55a79d211e1eb37676dbc72074fddbd9e6ec2776d29ae657dc96785f07a9a224,
manifest 91bdaa634c160470cbbc1803fb240061a420f7307de2d39adce2e6679eb4bf2f.
No new model, browser, provider, DB, or evidence-publication call was made.

## Solution

The existing schema-generation call can now select an explicit version-1
presentation policy. Absent/report retains legacy behavior. Value mode binds
one required, nonnullable, non-file field and validates text or JSON encoding.
The workflow publishes the canonical answer before durable completion; the
actual UI escapes and displays it, and notification delivery preserves its
exact text. This adds no model call or task-wording heuristic. Files, payment,
approval, error paths and full prior history retain their existing authority.

Independent reviews exposed and closed four revisions' gaps: notification
argument scope; feedback during finalization; changed schema before rendering
and during final post; and accepted feedback during initial schema loading.
V5 captures the verified revision pair synchronously at entry before any await.
It checks that pair through startup, drain, schema load and subsequent awaited
publication phases. New schema acceptance cannot reverify an old result, even
with identical fields. Loaded value policy is selected only after authoritative
schema loading. Supersession leaves feedback intact and restores nonfinished
state. Already-written answers stay in history; no atomic transaction with
future signals or retraction of dispatched writes is claimed.

Exact approved patch SHA256:
6d3d34783bbd4d3a22d53b9b244d9b8c181c5ec3d27dd560aee5e3d4438c49a3.
Fresh independent reviewer C found it GROUNDED. The 19 reviewed paths are
applied byte-for-byte over qualified parent
292d2ec4370a3075cf0d6889b8b84894d7fdce14; each preimage equals reviewed source
4016ffaf50aeee0eff1b242d9e348f54896fdc02 and each new path was absent.

## Verification

Original workflow and UI controls fail the explicit-value capability; candidate
controls pass. The exact reviewer accepted-during-load reproducer completes
old 4 on V4 and refuses superseded completion on V5. Thirteen selected registered
workflow controls include 28 phase/pending-or-accepted/same-or-changed-shape
combinations, legacy reports, schema loading, persistence and prior race cases.
Actual notification entrypoint controls cover legacy/value sends, deduplication,
definitive and uncertain failure, and validation before claiming delivery.
API/schema and real UI controls cover binding, file rejection and safe text.
Post-apply qualification and all output hashes are recorded in the handoff.

## Human feedback

The coordinator required actual user-facing delivery, not a judge projection,
and a complete await-boundary review after independent race reproducers. All
source edits stayed isolated from the active run; application followed exact
independent V5 approval. No live policy selection, production outcome or
historical task pass is established by the offline controls.

## Reusable lesson

Bind final presentation to an explicit validated contract and bind completion
to the revision whose result was verified. Accepting a replacement schema,
even one with identical shape, does not validate the old answer.
