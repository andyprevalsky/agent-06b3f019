---
id: 2026-10-29-it22-bu085-http429-before-credential-reload
date: 2026-10-29
title: BU085 destination HTTP429 persists through guarded credential reload
surface: agents
component: browser-credential-reload
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: The clicked paper destination returns HTTP429 before credential reload; the guarded pending-reload loop cannot obtain a successful navigation acknowledgement
symptoms:
  - "HTTP ERROR 429"
  - "credential_reload_error:RuntimeError"
  - "Browser supervisor recovery budget exhausted"
  - "Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE"
tags:
  - polar
  - bu085
  - it22
  - navigation
  - credential-reload
sources:
  - commit 573847c1ea6ffbc28405d3ec29e39d8f86a5c2e8
  - agent 6984f041-af2b-4b87-85cf-774d0a01c0c4
  - plan:.context/r86/proof.json
repro: none-recorded
status: open
---

## Problem

It22 BU085r1/r001-j0005 asks for the year of a parent's death in a research
paper's dedication, using university, author and submission clues. Source573847,
patch none, ends nativeFAILED after175.8s with progress1. Canonical status is
FAILED, producerinfraFALSE, with Agent status FAILED expected COMPLETED.
Progress1 is not a completion verdict. No semantic judge result or final year is
recorded. Aggregate LLM usage0 does not negate the recorded browser actions.

## Diagnosis

Archiveaf369875858842549cb09475d528226aa48318b9d0f7d45f8c778d95f97739d2,
manifest3ba4b6281dda20902d2c87ed8a6f82c777475ab081ac200563f7835449b58a7d,
and all seven original member sizes/hashes independently verify. Normal run SHA
9d7ea231df2bc009f8b1a47fbad5ea833cef0b3d4c8847d06ec69afeb5673283 and worker
SHA0f3834b42ef8e0730d20a0c5d949eba5ef6bae62ec1088e2a4d6c98b044b6638
bind the following chronology. Supplemental lifecycle and driver are distinct
from the normal manifest.

Action19 clicks captured element3795 at23:12:09.442957Z; the click handler
reports success at09.446355Z. The destination is the Harvard repository
bitstream883c4a98-063a-4cf1-be0a-ca1ee35d1a40/download. Original worker line10904
records HTTP429 for that URL at09.638944Z, before credential preparation and
reload. The network recorder reports body paths and183913bytes, not truncated;
those body files are not delivered in this normal packet. Repeated recorder
lines are not counted as independent network requests.

At09.837020Z, worker line10918 reports zero cookies and zero local-storage
entries applied. At09.890406Z, line10921 records successful realm preparation:
auth_realm harvard.edu, password_count1, passkey_count0,
passkeys_newly_injected0, cookie_source none, cookies_injected false. Thus one
saved password was available; absence of injected state is not absence of
credential inventory. No credential secret was inspected or reproduced.
The source's authoritative realm matcher permits harvard.edu to own the
subdomain. It does not prove the destination successfully loaded.

The subsequent mandatory reload fails with ERR_HTTP_RESPONSE_CODE_FAILURE.
Eight original recovery events run from23:12:10.460095Z to16.960909Z, each using
bring_to_front and press_escape on chrome-error with HTTP429 visible. The
shared eight-recovery budget is exhausted at17.411095Z. At17.413999Z, the
original traceback points to handler.py10375, reload_event.event_result;
browser-use session.py1085 raises the native navigation error. The activity
fails, then the manager receives ActivityError and root status becomes FAILED
at23:12:39.300757Z. This is a native failure before a semantic judgment.

Exact source handler10345–10390 retains a pending realm reload until navigation
and readiness acknowledge. Its exception guard demonstrably runs here. The
previous R35 unguarded-error repair is therefore not failing to catch this
exception; its bounded recovery is exhausted. Successful preparation can set
the reload obligation independently of cookies_injected. The delivered records
do not establish a safe alternative transition that preserves pending
credential/binding obligations while letting the actor navigate elsewhere.
Clearing that obligation merely to continue would assert an ACK that did not
occur.

The related R52 case,
2026-10-29-it14-bu062-policy-denial-repeats-at-credential-reload, was read after
the original trace. It is a control-flow comparator, not an asserted shared
cause: R52 records a non-public-address policy denial; this run records a
public destination's HTTP429. Neither establishes a provider outage. No
underlying rate-limit policy, response-body cause, or safe retry interval was
inferred.

## Solution

OPEN; no runtime candidate. The original destination rejection and a safe
pending-reload alternative are not causally repaired by skipping credentials,
raising recovery limits, rewriting the task, or changing an answer. No model,
browser, provider, native, DB or replay call was made, and no tests were invented
to encode an unsupported behavior change.

The original cleanup remains separate and positive: Tilion session
sess_98241cb952e940b68dfdf4a6c9a95dde DELETE204, root deleted and tree sealed,
with empty cleanup errors and warnings. The intermediate Browser session
cleanup failed message does not erase the final original cleanup receipts.
No campaign stop or infrastructure reclassification was made from this case.

## Human feedback

The coordinator required exact click, realm preparation, pending reload and
terminal-error ordering; one saved credential must not be described as none.
The native status gate must not be mistaken for a semantic evaluator failure.
Preserve the source freeze, original grade, and bounded investigation.

## Reusable lesson

A click handler can succeed while the destination returns an HTTP error.
Credential inventory, injected browser state, navigation acknowledgement and
final provider cleanup are distinct facts. Trace each before proposing an
exception-policy or authentication change.
