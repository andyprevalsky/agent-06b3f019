---
id: 2026-10-28-it13-bu065-plaintext-page-cdp-stall-and-navigation-failure
date: 2026-10-28
title: It13 BU065 dictionary page stalls before terminal navigation failure
surface: agents
component: browser-cdp-renderer-and-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: mandatory credential reload event_result error escapes the activity outside guarded recovery; initial renderer stall and benchmark outcome remain open
symptoms:
  - renderer_main_thread_blocked
  - Browser evaluate timed out waiting for Runtime.evaluate
  - Page.navigate() timed out after 300.0s (60001ms)
  - Agent status FAILED expected COMPLETED
tags:
  - polar
  - it13
  - r35
  - cdp
  - renderer
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 1af3070d-3f15-4061-9768-bf7a632b221b
  - fleet run 20261028-230247-3988155
  - plan: archive 3f6284577ff96715bf83af3a24d314ed453f34d20dfb7a6668d4f9c7ecd3efa7
  - plan: normal manifest 4ae6f3ee3ebdb0214928a911cf8d59f5b2282d73e600a7e33844796c463dee74
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

BU065 asks for the longest alphabetically earliest Boggle word on the supplied
four-by-four board, using dwyl/english-words words_alpha. Original root and task
are FAILED after409.2seconds, infraFALSE. No answer was produced. The intake
clock is2026-10-28T23:20:19.303761Z; original source765caac/no patch is retained.
All seven normal manifest members and separately labelled supplemental files
match their SHA256SUMS. No live dictionary/browser/provider request was made.

## Diagnosis

The original actor navigates to the raw words_alpha.txt URL. Its first evaluate
script reads document.body.innerText, splits words and runs board DFS; the second
uses pre.textContent/body.textContent plus letter-count pruning. Original model
request dumps retain these scripts. Runtime fingerprints are1182characters /
b472e25cbd3a and1542characters /977c83a8f685 respectively.

The logs establish these boundaries, not the underlying renderer cause:

- First evaluate starts23:09:00.952506Z. At23:09:17.066157Z the original CDPMux
  reports the page session silent34seconds with oldest Accessibility.getFullAXTree
  outstanding; the implied last response is around23:08:43, before this evaluate.
  Silence age is not a browser CPU profile or an exact AX request-start receipt.
  Therefore the compute script is not proved to have caused the initial stall.
- The evaluate awaits time out at23:09:18.954055Z and23:11:05.213365Z, each after
  approximately15001ms plus3001ms session acquisition. Source765caac
  service_actions.py uses an actual inner asyncio deadline and raises its typed
  expiry to the supervisor. This is not the old unbounded-evaluate-await defect.
- Classifications at23:09:21.483495Z and23:11:07.743646Z report renderer=frozen,
  browser=ok, verdict=renderer_main_thread_blocked. These are separate page and
  browser-process probes, not a positive provider infrastructure-failure receipt.
- Both hard recoveries report new_context_page, goto_resume_url and
  close_playwright_page, recycled=true. Source handler recovery resumes the
  current dictionary URL and rebinds the browser runtime. A state snapshot at
 23:10:19.572820Z has four DOM elements and dictionary text. It does not establish
  that every pending CDP callback or later navigation is healthy.
- The actor later requests raw README.md. Page-readiness warnings refer to that
  URL. The terminal NavigateToUrlEvent instead reports the dictionary URL,
  Page.navigate timeout300.0s with measured60001ms, and a page session with16
  pending methods while other sessions still answer. This may involve queued
  resume navigation; exact event-target ownership and causal ordering are not
  independently complete in the retained packet.
- Navigation error is recorded23:14:42.096756Z. Browser failure is posted
 23:15:01.200Z; zero credential updates are applied, and the error reaches the
  root as RuntimeError at23:15:02.244Z. Original task failure is preserved.

The pinned source's requirements allow browser-use>=0.13.10,<0.14. The local
installed browser-use navigation code passes the event timeout into wait_for
and labels any caught TimeoutError with that configured timeout. This explains
why configured300 and measured60 can coexist as a reporting mechanism, but
local dependency source is not a substitute for an original guest source
snapshot. Neither that label nor changing it proves a task repair.

Archive searches were `renderer_main_thread_blocked evaluate` and
`large plaintext innerText timeout`. The Aug22 unbounded-evaluate case's full
Solution/Human feedback were read: its required inner deadline already executes
here. The Oct17 timeout-ownership case's Solution/Human feedback were also read:
configured versus observed durations must remain distinct. The Aug21 recovery
case is a related mechanism; successful task continuation is not established
here. No prior case is adopted as this run's completed diagnosis.

## Solution

No runtime candidate or synthetic repair test. The next useful proof is a
retained browser-process/renderer trace or original CDP request/event identity
chain establishing which operation stopped forward progress and which
navigation owned the terminal exception. The existing logs prove failure and
recovery attempts, not a deterministic safe change to workload admission,
renderer replacement or navigation ordering. Do not increase timeouts, add
blind retries, force an answer, skip evidence, or classify this as provider infra
from page-level silence alone.

The compact original-proof.json records the hashed runtime chronology. It is
not a failing-bug/repair RED-GREEN pair or an unchanged benchmark outcome proof.
No task/schema/prompt/cap/grade/provider/source/environment changed. No model,
API, browser, DB, image or new capture operation occurred. Investigator tokens
UNMETERED. This bounded case remains OPEN.

## Owned mandatory-reload follow-up

The initial intake above is preserved as its time-of-investigation floor. Parent
inspection of the original Browser automation failed event at23:14:48.119722Z
isolated the terminal owner: the full original traceback reaches
handler.py10310, `await reload_event.event_result(raise_if_any=True, ...)`.
This is mandatory post-credential preparation reload, outside the guarded
observation/action exception paths. A successful preparation event at
23:13:42.093926Z names the active realm, one password and no injected cookies.
It does not establish why the renderer originally stalled.

The repaired local mechanism routes only mandatory reload errors through the
existing finite supervisor recovery budget. Pending reload stays set until
both event and page-readiness acknowledgement; no model step occurs while it
is pending. Exhaustion rethrows the original error, and cancellation/sealed
generation propagate. Credential preparation and realm validation remain
outside the reload catch. After successful same-realm re-preparation caused by
a binding change, matching pending reload is retained. A failed preparation
invalidates the former binding's pending obligation and retains the existing
unknown/quarantined inventory behavior; that invalidation is not an ACK or
permission to force failed credentials.

A boolean pending marker uses the existing durable resume carrier so a
recovery followed by a drain cannot forget the reload. It restores against the
currently active realm, which is checked again by normal observation. No raw
realm or credential value is added to that carrier. The scope is the initialized
runtime loop; this is not a general repair of unrelated early-setup continuity
or the original browser freeze.

The unchanged owning test executes the real source block with I/O seams
replaced. Baseline fails at the original-shaped RuntimeError; the final patch
passes the same control. The first proposed version missed pending+binding
change, and parent/reviewer found an actual model-with-pending counterexample.
That version was never applied. Finalv2 also covers this counterexample,
preparation None/quarantine/failure, stale realm, cancellation, sealed generation,
shared-budget exhaustion, acknowledgement ordering and actual resume serializer
roundtrip. Real preparation-helper behavior is exercised; no model outcome is
inferred from the test.

Exact reviewed two-file patch SHA256:
4d7544c07e4d97e14c37546197f870bb904af9c66a014c49ac8c7942ae3adc5a.
Parent supplied the fresh independent GROUNDED review-v2 b91aaefa, including
opened primary references and independent original/v1 RED plus v2 controls.
The applied handler SHA256 is
c2d67c5acfbcc1882598568da2bffdf450bbf9de98b117f418949fd941062a68;
registered test file SHA256 is
9a251851ad4b418c047c5db84d9f62d80d6f1b7b958d7faa4b7fdef17dc7e596.
Both were compared after exact isolated application before commit.

Pre-apply actual `run_all_tests` selected20 relevant registered controls passed
(13 in4.347s, seven in2.363s), with zero network attempts in the final guarded
runs. The first harness run passed its13 assertions but failed its outer guard
on ten blocked optional JEV collector socket attempts; no requests transmitted.
The final harness mocks only that unrelated prediction collector. The initial
failed harness log is retained, not relabelled green. Post-apply the actual
registered new regression ran once on the checkout and passed. Archive
validation and diff checks passed. No full live benchmark rerun, task PASS,
provider fix, renderer fix or production deployment is claimed. Original
409.2second taskFAILED/infraFALSE remains unchanged and this case remains OPEN
for its benchmark outcome.

References personally opened: existing finite supervisor recovery and guarded
observation in this same handler; `prepare_optional_realm_credentials` and
binding invalidation; OpenClaw
extensions/browser/src/browser/pw-session-navigation.ts436-475 preserves
navigation error/policy ownership (contrary to blindly swallowing denial);
OpenClaw structured-output-tool.ts33-42 illustrates acknowledgement-before-state
advancement only. These support ownership/order, not a claim of task success.

## Human feedback

The parent required original code/script/dependency and await-owner tracing,
kept live765caac frozen, prohibited timeout/retry/answer changes and warned that
the initial raw-page chain was not proof of a provider failure or prior-case
recurrence. The bounded result preserves those distinctions.

## Reusable lesson

Separate page-target CDP silence, browser-process responsiveness, script execution and queued navigation identity before assigning a renderer timeout to a single workload or provider.
