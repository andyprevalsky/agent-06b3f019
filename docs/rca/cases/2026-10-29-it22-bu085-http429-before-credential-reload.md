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


## R91: It23 BU085 run2 guarded reload failure

Original job r002-j0015/root1ec59614-6505-442f-8606-21df06559afb ran
sourcefc00b583e7df7b94d05fdb3442bddd23cd21be8b with patchnone.
NativeFAILED714.2seconds and progress1 remain distinct from canonicalFAILED,
producerinfraFALSE. No completed year or declared semantic judge is recorded.
Progress1 is not a successful native completion. All seven original member
sizes and hashes independently verify against manifest
e7693b6a3373ade45289fc620effdfcbfc9e564a3658b8cc707d590e50e15432;
archive7294d5c26d666421f14634759f20972d9c2c9a1c3df1bd27b50fa0036020792c
and normal run0031f36c60bbbbddfbcbd44bbb18240efad9998c5fded1bf73586b3c28553fe3.

The exact actor browser_use_step_11 request/output at worker15313 has payload
SHA256792bee4900e7a5def951de23c5e213b8df0de6d229b81f66574d9ed0cf76ddfe.
It chooses switch_tab C28A while looking for the paper's dedication.
Persisted messages56/57 show that action starting00:41:22.008Z and succeeding
00:41:25.210Z. The selected destination is the same Harvard bitstream as R86.

This occurrence has a material ordering difference from R86. At00:41:25.058418Z,
worker15364 records successful harvard.edu realm preparation with one password,
passkey_count0, passkeys_newly_injected3 and cookies_injectedfalse. The preceding
virtual-authenticator readback reports expected3/observed3/missing0; later
passkey-used messages are retained. These counts describe different inventory
and injection fields; they must not be flattened into no credentials.
No secret values were inspected or added to this case.

The first captured HTTP429 for the destination is worker15393 at
00:41:28.165224Z, after realm preparation. Unlike R86, this packet does not
establish a destination429 before preparation. Native navigation then repeatedly
raises ERR_HTTP_RESPONSE_CODE_FAILURE. Eight supervisor recovery messages61–68
from00:41:29.205Z through00:41:48.411Z perform bring_to_front/press_escape on a
chrome-error page visibly showing HTTP ERROR429. Worker15493 exhausts the
existing recovery budget at00:41:50.405900Z. Native failure reaches the manager
and root; the final error summary says the native browser task did not complete.

Exact-source pending_credential_reload_realm is cleared only after successful
navigation/readiness acknowledgement. The exception guard runs here and
exhausts recovery; it did not silently escape the error. No safe alternative
transition was proven that would preserve the credential/realm obligation
while allowing unrelated research. A forced ACK, larger budget, task-specific
URL rule or credential bypass would not establish a general causal repair.

The source-origin or upstream policy causing429, its response body and a safe
retry interval remain unestablished. Other captured Google429 responses are
separate events, not proof of a platform-wide outage. The native record has
no completed answer or semantic rejection to repair by rewriting presentation.
This is a relative/recurrence of the guarded reload failure boundary, appended
with its different injection and response ordering rather than asserted as
an identical initial cause.

The final original cleanup separately records same-session Tilion DELETE204,
root soft-deletion and tree sealing, with cleanup_failure null. Earlier cleanup
failure metadata does not erase this later receipt and supplies no terminal
infrastructure reclassification. Searches used credential_reload_error HTTP429
and ERR_HTTP_RESPONSE_CODE_FAILURE mandatory reload; R86 and R52 Solution/Human
feedback were read. OPEN, no runtime patch, model/provider/native/DB call,
replay, cap/criteria change or task regrade. Tokens UNMETERED.

## R95 observed recurrence: original It24 BU085r2

It24 r002-j0015/root8396719f-8475-4443-9315-334f84c2dfce independently reaches
the same observed reload boundary on source8136eb6bb1d32d98553a70ca5f98278b590bee81,
patch none. All seven original normal members match manifest
255fddff8a56ab6c50fc9df0f8ca9dc2559813860aea08f4d09e17d10458304b;
archive7e928a275341fd78319913ef9daacbd83a068478cb6ed5753bb9460a88d75cd2
and run4da185881bbf4184f6e2db5eca2efb44dbea1d67a46525a94c399771912d40e9
were verified. NativeFAILED664.9s/progress1 precedes canonicalFAILED/infraFALSE;
no declared semantic judge result or answer is present.

The destination differs from R86: the actual click reaches Harvard publication
1cdc6cf7-09cc-4b5a-a34d-cd4cf6a4b420, not the earlier bitstream URL. Worker
13469 records successful click at01:56:53.965939Z. Worker13476 records actual
HTTP429 at01:56:54.360636Z, before the preparation/reload. The recorder reports
an183914-byte untruncated body path; the body itself is not in the normal seven
files, so its explanation is not invented from the status code.

Worker13518 applies zero cookies and zero local-storage entries. Worker13523
at01:56:56.096971Z records authoritative harvard.edu realm preparation with
password_count1, passkey_count0, passkeys_newly_injected0, cookie_source none,
and cookies_injected false. Saved credential inventory is still distinct from
injected browser state. The source's reload block is byte-identical to the
previously inspected implementation; no claim is made about every other source
path or provider state being identical.

Eight credential_reload_error:RuntimeError recoveries occur from
01:57:00.092630Z through01:57:43.383036Z, with bring_to_front/press_escape on
chrome-error and visible HTTP429. The unchanged recovery budget exhausts at
01:57:47.295448Z. Worker14318 records the original fatal stack at handler10375
reload_event.event_result, through browser-use navigation to
ERR_HTTP_RESPONSE_CODE_FAILURE. Thus the R35 guard runs and eventually
propagates a still-failed navigation; this is not its old unguarded escape.
Selected line hashes and workerSHA
7326cca93b4303f66dfafd45b81a09315efa8430e69810227a69d36c93e22aac are retained
in .context/r95/proof.json.

The recurrence establishes this shared observed sequence, not a common hidden
rate-limit cause or a safe authentication bypass. No new runtime candidate,
retry, timeout, task/grade change, model/native/DB call or duplicate repair lane
was introduced. A general safe transition out of the unacknowledged reload
remains unproven. The normal final cleanup records session
sess_993d70326c2349d8bd207b5d683fc8d3 DELETE204, root deleted and tree sealed.
No operational provider failure is inferred solely from the destination429.
The original R86 record and its limitations remain intact.
