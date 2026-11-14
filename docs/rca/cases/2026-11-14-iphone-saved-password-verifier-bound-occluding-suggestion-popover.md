---
id: 2026-11-14-iphone-saved-password-verifier-bound-occluding-suggestion-popover
date: 2026-11-14
title: iPhone saved-password fill reported "filled" after the binding verifier picked a point on an account-suggestion popover covering the Google password field
surface: back-end
component: phone-credential-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/phoneCredentialVerifier.ts PHONE_MULTI_CREDENTIAL_PURPOSE — allowed a binding and returned an inferred password-field point while suggestion rows covered the field and no password label or placeholder was observed
symptoms:
  - phone_credential_binding_required
  - credentialStatus filled
  - Enter a password
  - fill_saved reports filled but password field empty
  - AutoFill
tags:
  - iphone
  - saved-password
  - google-sign-in
  - llm-verifier
  - ocr-grounding
sources:
  - agent f1802539-7e5d-5a76-9028-133ad4e9fb75
repro: back-end/src/tests/unit/phone-saved-credential.google-semantic-fixture.json replayed by back-end/src/tests/unit/phone-saved-credential.cases.ts (sanitized prod occluded screen must not bind; visible unfocused and floated-label fields bind on the field)
status: open
---

## Problem

Prod 2026-11-14, Gmail Add Account Google sign-in on the cloud iPhone (lease c5b5d796). `credentials.fill_saved` at cursor 158 (18:35:30Z) failed `phone_credential_binding_required`. After a fresh `screen.text` (cursor 159) showing the same content, the retry at cursor 160 returned `credentialStatus: filled`. The next observation (161) still showed the unfocused empty placeholder "Enter your password", and after Next Google answered "Enter a password". The earlier prod fill (lease 65f9bf99, 06:39Z, cursor 143) did land: Next went to 2-Step Verification. So paste-mode `input.text` (`keystrokes:false`) works in this field.

## Diagnosis

Observations 157/159 show a stale account-suggestion popover ("andyprevalsky@yahoo.com" y≈764, "home" y≈804) left over from the email step and sitting over the password field. No password label or placeholder was observed (on the uncovered screen 161 the placeholder is at y≈792). The exact verifier request was rebuilt from the journal: system purpose, expected identities, the redacted cursor-157 observation, and bounds {0,0,750,1334} found in the planner dumps. Replayed through the same `verifyPhoneCredential` path (rose-1-mini, served by gpt-5.6-luna-foundry), the current prompt gave 15/20 ALLOW with points y 764–835 on the popover rows and 5/20 DENY. That one non-deterministic verdict explains both prod outcomes. 158 reached the verifier, as its `phone_saved_credential_binding` toolUsage row was billed at 18:35:38.092Z, the same second the op failed, so it was a DENY (the binding error), and 160 was an ALLOW whose `input.tap` hit the popover, dismissed it and focused nothing. `input.text` then typed into no field, and the service reported `filled`, because it has no post-condition and the bound point was not journaled.

Why possible: the purpose allowed any "identifiable" password field and accepted an inferred position. Nothing required that the field itself be observed. Step 5b climb: the class is "binding coordinates must be grounded in an observed element of the target field". The next-deeper class, a deterministic server check that x,y lies on a password-field OCR box, needs a string classifier of field labels (banned, rule 25b), so the grounding stays in the semantic verifier.

## Solution

1. Both password-binding purposes (Apple and Apple/Google) now require locating the field from its own observed password label or placeholder (a floated label counts). They require allowed=false when suggestion rows or another overlay cover the field, both when that leaves no label observed and when the field is covered while its label stays visible (the second clause came from a CodeRabbit finding). Same replay, n=20: occluded 157 went 15/20 ALLOW to 0/20; the controls kept 20/20 ALLOW on the field (morning 140 unfocused, 142 focused with a floated label). Rejected wordings: "the field itself must be observed" (control 142 fell to 12/20) and a single merged covered-or-unobserved sentence (occluded back to 2/20 ALLOW).
2. The planner guidance (agents PHONE guidance) now says that when account suggestions or another overlay cover the password field, the agent must first dismiss them with an observed tap away from the field, then observe and fill again. Exact replay of the prod planner call at step 159 (claude-opus-5-5, after the binding error, on the covered screen): old guidance 5/5 `credentials.fill_saved` retried on the covered screen; new guidance 4/5 tapped the observed "Welcome" heading to dismiss the popover first (1/5 retried, which the fixed verifier now refuses).
3. A successful fill logs the bound tap point (`[IPhoneSavedCredential] saved credential bound`, with no secret), closing the observability gap that hid the wrong target. The stored result stays redacted to the model contract.
4. Regressions: `phone-saved-credential.google-semantic-fixture.json` (sanitized prod observations; every recorded verdict unanimous over 5 live calls under the new purpose) pins the purpose and asserts the occluded screen and a controlled synthetic covered-with-visible-label variant (5/5 DENY) are refused, while visible fields bind between the account row and "Show password". The agents rose-browser-use blackbox pins the guidance digest and asserts the new dismiss-then-refill sentence. The Apple fixture was re-recorded under the new purpose (all 5 cases unanimous, same verdicts), and the iphone-control saved-credential case asserts the fill taps exactly the bound point.
The device-passcode purpose is unchanged: its native full-screen passcode UI has no web suggestion overlays, and no evidence implicates it.

Remaining gap: the service still reports `filled` without a post-fill check, because masked secure-field content is not OCR-visible and a deterministic check would need a banned string classifier. The verifier remains an LLM, so 0/20 is a measured rate, not a guarantee.

## Human feedback

Coordinator relay (11-14): the fix must make the saved password land with no user typing, covered by the iphone-control blackbox suites registered in /deploy.

## Reusable lesson

When an LLM binds a tap target from OCR, require it to cite the target's own observed label and refuse inferred positions; an overlaid suggestion list otherwise turns a "filled" receipt into a silent no-op.
