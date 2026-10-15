---
id: 2026-10-15-sms-recipient-account-lookup-cause-unresolved
date: 2026-10-15
title: SMS sign-in selected personal contact and stopped at unknown-account lookup in two campaigns
surface: agents
component: browser-auth-identity
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native input_text chose personal phone rather than exposed minted phone; site withheld SMS at unknown-account lookup; deepest cause unproven
symptoms:
  - sms_request code_withheld unknown_account
  - Personal phone submitted while different minted phone exposed
  - Authentication assistance after wait resend wait
  - Tree stalled while awaiting authentication assistance
tags:
  - sms-otp
  - recipient-selection
  - auth-identity
  - unresolved-cause
sources:
  - commit e576489611da771499791db3980d78a1db8c5c02
  - agent 6e4a0042-20a3-4cb1-8549-889fd9784f59
  - fleet run 6c8aa5ec-08e4-4789-933c-435d212caa23
  - commit a6ae9954c6d93ef1008811775f5750181bf036f1
  - agent c3673856-71e8-4e79-bea1-4e4561a74179
  - fleet run 1f31c369-987e-40bd-af95-637fe158ef51
repro: original native dumps and sanitized retained-file extractor; no proven causal owning fail-pass correction
status: open
---

## Problem

Original e576 browser-auth-minted-sms-otp root6e4a0042-20a3-4cb1-8549-889fd9784f59
terminated FAIL811.9s. Native originating browser_use_step_5 dump
1792009507562-92ed2cbef068 selected a literal personal phone rather than exposed
minted phone. Sitec0e5c7a33622 withheld two requests as unknown_account at
20:25:14.826 and20:27:35.328UTC. Original verdict and clocks remain immutable.

Frozen a6ae campaign task rootc3673856-71e8-4e79-bea1-4e4561a74179 initially
remained RUNNING after assistance, then native controller recorded FAIL749.8s.
Browserb9c80fb7-b577-5f9c-a313-7ebe434f2c48 step6 dump1792021737369-74e7ab4d997a
selected the same literal: boolean comparisons show equal to Personal Information
phone and original e576 input, unequal to exposed minted phone. No placeholder
substitution caused the mismatch. Sitea48018f467dd withheld SMS at23:49:04.756
and23:50:17.382, reason unknown_account. Native wait60000ms/resend/wait60000ms,
then step11 assistance dump1792021894158. Propagation refs0/applied0.

Controller later found root silent516s, threshold510s, cost_idle516s, statusACTIVE,
messages61 and one nonterminalleaf, then paused it after early-fail. This RCA did
not intervene. Pending snapshots and genuine final verdict were separately retained.
No phones, addresses, OTPs or credentials are embedded in this case.

## Diagnosis

The recurrence is observed recipient-selection/account-lookup behavior, not a
proven common deepest cause. serviceSignInMethods.ts112-124 returns unknown_account
before random code generation, site.codes insertion, sendSms or local mock-inbox
delivery. Neither recorded request reaches provider delivery or inbox extraction/
admission. This is not evidence of carrier failure or the email late-input race.
Unexercised downstream capabilities are not declared healthy either.

Actual captured global instruction already says OTP codes from email or SMS are
automatically injected, with60s then resend then60s exhaustion. The experimental
extra phone receipt label was withdrawn and is absent from a6ae native context;
this run does not test that candidate. Missing generic SMS guidance is not proven.
Actual tool says try SMS OTP if available and minted account when it has an email;
method-plus-recipient exhaustion and phone-only minted use are not explicit there.
Those are possible contract ambiguities, not established explanations of the choice.

Task names no phone/account identifier. Personal contact is not a verified site
login or receipt guarantee. Minted enabled inventory likewise does not prove
registration. The fixture internally seeds minted membership; the model sees a
conditional anti-enumeration response, not server-side unknown_account. AgentPhone
relay selects AgentIdentity phone; a separate iMessage relay also exists, so personal
messages cannot be declared universally unreachable without further evidence.

The problem_class bucket is provisional contract-review categorization, not a proven
logical inconsistency. No model-intelligence classification is supported. Earlier
isolated SMS renderer tests or a one-pair outcome do not prove why current choice
occurred; do not adopt the prior missing-capability theory by symptom matching.
Archive searches: SMS unknown_account literal phone minted inbox; code withheld
wrong recipient authentication assistance. Prior unadopted SMS candidate archive
is related investigation evidence, not an established repair. Existing email
pre-send case is a different first observed boundary and remains unchanged.

## Solution

No repair selected or adopted. Read-only trace used retained dumps, backend/controller
logs and source. Current investigation ran no model calls, browser actions, inbox
polls, DB mutations, canonical retries or prompt changes. Original prior paid attempt
records remain preserved; no new costs or resets invented.

Mandatory Step5b remains INCOMPLETE. C0 method-recipient exhaustion wording is too
narrow to choose before factual applicability is understood. C1 authentication
identity/receipt/applicability provenance is a concrete non-prompt investigation
candidate. API contains phoneProvider and hydration preserves auth_options;
renderer does not surface that field but retains phone/email association and
private credential refs. The actual raw API provider value was not found in retained
native evidence. Source field insensitivity is not proof it caused this choice.

C2 evidence-bearing applicability across all authentication actions remains coherent
but unproven. Lack of causal evidence does not establish incoherence. Universalizing
to eliminating all browser uncertainty is an exaggerated C3, not a valid failed
natural next rung: typed unknowns could preserve provenance without inventing
registration. No deepest coherent class or failed-deeper-coherence proof is certified.
Therefore no prompt-edit gate has passed. Earlier UNAPPLIED wording is design
history only; no reinstated SMS label, forced identifier or schema repair follows.

Next separately scoped proof must establish actual source facts corresponding to
native context and a meaningful unchanged owning baseline-fail/candidate-pass,
then actual model and canonical outcome evidence. Controls must preserve explicit
account restrictions, unknown registration, null/disabled capability, personal
contact vs connected receipt provenance and legitimate user-only approval; CAPTCHA
retains existing challenge recovery, not authentication assistance. Static new-text
assertions or mocked actions alone cannot establish model/canonical repair.

Workspace evidence: /home/boxes/rose/.context/auth-deploy/sms-final-readonly-rca/
findings.md, evidence.json, status-snapshots.jsonl, handoff-proof.json,
abstraction-climb.md and abstraction-climb-proof.json. Read-only reproduction:
`python3 .context/auth-deploy/sms-final-readonly-rca/extract_evidence.py`.
It only reads retained files; records exact dump hashes, recipient correspondence
booleans, all19native browser calls and sanitized site/controller facts. No current
raw inbox, phone or code is queried. Read-only peer review confirmed boundaries
and required the incomplete climb/evidence-gap qualification. No reference-driven
fix was selected and no approval-ready correction is claimed.

## Human feedback

Parent required preserving pending versus terminal status, no live intervention
or paid replay, no enabled-equals-registered inference, no forced recipient and no
assumed missing-capability cause. It rejected treating missing causal proof as
failed coherence, accepted Step5b as incomplete and authorized only this OPEN
archive follow-through in a new isolated tree. No runtime adoption, push or change
to active review head was authorized. Freedom and protected instructions preserved.

## Reusable lesson

Record recurring recipient mismatch without promoting it into a shared root cause or prompt repair until provenance and causal owning proof are established.
