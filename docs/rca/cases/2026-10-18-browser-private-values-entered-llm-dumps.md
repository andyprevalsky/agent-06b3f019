---
id: 2026-10-18-browser-private-values-entered-llm-dumps
date: 2026-10-18
title: Browser private bindings were not applied to initial and late LLM dumps
surface: agents
component: observability
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers.observability dump_llm_context and update_llm_dump publication
symptoms:
  - registered canary appeared in the initial LLM dump
  - late dump updates must obey the same policy
tags:
  - phone-harness
  - browser-credentials
  - credential-redaction
sources:
  - plan:.context/phone-harness/rose-phone-privacy-before.log
  - plan:.context/phone-harness/rose-phone-late-dump-before.log
  - plan:.context/phone-harness/rose-phone-privacy-exact-after.log
repro: agents/tests/blackbox/browser_credentials.blackbox.py:test_phone_canary_never_reaches_stream_dump_or_resume_turns
status: fixed
---

## Problem

While preparing cloud-phone credential handling, the owning browser credential
test registered a synthetic private binding and sent it through the actual LLM
dump functions. The initial dump contained the canary. After protecting initial
publication, the unchanged test separately exposed a late-update leak. No real
password was used.

## Diagnosis

Archive search for phone, secret, stream and capture found the companion phone
HTTP-capture case. Its transport policy does not protect model artifacts. The
critical path here was task-local private bindings -> observability payload ->
archive/public dump, followed by response updates through a second entry point.
Execution logging already understood those bindings; both dump entry points
published without applying that policy.

The retained pre-fix logs show the exact assertions failing in
test_phone_canary_never_reaches_stream_dump_or_resume_turns, first on the initial
file and then with `late dump updates must obey the same policy`. The local
driver was `python /tmp/rose-phone-narrow.py` from agents with its venv active.
That driver invokes the existing owning tests; it is not an integration client.
Its source is preserved in the gitignored evidence directory. These initial
failures were focused test executions, not a claim that the whole normal suite
was run on the buggy revision.

## Solution

Apply the existing context-local redactor before initial archive/publication and
to every optional late-update field. Do not resolve private references into the
model request. Preserve browser-turn references and filter phone transport
capture separately at its owning HTTP boundary.

The exact local driver passed after the fix (25 focused tests, exit 0), recorded
in rose-phone-privacy-exact-after.log. The permanent assertion also runs through
the normal browser-credentials blackbox suite, which passed, including the
initial/late-dump and resume-message checks. The normal multi-domain runner also
passed before the subsequent independent split-stream privacy extension.

The deploy agent blackbox gate discovers browser-credentials. This adds constant
per-artifact work over the current task's registered values, with no cross-agent
collection, subscription, shared lock or credential cache. It does not prove
redaction of unregistered values, unknown encodings or media. The separately
reproduced split-delta publication issue has its own RCA and regression.

## Human feedback

The user required cloud-only phone integration and credential attention at the
blocking screen. Real credential onboarding remains a later milestone.

## Reusable lesson

Apply the same task-local credential policy at initial artifact publication and every later update entry point.
