---
id: 2026-10-27-neutral-browser-worker-required-auth-realm
date: 2026-10-27
title: Neutral browser initialization reached a worker that required a web authentication realm
surface: harness
component: browser-credential-hydration
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_realm_credential_state rejected the backend's complete empty inventory for an exact about:blank initial page
symptoms:
  - Credential payload is missing auth_realm
  - browser_error_context Failed during initialization
  - native browser recorded zero trajectory steps
tags:
  - polar
  - browser
  - neutral-start
  - credentials
sources:
  - commit b0853214450c5716f648a863c8003fede03361b2
  - agent 7b776af3-a3fa-4ed1-b02b-2d9def7fb9ed
  - agent 4b4c9f25-b555-5409-aec4-b601b7f6f2a3
  - benchmark run Polar k2 iteration2 all20 members
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

The unchanged Polar k2 iteration2 cohort (BU001–BU010, two copies each) produced
20 task FAILs. Each created its native browser, then failed before its first
step. All20 raw run.json files were independently checked against the launch
owner's SHA256 inventory. All contain RuntimeError `Credential payload is
missing auth_realm` with `Failed during: initialization`. Durations were
13.6–55.4 seconds. Producer TASK FAIL/infra_failure false is preserved; this is
not reclassified as an infrastructure verdict.

## Diagnosis

BU005 root `7b776af3-a3fa-4ed1-b02b-2d9def7fb9ed` called its native browser to
complete the public Shadow DOM form. Backend initialization used `about:blank`
at20:22:51.087Z and successfully created Kernel session
`u4b9s2pl0womyi8pthx2p23x`. Browser task
`4b4c9f25-b555-5409-aec4-b601b7f6f2a3` started20:22:55.576Z.
At20:22:55.607493Z its worker failed in `_process_data` calling
`build_realm_credential_state`, which unconditionally required a nonempty realm.
It posted terminal failure20:22:58.874Z. No browser model/action had run.
The last root LLM call was successful response_schema on qwen-3.8-27b.

The earlier R1a fix correctly made the backend's neutral start return a
complete empty authentication inventory. Its producer fixture did not exercise
the worker consumer, whose strict web-realm assumption remained. This is a
follow-on integration boundary, not recurrence of the backend realm-preparation
error. The adapter still preserves the original task and browser substrate.

Archive searches were `Credential payload is missing auth_realm` and
`neutral browser credential hydration about blank`. The neutral backend-start
case is a direct relative; realm-transition cases require real target-specific
credentials and do not justify inventing a realm for blank pages.

## Solution

The proposed worker correction accepts a missing realm only when the caller
supplies exact `about:blank` and the complete payload matches the backend's
empty inventory with no password/passkey data or selected credential. It
creates no secret refs, attempted auth paths or auth prompt section. Default
hydration and the nonempty-realm path remain unchanged.

Initialization supplies its explicit start URL. Resume supplies the backend
current/saved/start URL and never borrows the old caller start URL if those are
absent. The caller preserves the backend's explicitly empty options realm so a
web URL cannot silently relabel a neutral payload. JIT target preparation and
realm matching are unchanged.

## Verification

The actual TS producer functions, with provider/persistence seams replaced,
return the complete neutral payload. The actual Python hydrator fails on that
payload with the original error. A registered real-activity integration control
also fails at that same call before a step. The candidate permits that activity
to reach exactly one synthetic browser step and its existing drain checkpoint.
Five activity controls cover fresh blank, supplied-neutral blank resume,
web+neutral refusal, unknown resume refusal, and the existing HTTPS path.
All50 credential controls pass, including malformed context and nonempty
credential categories. Existing initial-auth, redirected-JIT and quarantine
controls pass. These are deterministic causal tests, not benchmark outcomes.

Blank resume evidence is deliberately limited: that control supplies the
neutral protocol, while the actual resume endpoint currently omits auth_options.
Its legacy behavior is not repaired or claimed validated by this change.

The launch owner reports campaign exit20:29Z with all20 fleets verified,
ownership removed and native release confirmed. No resource operation,
benchmark rerun or deployment was performed in this investigation. Freedom
and its protections were untouched.

The evidence publisher recovered/rendered the last root response_schema call.
Its HTTPS rendering was published and independently read back with HTTP200
(45156 bytes); initial read-only shared-agent FE verification returned HTTP404. I12 then
published the exact captured run through the supported publisher, restoring
HTTP200 with15 messages. The real browser validator still rejects it: three
task-complete rows and zero recording events/pointers. Initialization failed
in the gather before recorder creation; no recording is reconstructed or
fabricated from that absence. No recording-verified
FE link is claimed. Evidence, exact all20 hashes, candidate/repro scripts and
logs are retained under `.context/polar-r1b/`.

The exact proposed patch SHA256 is
`86e5c336f7b2673acbedcb29e044c45144a5e8e6b8f01b7c12045745c9c849da`.
Independent reviewer `ph713pr5yxbgrhp4j9d1tdvvqh8h2c2y` marked each runtime
hunk GROUNDED, but the full approval remains NOT_GROUNDED because the required
recording validation fails (shared-agent API recovery is now complete). The patch has not been applied. I12 is
investigating publication using the existing artifacts; no paid rerun was
launched to obtain approval evidence.

## Human feedback

The parent required read-only triage while the campaign was live, preservation
of TASK FAIL unless evidence justified a different classification, no task edit,
no paid rerun, and independent exact-snapshot GROUNDED review before runtime
application. The reviewer required explicit web/unknown resume negatives and
rejected stale original-start context as authority for a resumed page.

## Reusable lesson

A neutral browser is a valid session with no web-origin credential inventory.
Exercise both producer and worker consumer, and keep explicit neutral state
separate from missing or stale web credential context. Local causal proof does
not establish the unchanged task outcome.
