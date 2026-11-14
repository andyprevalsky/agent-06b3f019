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


## R107 — It26 BU092r2: guarded navigation escape after policy refusal

The independently verified original seven-member sealed packet binds source
7e557a39083db505203e9e9bdf697e6c1a3f5a98, root
a824d4a8-ee2e-4506-b4b1-f6bb1d917377, task polar-bu-092 r002-j0012.
Manifest SHA256 91c5379d3723e40a686d92df61c4b7e831d8773eb092dfbf0bdba8268eac0e2d;
run SHA256 6a3f1d93518e7ed62d5995b1d37c983ea2053ec1a5ed390315291aed37c0f1c8;
worker SHA256 581df10193527d3cc1976b53f1ef47a6e92ac773722884687f8941e929736802.
Native FAILED188.7seconds/progress1 and producer infraFALSE remain unchanged;
no completion verifier or declared semantic judge ran. The required integer
event_year schema accurately preserves the original question. Captured article
text supplies an event year but does not independently prove every identifying
constraint or a completed task.

The actor's switch_tab966D acknowledged at05:30:55.238–.424. Credential
preparation then changed spomenikdatabase.org to skulpture-srbija.com. The first
native non-public-address denial is worker8890 at05:30:55.718831, inside the
mandatory reload; the tab-switch action itself succeeded. Eight generic
recoveries repeated the denial before the shared budget exhausted at
05:31:05.015143. Last-action metadata names switch_tab because it was the last
completed actor action, not because its native switch threw. Resolved address,
redirect chain and policy initiator remain unavailable. The native access guard
is authoritative and is not bypassed.

Exact scoped repair patch
e1bd7e9267900fad083a12652f529921dba83b0eab6b247418e4104234a2e301
was independently reviewed GROUNDED before application to isolated base
3a2d10aa7be90491f2042d8857dd319f2e761a60. The original reload block is identical
on the executed and qualified bases. The repair recognizes only the native
RuntimeError dictionary with code-32000 and the exact policy message, records
failed feedback, and retains a task-bound durable denial restriction. The
restriction allows only navigation to another destination through existing
URL guards, never current-page interaction, completion, cached batches or
secret-reference navigation. A different target alone does not clear it: fresh
credential preparation plus matching native reload/readiness acknowledgement
is required. Session/target/instruction changes reject stale admission. Optional
caller-owned admission is rechecked immediately before native goto, new-tab and
tab-switch dispatch, after awaited preparation. Previous denials remain recorded
until the new document is acknowledged; no private URL is stored in that ledger.

The same actual full-activity fixture fails before the patch with the original
native RuntimeError (2.89s) and passes after it (2.92s), rejecting prohibited
actions before a different page is prepared and acknowledged. Final canonical
run_all_tests selection passed10 registered controls in15.31s:12 new full-activity
scenarios,3 native-dispatch admission checks, and owning existing reload,
initial/redirected credentials, navigation/cancellation and R106 finalizer
controls. Checkpoint/resume, replacement, failed preparation, repeated denial,
stale target/revision ACK, transient recovery, cancellation, budget exhaustion
and takeover are covered with inert native/model/backend dependencies. This is
causal mechanism evidence, not a replayed benchmark PASS or a provider-policy
verification. Original outcome and unexplained native policy classification
remain OPEN. No live model/provider/browser/DB operation or source deployment
was performed in this repair lane.

Opened primary analogs: Hermes tools/browser_tool.py641–667,742–791 returns
failed policy feedback without successful retargeting; OpenClaw browser
navigation-guard.ts100–153 and browser-tool-binding.ts69–105 preserve policy
and run-bound target checks; Codex core/src/tools/events.rs438–474 returns
rejected tools to the model. Installed cdp_use/client.py312–325 preserves the
structured native error. None supplies Rose's credential-debt protocol: the
additional restriction preserves that stronger local obligation. Their optional
private-network/local-routing policies were not imported.

The coordinator required a complete guarded continuation path, not clearing
pending credentials, retry inflation, hostname exceptions or a speculative
provider classification. Earlier R52 findings are preserved above.
