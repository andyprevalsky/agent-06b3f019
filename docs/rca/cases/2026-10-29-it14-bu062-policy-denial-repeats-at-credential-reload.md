---
id: 2026-10-29-it14-bu062-policy-denial-repeats-at-credential-reload
date: 2026-10-29
title: It14 BU062 non-public navigation denial repeats at the mandatory credential reload
surface: agents
component: browser-credential-reload
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: native Page.navigate refuses the citation destination as non-public; the resolved address and denial initiator are not captured
symptoms:
  - navigation to a non-public address is blocked
  - ERR_ACCESS_DENIED
  - credential_reload_error RuntimeError
  - Browser supervisor recovery budget exhausted
tags:
  - polar
  - it14
  - r52
  - navigation
  - credential-reload
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent 8b1e251a-4499-4f4a-a7ca-486d85c07a57
  - plan: archive c90978909b4f619909fb906cc4302846f7a93248d190b3696e0edef757cd42d1
repro: none-recorded
status: open
---

## Problem

The original task asks for the latest chronological year written in an image on
the first citation-reference destination from Carl Nebel's Wikipedia page as of
August2023. The normal sealed run on source85/no patch ends nativeFAILED after
328.0seconds. Canonical r002-j0032 is FAILED at03:30:41.675608Z, infraFALSE, with
`Agent status: FAILED (expected COMPLETED)`. Root progress1 is not a completion
verdict or task PASS. No final answer or completion verifier is recorded.

Archive SHA256 c90978909b4f619909fb906cc4302846f7a93248d190b3696e0edef757cd42d1;
normal manifest81974fa6aa66b3f3eea859a642b5d067e3db984513431175858ff622ca27a920.
All seven normal member lengths and hashes independently verify. This is not
an unsealed infrastructure incident. Scope and original grade remain unchanged.

## Diagnosis

The actor inspects Wikipedia revision1168855983 and follows references. An
original evaluate result lists the first reference as Thieme-Becker and another
as the Sloan Rare Books auction. Whether the chosen reference satisfies the
wording is not resolved by this intake. The last navigation at03:24:08.200Z is a
click on the captured Sloan link. At03:24:32.455964Z, read_browser_state records
its public-looking HTTP hostname with an actual error document: no interactive
elements, This site cannot be reached, ERR_ACCESS_DENIED. That observation is
not a successful fetch of the requested image.

The following credential-realm preparation completes at03:24:32.454807Z.
The mandatory reload fails at03:24:42.652599Z with native code-32000 and
`navigation to a non-public address is blocked`. The original traceback runs
through handler.py10321 reload_event.event_result, browser-use navigation and
CDP Page.navigate. The exception's source is below the Rose navigation call;
this packet does not retain the resolved IP, redirect chain or policy decision
that classified the destination. A hostname that looks public is not evidence
that bypassing this restriction is safe or correct.

Eight credential_reload_error recoveries run from03:24:53.871471Z through
03:27:17.918486Z, each bring_to_front/press_escape on chrome-error. At
03:27:29.999137Z, the existing shared budget is exhausted. Browser automation
fails, then root status becomes FAILED at03:27:42.414115Z. No additional model
choice or response is recorded during the mandatory reload loop.

Source85 keeps pending_credential_reload_realm until both event completion and
navigation readiness acknowledge. Its generic recovery continues before the
next model call, so it repeats this denial rather than clearing the barrier.
The current navigation guard can return an ordinary refusal for known unsafe
literal URLs before dispatch; _execute_goto reraises this native error class.
There is no typed native policy-denial disposition that also quarantines the
credential binding while safely allowing navigation-only alternate research.
Clearing the pending barrier would assert an acknowledgement that never occurred.

Searches were `non-public address blocked` and
`credential_reload_error chrome-error recovery`. The R35 dictionary-navigation
case and its Solution/Human feedback were read. Its unguarded reload exception
was repaired and the guard demonstrably runs here; this is not recurrence of
that escaped-exception mechanism. The restriction itself and a safe alternate
control-flow repair remain unproved. No provider/host failure is inferred.

## Solution

OPEN; no runtime candidate. A general repair would need an authoritative native
policy-denial contract and a tested state transition retaining unfulfilled
credential obligations while permitting only safe alternate navigation. This
packet alone does not establish that contract. Do not bypass private-address
protections, reinterpret the public-looking hostname, clear pending credentials,
raise the eight-recovery budget, or convert this failure into a PASS. No model,
browser, provider, DNS, DB or network call was made in the investigation.

## Human feedback

The coordinator requested bounded investigation of repeated policy refusal and
ordinary actor-feedback capability, while preserving reload acknowledgement,
privacy and native policy. No task, criterion, prompt, cap or provider-policy
change was authorized. Source85 and the live owner remain untouched.

## Reusable lesson

Preserve the unacknowledged credential barrier when a native navigation policy
rejects the destination, and require an owned safe alternative transition before
turning that denial into continued model execution.
