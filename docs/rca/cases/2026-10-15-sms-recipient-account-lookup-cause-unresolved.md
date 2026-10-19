---
id: 2026-10-15-sms-recipient-account-lookup-cause-unresolved
date: 2026-10-15
title: SMS sign-in repeatedly selected personal contact and stopped at unknown-account lookup
surface: agents
component: browser-auth-identity
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native input_text selected site-normalized personal phone rather than exposed minted phone; site withheld SMS at unknown-account lookup; deepest cause unproven
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
  - commit b5475e5be1f98e48e709298c0afcd2ea2e550ce7
  - agent 52009298-8865-406e-b5a9-8ff7ea129f3c
  - fleet run 574dc22f-ad9b-4df1-818c-33b496d5841b
  - commit f27a20070f7f74f343959760bd54bb1c0119c3ff
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
admission FOR A NEW SITE-ISSUED VERIFICATION CODE. Background inbox polling is
not excluded; this is not a claim that no inbox reader was invoked. This is not
evidence of carrier failure or the email late-input race, and these downstream
capabilities are not declared healthy either.

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
logs and source. The initial read-only investigation ran no model calls, browser actions, inbox
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

### Bounded native correction observed on October16

Preserve every original failure above. Later598 SMS root3c2cf2a6-5d71-4ae4-b3c1-0b8e8dcb3c78 genuinely FAILED615.4s, while paired signup passed222.3s. Exact unchanged SMS onf27a20070f7f74f343959760bd54bb1c0119c3ff then PASSED360.8s, root8946aed5-52f0-4bc9-ab43-fdbad862e671. Initial input still differed from the rendered supplied phone, so this is not proof that initial identity-selection causality is resolved. The new independent handoff judge actually returned0.5 on Sol Foundry, rejecting an unsupported conditional-page handoff; ordinary planner continuation selected the supplied phone, used a code matching an injected SMS USER message, and reached completion1.0/nativePASS. No hidden membership lookup or automatic identity switch was added.

See 2026-10-16-auth-handoff-preconditions-not-independently-verified for owning before/after controls, unchanged catalog hash, exact native receipts, cleanup and durable publication. Its bounded semantic transfer correction does not retroactively prove a single deepest cause for all historic recipient-selection behavior. Full30 auth regression was not run at the f27 pair checkpoint and is now root-reported RUNNING/result PENDING; this original cause investigation remains OPEN without waiver, universal identity grading, model-upgrade claim or deployment approval. Prior source diagnostics and pending snapshots remain retained.

## Human feedback

Parent required preserving pending versus terminal status, no live intervention
or paid replay, no enabled-equals-registered inference, no forced recipient and no
assumed missing-capability cause. It rejected treating missing causal proof as
failed coherence, accepted Step5b as incomplete and authorized only this OPEN
archive follow-through in a new isolated tree. No runtime adoption, push or change
to active review head was authorized. Freedom and protected instructions preserved.

## Reusable lesson

Record recurring recipient mismatch without promoting it into a shared root cause or prompt repair until provenance and causal owning proof are established.


## 2026-10-15 approved-b547 recurrence — native FAIL736.6s, cause still OPEN

Approved sourceb547, runauth-approved-1792101206, group574dc22f-ad9b-4df1-818c-33b496d5841b,
root52009298-8865-406e-b5a9-8ff7ea129f3c, browser task
e48113d3-9d47-57d1-8b13-c7d8c9206583 and public site39cb4aab94c2 repeat the observed
recipient/account-lookup boundary. This is observed recurrence, not proof of a
shared deepest cause. Classification remains unresolved and status OPEN.

Input step5 dump1792102820302-235b7f01736b-browser_use_step_5.json SHA256
2e0693614ab052acfccc5ade8abcd900b26c0b8f8f5a01d3209c48d970b491ae uses a literal
national-format phone. Raw string equality with the older personal input is
false; EXACT site normalization removes nondigits and prepends1 to ten digits.
Under that rule, submitted equals Personal Information and the original e576
recipient, and differs from the exposed minted phone. Full formatted minted
phone prefixes were checked independently, not just a truncated regex. In-memory
booleans and native typed-result correspondence are retained without exporting
phone/code values.

Backend retained logs31077/31916 record SMS requests at22:20:27.877 and22:21:40.520Z,
both matching the submitted normalized recipient and returning code_withheld /
unknown_account. Source requestSmsCode112-121 returns before random code123,
code storage124, sendSms132 and optional local delivery134. Provider delivery,
inbox receipt, extraction and OTP admission are unexercised FOR A NEW SITE-ISSUED
VERIFICATION CODE, not declared healthy or failed. Background inbox polls did
occur (including20AgentPhoneMessage.findMany reads in the SMS window); the reader
was not globally uninvoked. Funding/live-delivery requirements do not turn an unattempted
send into a provider diagnosis.

Actual wait60000/resend/wait60000 was followed by read_logs and step11 assistance
at22:22:52.780Z, dump1792102972780-235b7f01736b-browser_use_step_11.json SHA256
cef029552ef4d13de2230874329ffea8028986c16b0f6b6e933f68b78a160d7e. Propagation at
22:22:53.053Z records awaiting_auth_assistance,refs0/applied0. The site deliberately
renders a non-enumerating conditional response; unknown_account does NOT occur
in the captured handoff messages. Do not blame the model for ignoring private
server membership information.

### Pending and terminal observations preserved separately

The initial retained evidence and the22:30:09Z card read said RUNNING, and no
terminal failure was inferred then. Native report subsequently records FAILED,
736.6seconds,$0.02,205192input/1085output tokens. This records native attempt
accounting, not an independently verified invoice.

Owned controller `.context/auth-deploy/approved-auth-verification/runner.log`79520
binds the full exact root to TREE STALL: newest-active root silent517s,
threshold510s,cost_idle517s,statusACTIVE,messages56,one nonterminal leaf.
Line79557 pauses that root after early-fail before cleanup;79780 repeats the
full-root failure reason and Agent statusPAUSED(expectedCOMPLETED). The local
report card independently binds the failed task to this root and duration.
These are controller-owned actions, not interventions by the RCA worker.
Earlier pending snapshots, new terminal evidence, original811.9s/a6ae749.8s
verdicts, clocks and healthy sibling activity remain preserved.

### One authorized AFTER-decision stored-identity snapshot

Parent separately authorized one exact owned DB read after positive ownership
proof. Stack/benchmark run IDs, services receipt worktree/run-owned unique DB,
backend process cwd and actual process DB URL database/loopback port matched
before connection. BEGIN READ ONLY/statement timeout/ROLLBACK then verified
current_database, exact root/user and browser-task/root binding, site start URL
and current run task queue. No API/auth-options getter, inbox or provider query
was used; the getter can upsert and was not treated as read-only.

At22:27:44.283Z, existing AgentIdentity.phoneProvider was agentphone. Its stored
phone matched the captured exposed minted phone, not the personal/submitted
recipient. Existing realm MintedAccount was enabled and its account label matched
the identity email. Identity creation22:05:09.909 and minted creation22:19:22.450
predate the choice, but do NOT prove fields remained unchanged. This snapshot is
AFTER the decision, NOT historical API wire, channel health or realm registration.
No phone/email/secret/provider number IDs were exported.

Source authOptions75-88 reads that identity;143-160 conditionally exposes the
minted item, populates its phone independently of provider, and conditionally
sets phoneProvider to agentphone. Phone presence does not prove that provider branch. Browser session forwarding/Python fetch and credential_runtime59-75
deep-copy the raw options. Renderer service_crypto928-963 renders phone, email
receipt wording, enabled state and private minted refs but does not consume
phoneProvider. Genuine state-tool results expose that rendered text. No retained
native dump or positively owner-bound log captures the raw historical field.
This source-derived representational distinction does not imply every API field
must be rendered or establish an omission-caused choice. Current raw provider
association is established only for the later stored snapshot.

Actual global automatic email/SMS and60s-resend60s guidance, the tool's saved
password/emailOTP/SMSOTP/minted-when-email prerequisite and user-only exception
are retained. The goal names no explicit phone/account. No forced minted rule,
registration requirement, capability label, prompt/schema change or intelligence
classification follows. Prior Step5b remains incomplete, not repaired by a
recurrence or a renderer string assertion.

### Concrete next diagnostic boundary

Review the exact step11 assistance prerequisite using a captured operation/identity
ledger: submitted recipient attempted twice and waited, different supplied minted
phone unattempted, email exposed but phone-only current form, no observed user-only
approval, no explicit account restriction and no model-visible rejection. Resolve
whether the EXISTING “that authentication route” exhaustion applies per recipient
or per method, and what the email-specific minted prerequisite requires on this
form, BEFORE selecting an acceptance assertion or source change. Hidden fixture
membership cannot decide that contract.

If an already-existing per-applicable-recipient requirement is established, a
separately authorized bounded ORIGINAL-model exact-call replay can test premature
assistance only when another permitted automatic operation is independently
applicable. Navigation/read decisions remain indeterminate, not successful login.
If method-wide exhaustion is permitted here, do not manufacture a prerequisite
failure; examine task/fixture identity sufficiency separately without editing the
evaluator. Neither branch is an approved policy or fix.

Any separately scoped isolated replay should capture actual auth-options response,
hydrated state and collect-entry wire hashes before submission to close the
historical provenance gap. Provider metadata does not itself prove registration
or require rendering. Existing minted-ref hydration/renderer controls can already
pass baseline and cannot count as repair evidence. A stronger same-Responses model
was not established by the local routing preflight, so a cross-provider Opus swap
would not prove model intelligence with non-model variables fixed.

Private packet `.context/auth-deploy/approved-sms-readonly/` retains evidence.json,
correspondence.json,applicable-guidance.json,db-preconnection-ownership-proof.json,
db-identity-snapshot.json,initial-running-evidence.json,final-status.json,
terminal-evidence.json and next-diagnostic.md. The finite terminal follow-through
reads retained files only; it performs no additional DB/model/browser/inbox/API/
site/provider action or runtime/test/task/criteria/source change. The metadata
append is for a later reviewed batch, not active-head adoption. No direct new
end-user feedback or approval was inferred; parent scope is recorded as such.


## Completed bounded diagnostics — no repair selected

Precision about authority: the ORIGINAL USER asks for the member number, without
naming an account/phone. The ROOT-generated browser goal says not to alter account
SETTINGS or place orders; it does NOT forbid trying other identities. No explicit
named-account restriction is established in this SMS task. Explicit named/current
account restrictions in controls remain legitimate, but cannot be attributed to
this user. Product clarification about trying other eligible supplied identities
has been requested by the parent and is PENDING; no new rule/text is approved.

### Six original step11 decisions, no tool execution

The original-context same-model decision diagnostic completed six Foundry model
POSTs/six logical calls, without input variants or returned-tool execution.
Numeric actions: click, read_browser_state, evaluate, click, authentication
assistance, evaluate. This is1assistance/0input/5other; navigation/inspection is
not authentication success. All actual gpt-6-sol-foundry/Foundry bodies matched
source-reconstructed expected hash
d7f7319078d87937342f96a18afc1e3dae0813a7c4bf0bb6a3981e7cda16ab1d.
Normal original static boundary/cache derivation/settings were preserved; current
owned native environment was used. Historical original wire/deployment and cache
residency remain unrecorded. There is no strict native historical parity claim.

Elapsed sum35.016s; prompt86088/completion1987/total88075; cache creation18/read86070.
Complete USD is unknown, not zero. Four normal-client readonly cooldown GETs plus
one earlier retry GET are retained separately. Two prior stopped preflights sent
zero model POSTs: wrong dotenv backend origin, then a stricter guard blocking an
ordinary Anthropic status GET. These are invocation gaps, not semantic failures
or native routing bugs. No cooldown mutation/key clearing/forced route occurred.
The old six and raw receipts remain unchanged. Exact private packet:
.context/auth-deploy/approved-sms-step11-calls/native-env-status-retry/.
Its16-entry manifest SHA256
c6fbfdf5b4f8958cf25a8ce06f77c4492ede39bc4cecfb7b01e43e2fa9f8cc20.

### One fixed step5 original/factor exploratory batch — NEGATIVE/insufficient repair evidence

Earliest retained step5 summary explicitly mentions absent SMS listing before
choosing personal contact. This is actual provider-returned summary, not inferred
unexposed reasoning; it does not establish an omission-caused failure. A separately
authorized hypothetical readability-association sensitivity experiment modified
only five existing tool auth_context.auth_options snapshots, indexes4,8,10,12,19.
Exact annotation: " (SMS verification codes sent here can be read by the agent)".
No system/tool/task/identity values, post-step5 history, route/exhaustion policy
or hidden fixture registration was inserted. This phrase is NOT selected/adopted.

Current explicitly controlled local-inbox capacity was independently established
from owned backend birth/cwd/run and whitelisted flags plus actual source predicate.
Actual local reader/repo functions with fake owned storage support exact user/
recipient association. This is CURRENT mode with an AFTER-decision identity binding,
not historical API wire, carrier permission/health, delivery or registration proof.
Within exposed minted items the phone is independent of provider; phone presence
alone never proves a historical phoneProvider branch.

Parent executed exactly12POSTs in preregistered O,F,F,O,O,F,F,O,O,F,F,O order:
original6/6 input_personal; factor4/6 input_personal, evaluate(slot6), navback(slot10).
Neither arm selected minted or assistance. Categories are descriptive, not
correct-phone/PASS/FAIL. All twelve HTTP200 logical calls completed with one POST
per slot, zero errors/replacements and no returned-tool execution. Native plural
normalization defines the primary category; individual actions remain retained.
All actual gpt-6-sol-foundry/Foundry outgoing bodies equal independently expected
bodies. Original canonical SHA256
f0f49958a1d4d07ff5dddfce64937f8c76bd6bccc688fc9a164f1aca21325121;
factor34dcaa1c1f96e1ad551d21c7147073e2b43cd535e4ac14a8ddd584857ff15035.
Body difference is input ONLY; systems/tools/config/derived cache key are equal.
Recorded request deployment is the same, not proof of physical backend identity.
Historical wire remains missing. Repeated exposure in five snapshots is the tested
factor, not proof about a one-time UI label or general repair.

Elapsed sum44.772s; prompt133926/completion1555/total135481; cache creation14824/
read119096/uncached6. Six normal owned-origin cooldown GETs are separate. Complete
USD is unknown. Only original slots1/5/8 return nonempty summaries: they speculate
about automatic personal SMS and membership association. Factor summaries are empty;
no claim that factor understood/rejected receipt applicability can be made.
Raw responses/body hashes/request IDs/cache/usage remain private. No contact values
are exported. No significance/equivalence, model intelligence, registration,
authentication outcome or phrase-as-practical-correction claim is supported.

Audit read every retained response/body in NUMERIC order; run summary's embedded
list was lexical. Frozen preparation14entries and old six16entries were unchanged.
Offline actual audit-function fake-transport controls10 plus native-normalization
controls2 passed with zero real transmissions before launch; these support guards,
not repair causality. Private run:
.context/auth-deploy/sms-capability-contract-review/controlled-local-factor/runs/20261015T233353Z-6a7d19e2/.
Independent outcome packet .context/auth-deploy/sms-capability-contract-review/step5-outcome-audit/,
manifest44a93f9a524be98127896389dd036959aaaf0532e7391b5338ae7a3386e9fd40.
No more calls/arms/rewording are authorized by that experiment.

### Abstraction and contract state remain OPEN

C1, exhaustion over a finite set of permitted applicable authentication operations
(method+identity/recipient), is coherent. Siblings include multiple saved passwords
and multiple permitted inbox recipients. Natural C+1, member failures versus closure
of authority-defined finite alternative actions, is also coherent beyond auth.
A nonprompt owner can aggregate identity-scoped actual outcomes when it already has
a complete authoritative eligible set. This is a coherent design, not a proven
loss/correction here; supplemental AuthRuntimeState booleans cannot establish that
set or user-only/current-account authority. Actual history retains the input/waits.

Probe permission, applicability, must-try obligation and exhaustion scope are
separate. Permitted unregistered probes need not be forbidden merely for unknown
membership; they also cannot be forced from hidden fixture membership. Explicit
account restrictions, account-lock/app approval, unavailable/disabled channels,
definitive rejection on the current path and legitimate refreshed retries remain
controls. No failed next-deeper coherence was proved: Step5b is INCOMPLETE, not
closed by declaring uncertainty incoherent. No prompt/controller is selected.

Source/official-document catalog review established a documented inference-key
models GET but did not call it; its model-ID schema does not establish stronger
deployment identity/capability. Exact owned deployment mapping/read authority and
a diagnostic selector remain unverified. No model intelligence classification or
catalog/model calls followed. Evidence/design only; no task/evaluator/runtime edits.
