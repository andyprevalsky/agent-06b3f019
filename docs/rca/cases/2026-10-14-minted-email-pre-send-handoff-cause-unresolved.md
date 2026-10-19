---
id: 2026-10-14-minted-email-pre-send-handoff-cause-unresolved
date: 2026-10-14
title: Browser handed off before requesting a code despite an exposed minted-email route
surface: agents
component: browser-auth-handoff
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Model selected authentication assistance on a blank code-request form without attempting the exposed minted-email route; causal explanation unresolved
symptoms:
  - request_user_assistance_for_authentication at browser step3 before input_text
  - No credential refs observed at authentication assistance
  - Tree stalled while authentication assistance awaited the user
  - Six exact original calls did not repeat immediate assistance
tags:
  - browser-auth
  - minted-email
  - early-handoff
sources:
  - agent 9a1fa767-11aa-443f-b5d2-331eaaa3da6d
  - fleet run 1f31c369-987e-40bd-af95-637fe158ef51
  - commit a6ae9954c6d93ef1008811775f5750181bf036f1
repro: six authorized original-context native decision calls; immediate assistance not reproduced; no owning fail-pass correction
status: open
---

## Problem

Frozen all-auth task browser-auth-minted-email-otp initially remained pending
following an assistance request at23:32:50. Native controller subsequently
recorded FAIL566.8s: newest-active root silent515s, threshold510s, then paused
for early-fail cleanup. Original verdict/clocks and campaign were preserved.

Native history: read welcome, click sign-in, read password form, click email-code
link, read blank code-request form, request assistance. No email input or send.
Last observation contains email input110, submit111 and enabled minted email
with automatic code receipt disclosed. Fixture-created minted email matches
exposed email, but that internal fact is not model-visible registration proof.
Backend records refs0/applied0; no failed credential was disabled.

## Diagnosis

First observed divergence is pre-send model handoff, not delivery, inbox polling,
OTP extraction/admission or late input. Those downstream boundaries were not
exercised and cannot be blamed or declared healthy from this trajectory.

Actual tool description says before assistance the model must have tried the
minted agent account when it has an email. System priority says assistance only
after routes1-7 exhausted or unavailable. No attempt/error/exhaustion is observed.
The problem_class bucket is provisional contract-review categorization, not a
proven logical inconsistency or root cause. That prerequisite divergence is proven;
its causal explanation is not. Original
output records no rationale. Goal asks for logged-in user's member number while
page is signed out and asks for email on membership. Globally enabled minted
inventory describes available delivery capability, not third-party registration/account match.
Do not infer a forced identity requirement from inventory alone.

Archive searches: minted email assistance before code send; enabled minted account
registration identity email inbox. SMS identity/capability case is a relative,
not adopted cause. Adversarial reviewer confirmed pre-send boundary and cautioned
against forced identity or claiming intelligence/missing capability from this miss.

## Solution

No correction justified or adopted. Parent authorized exactly6 decision-only calls
from captured step3: original full messages/tools/config/cache namespace and actual
gpt-6-sol-foundry/foundry preserved. Decisions: minted input110, back155, minted
input110, evaluate, back155, minted input110. Immediate assistance0/6. No returned
tool executed; no provider inbox polled. These alternate decisions do not prove
successful login, statistical/model separation or a repaired cause.

Caller temperature0.3, seedNone, max_tokens2048, effective effortxhigh. Input hash
7ead4ffa68a0393b624798b5fc58098a4e5b41db5d9dc7fe839fc20539d1b576;
source dump hash190628c7206c35c8217c03da7dfe7d5de13a7d6ec369e62c9e67c23224fce79a.
All6responses/request IDs/timings/usage retained privately;54696prompt/1723output
tokens. First replay cache read0/write9113, later read9113/write3; namespace was
identical but residency naturally differed. No billing amount invented.

Next proof requires separately scoped decision: justify a general identity or
capability contract correction before an owning registered original-fail/candidate-
pass test, repeated native calls and unchanged canonical outcome. Do not add
fixture keywords, force recipient IDs, weaken human fallback, promote telemetry
to account existence, or rewrite an already-present must-try instruction without
causal evidence. No paid retry until campaign completion/cleanup and later scope.
No reference-driven fix design was selected; no repair or approval-ready claim.

Workspace evidence receipts: /home/boxes/rose/.context/auth-deploy/minted-email-pending-rca/
findings.md, evidence.json, native-replay-summary.json and native-trial-1 through6.
Replay command (already executed exactly once; no authorization to repeat):
`agents/venv/bin/python .context/auth-deploy/minted-email-pending-rca/replay_native.py`.
Read-only regeneration: same Python with summarize_replay.py. Trial request IDs and
elapsed seconds:887948b4075d/6.631,39f9b6543d31/6.123,960ffbd95fb8/4.590,
53385cfa6529/6.306,7614b5bfd823/4.446,cda36e4776d7/4.545. Full response
payloads remain private; no codes or personal identifiers are embedded here.

## Human feedback

User/parent required read-only initial trace and preservation of pending versus
terminal status. Later parent authorized at most6 original-context decision calls,
no tools/live interventions, then agreed no speculative repair or intelligence
claim. Archive only OPEN in isolated checkout, no adoption. Freedom preserved.

## Reusable lesson

Separate an observed prerequisite divergence from its unproven cause and from downstream delivery paths that the agent never exercised.

## Follow-up transport audit: replay parity qualification (2026-10-15)

The six original paid decision calls, full private responses, request IDs, timings
and usage remain unchanged. A later read-only source/serialization audit narrows
“original-context” above: they replayed captured visible context and raw model/route,
not a demonstrated byte-identical original HTTP request. This qualification does
not infer a cache cause, model limitation, repair, or reason for the native handoff.

Original complete_browser_use builds one system message containing an internal
static/dynamic boundary sentinel. Its post-response dump splits that sentinel into
two system messages. The executed replay driver passed the dump messages directly
to collect without restoring that segmentation. Foundry's Responses builder joins
them into identical instructions, but derives its static cache scope differently:
original static prefix versus replay joined static+dynamic system text. Namespace
preservation therefore did not preserve the generated provider prompt_cache_key.

Pure offline actual-builder comparison using a common logical model override proves
one difference in SOURCE-RECONSTRUCTED bodies: prompt_cache_key. Instructions, input,
tools and all remaining generated fields match. These are not captured historical
wire bytes; actual deployment/cooldown/endpoint state was not retained. Source dump
hash190628c7206c35c8217c03da7dfe7d5de13a7d6ec369e62c9e67c23224fce79a unchanged.

Caller temperature0.3, max_tokens2048 and seedNone above are caller settings only:
this Foundry Responses builder emits no temperature, output-token-limit or seed
fields. They cannot establish wire generation settings or explain variability.
Original inner collect and replay both used dump_contextFalse; old replay changed
skip_cache_writeFalse toTrue. Foundry does not consume that flag, though other
fallback transports can. Same logical model/route does not prove same deployment
or provider cache state. Mutable/prefetch message corruption was not established;
post-response snapshots cannot independently prove what was at the HTTP send.
No retained actual outgoing wire body was found in inspected local evidence.

A corrected OFFLINE preparation driver restores the original system segmentation
and default skip_cache_writeFalse, then compares against independent production
browser-message construction and the actual provider body builder. It makes no
HTTP/model/tool/inbox call. In a fixed common model/deployment placeholder context:

- Expected source-derived bodySHA256:d3ee94ba97001c46edb67fd21e720d487036c6f7ea2ba706678088c088deb3fc.
- Old dump-replay bodySHA256:a79ec64a7a520aedfd7d9cd8a82e984a03374511e35204a41e64f89b03472469.
- Corrected body equals expected, INCLUDING provider prompt_cache_key. This repairs
  offline replay preparation parity only, not the authentication task or its cause.

Artifacts: /home/boxes/rose/.context/auth-deploy/native-replay-transport-audit/
findings.md, serialization-comparison.json, corrected-replay-proof.json and
old-six-preservation.json. Safe offline command:
`agents/venv/bin/python .context/auth-deploy/native-replay-transport-audit/prepare_corrected_replay.py`.
The driver contains no network execution; an actual paid repeat remains unauthorized.
Read-only peer review confirmed the reconstructed-body claim and historical-wire
limits. The case remains OPEN/unresolved; no live, runtime or active review-head
change, cache-causality claim, repair adoption or new paid call follows.

## Corrected bounded native recurrence and identity audit (2026-10-15)

Parent later explicitly authorized at most6 corrected original-context decision-only
calls after the offline reconstruction above. These are a NEW, separate set; old
sixcalls0immediate-assistance and all12oldprivate-response/receipt files remain
unchanged. Stopat6 was honored. No returned tool, site/inbox/DB action, benchmark,
upgrade, runtime change or further repeat was authorized/performed by this phase.

Prepared kwargs restore original internal system segmentation/cache scope and
skip_cache_writeFalse, keep dump_contextFalse and the same captured pool/context/
tools/caller settings. Offline source-derived expected-body assertion passed before
first call. A body-preserving existing httpx send hook observed already-built POST
bytes without altering request, headers, URL or arguments. It records sanitized
hashes/field names, not private body/key/endpoint. Local parse/hash/rebuild/assertion
adds timing overhead before sending; this is not zero-effect instrumentation or
historical latency parity.

All6actualoutgoingPOSTcanonicalbodySHA256 values equal
`d3ee94ba97001c46edb67fd21e720d487036c6f7ea2ba706678088c088deb3fc`, including
provider prompt_cache_key; each is equal to source-derived expected body using
that call's actual selected deployment override. Raw modelgpt-6-sol-foundry and
routefoundry all6. This proves present-body correspondence, not the absent historical
original wire, headers, endpoint version, deployment/cooldown or provider cache state.
Caller temperature/max/seed remain absent from emitted Foundry generation fields.

Corrected decisions/request IDs/elapsed:

-1 back-to-sign-in155;4cdc030247b5;6.089s.
-2 minted-email input110;c7d8dcabccc9;6.436s.
-3 immediate authentication assistance;12156a6e8657;3.361s.
-4 minted-email input110;c5826c7e4b75;4.113s.
-5 minted-email input110;d222e8e5d7ee;5.072s.
-6 minted-email input110;e7cfa65700f4;4.218s.

Thus the captured unattempted-route prerequisite divergence recurs1/6 under the
corrected construction. This is bounded decision recurrence, not deterministic
cause, model intelligence, statistical separation from old0/6, cache causality,
authentication success or repair. Alternative actions were not executed and could
still fail later. Allusage/cachemetrics/timings retained:54696prompt/1745completion
tokens,29.289s sumelapsed including instrumentation; no billing amount invented.
Artifacts: native-replay-transport-audit/corrected-calls/summary.json,final-proof.json,
trial1through6 and private responses. Safe retained-file regeneration:
`agents/venv/bin/python .context/auth-deploy/native-replay-transport-audit/summarize_corrected_calls.py`.
Do not rerun the paid driver without new authorization.

### Correct baseline comparators and authority distinction

Checksum-verified original e576 campaign minted-email was PASS, root
ac8e7169-6b29-4c36-bdc2-020140e347a7. Step3 dump1792009006703-eea5a79cb949 chose
exposed minted email, then requested a code and completed authenticated. This
case's initial FAIL566.8 refers to a6ae root9a1fa767, NOT an e576 minted-email failure.
Original e576 emailFAIL3caf15c9 was PASSWORD-email-2fa, a distinct task now passing.

Original e576 magic-link was PASS rootda82a392-4b87-46ec-908a-2a5b07220b56; its
step2 dump1792010303655-dcdf25bf35e3 clicked the email-link alternative, followed
by minted email/link retrieval/completion. Current a6ae magic-link root846382aa
failed568.7 after pre-send assistance. SMS is an original/currentFAIL observed
recipient/account-lookup recurrence, recorded separately in its existing OPEN case.

At matched original/current email and magic decision points, first static system
text, Authentication section, assistance-tool definition and raw model label are
exactly equal. Other native context/URL/index/history/time/provider conditions
are not controlled. These are verdict comparators, not causal source-regression
proof. Passing native traces show existing attempt policy can support minted
sign-in without adding model-visible verified-registration assertions.

Allthree root user goals simply ask for the member number at supplied URL; no
explicit personal-phone-only account restriction. Child email goal's “logged-in”
wording was generated by the agent, not an extra user restriction. Task user,
AgentIdentity custody and fixture holderName/userId align. Fixture privately seeds
a verified member under minted email/phone for email/SMS/magic; exposed email
matches creation log in allthree. Private expectedSignInEmail/memberNumber manifest
is runner authority, not browser inventory. The ordinary goal substitution exposes
URL, not those answers. No fixture/data/evaluator contradiction was established.

Current actual tool already requires trying available OTP/minted email before help.
It does not require confirmed registration before a permissible attempt. Distinguish
attempt permission/policy from certified account match: AgentIdentity proves local
user custody; enabled MintedAccount does not certify site membership because API
can create that realm row on read. PhoneProvider is receipt provenance, not account
registration. Absence of a registration map alone neither excuses premature help
nor justifies inventing a registry, leaking fixture oracle or forcing identity.
If guaranteed membership is required by a future product invariant, authority must
come from explicit user designation or trustworthy site-bound verified auth/signup
observation, not enabled/realmrow/provider/name.

### Existing runtime telemetry cannot certify semantic exhaustion

Read-only AuthRuntimeState audit: successful typing of a credential ref can mark
attempted before submit; email/SMS OTP share a boolean; minted_attemptable is email
presence, not observed current form; no recipient-specific send/resend/timing or
user-only-step authority exists. Assistance payload carries owner/session/realm/
URL/mode but no semantic exhaustion proof. Its encrypted continuation snapshot is
telemetry, not an independent gate predicate.

A blanket minted-unattempted guard could block real app approval or other valid
help; typed-but-unsubmitted refs could pass incorrectly. Existing no-guard tests
record current behavior, not a perpetual prohibition on later evidence-backed,
approved narrow validation. A current-DOM+custody+existing-policy validator remains
coherent in principle and need not require confirmed membership. No reliable
general operation-applicability/user-only exception predicate or causal owning
fail/pass correction has been established here. Do not manufacture an applicability
flag or replace human fallback with forced recipient use.

Safe independent invariants are existing owner/realm/provenance and admission of
already eligible worker-owned native input before transfer. The existing bounded
drain covers the latter; current pre-send incident does not violate it. Handoff's
constant “options were exhausted” summary overstates pre-send evidence; a neutral
summary/evidence-integrity correction would not itself repair model selection or
prove canonical success and is not adopted here.

The deepest causal owned class and Step5b stopping rung remain unproven. A factual
correction needs an actual authoritative source fact lost/misrepresented at an
owning boundary and unchanged baseline-fail/candidate-pass controls. A policy
correction needs meaningful decision/outcome separation with legitimate user-only,
explicit-account, unknown-membership and challenge controls. A contains-string
assertion would already pass because must-try text exists. No new prompt/schema/
gate, blanket identity choice, causal classification or repaired outcome is licensed
by this diagnostic. Read-only peer review confirmed these limits. Identityaudit
artifacts live under /home/boxes/rose/.context/auth-deploy/identity-applicability-audit/;
findings.md,facts.json,passing-baseline-comparators.json,handoff-proof.json retain
exact sanitized evidence. Case remains OPEN/unresolved.
