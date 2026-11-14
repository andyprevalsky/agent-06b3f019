---
id: 2026-10-31-r145-verifier-started-near-activity-deadline
date: 2026-10-31
title: Multi-site browser task starts verification shortly before its activity deadline
surface: agents
component: browser-completion-deadline
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Verification starts1.74s before the activity deadline and no returned verdict is captured
symptoms:
  - Native FAILED with activity StartToClose timeout
  - Final verification request starts immediately before deadline
  - Fresh screenshot succeeds before the terminal failure
tags:
  - r145
  - it33
  - activity-timeout
  - completion-verifier
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - agent 0725e6b4-21d4-4e66-8fa1-dad456b4850a
  - plan: original packet08cb1409e6b4b3c6fc711a3b5d75dc6526b4d48160355b9bd1b916fc2b483a1c
repro: Original normal7,63 verified payloads and late verifier dispatch chronology; no causal repair or model replay
status: open
---

## Problem

It33 r002-j0015/task10548585c321 remains canonicalFAILED/nativeFAILED/progress1 after3010.2s. The user requested Mozilla Chromebook installation guidance, the Apple iCloud Passwords Web Store page, Google Docs image troubleshooting, UserTesting login, Patreon homepage, YouTube playback and a summary. Final verification began near the existing activity deadline and did not produce a captured result. This case does not claim the browsing requirements were otherwise satisfied.

## Diagnosis

Packet08cb1409 and all seven runtime-manifest file hashes/sizes were independently verified. Source is71548b68172df23752d1ec866d7a8395baa3366c with patchnone. The last actor response completes05:36:26.984025. Persisted actor text at05:36:27.414 says it has gathered everything except successful video playback; that is an actor claim, not independent confirmation. Message275 is an IN_PROGRESS “Verifying completion” row.

A fresh CDP screenshot succeeds05:36:28.275617. check_progress starts05:36:31.879903; raw pre-conversion verifier context is logged05:36:32.683606. The actual verifier_browser request starts05:36:33.562346. Browser manager fails with activity StartToClose timeout05:36:35.306336, about1.744s later. No returned verifier verdict is captured. Cancellation05:36:39.856320 and upstream release05:36:39.917405 follow.

The raw63-message context is present (UTF8SHA4f0472cfc64b0dd3bb26e9015040033671b9344272e6ecf35e89e03e4baa4fd8,2554321B). The full request dump is explicitly skipped because its payload is1865508B. Thus pre-conversion context is available, but exact provider-wire identity and a result are not established. No dropped-field or false-verifier-verdict defect follows from this evidence.

All63 retained compressed model payloads decode and match recorded hashes. The final schema102 (SHA5452a91b528a5ce3ae9e25f2aa20a572a7a7a5e22cf624b7c30886c9661ceb38) has firefox_chromebook, icloud_passwords_extension, google_docs_image_fixes, site_behavior_checks and final_summary fields, corresponding to the original request. No deterministic schema omission was found.

Mux target pending episodes are followed by same-session replies, including05:29:09–10; the late successful screenshot is additional contrary evidence to continuous connection loss. This does not rule out earlier latency problems. The first-run same-task report includes slow actions and a late successful screenshot; only the broad deadline boundary is shared, not a proved common cause. R143's prolonged unanswered-client-command evidence must not be imported here.

## Solution

OPEN: preserve the original failure, task requirements and deadline. The exact cause of late verification, video playback failure and prior action allocation remains unisolated. A request that starts near its deadline does not justify extending that deadline or promise that more time would satisfy the task. No timeout, prompt, rubric, criteria, model-route or runtime change is proposed.

Only existing sealed bytes were inspected. No model/provider/browser/DB query, new capture, tracked edit or task regrade was made. Release verification remains a separate parent-owned custody claim. The verifier result cannot be inferred from progress1 or the actor's self-report.

## Human feedback

None specific to this case.

## Reusable lesson

Record finalizer dispatch and returned verdict separately. A successful browser surface followed by an activity timeout identifies the terminal boundary without proving either task completion or the reason verification started late.
