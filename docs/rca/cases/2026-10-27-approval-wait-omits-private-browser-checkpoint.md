---
id: 2026-10-27-approval-wait-omits-private-browser-checkpoint
date: 2026-10-27
title: Approval parking saved the conversation but omitted the private browser checkpoint
surface: agents
component: browser-approval-parking
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py approval returns omit shared pause; real roundtrip also exposes fresh-CDP origin capture and sessionStorage Page.enable omissions in the existing checkpoint owner
symptoms:
  - "DoorDash checkout redirects to identity.doordash.com/auth after user approval"
  - "approval park returned without browser checkpoint"
  - "profile_source changes from challenge_candidate_ephemeral to user_persistent at approval resume"
tags:
  - browser
  - approval-resume
  - state-continuity
sources:
  - agent 3392bb69-807b-4ef9-a671-2e5eeb92efa7
  - commit 31d769b908da654b419f68e2a3cefd914703ef0e
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The agent was signed in on DoorDash, with account, delivery address, saved Visa
and a $33.56 checkout visible before the Place Order approval at 02:03:06 UTC.
The user approved at 02:25:20 UTC. Session init at 02:25:47 used a new Kernel
session and user_persistent profile; before parking it used Kernel's ephemeral
challenge_candidate_ephemeral profile. The initial Steel → Kernel change was
challenge recovery at 01:38:03, before approval; the mobile_city proxy remained
selected across approval resume. The later browser could not access order
history and handed login to the user. No order/charge/receipt was confirmed.

## Diagnosis

Critical path: approved write detection → activity return/conversation snapshot
→ human wait → remote session recreation → logical browser restore → checkout.
The first-bad producer boundary saves the conversation and disconnects CDP but
never checkpoints or pauses the remote browser. Challenge recovery deliberately
has no persistent provider profile. Recreation therefore has no private state
to restore and can select the shared persistent profile, then restore the empty
baseline. The configured Kernel idle lifetime is 900 seconds; the actual wait
was 22m14s. Read-only Kernel history confirms the ephemeral source was deleted
at 02:17:59.121166 UTC, before approval at 02:25:20.487 UTC; replacement creation
at 02:25:24.224928 used the user_persistent profile. Thus the source was
actually gone before resume. The provider history records deletion; the exact
automatic-expiry reason was not retained as a separate error response.

The immutable private checkpoint in production is revision 1, created at
02:37:04.526 UTC, after the failed resume. Read-only decryption shows a login
page tab, 119 cookies, zero origins. No earlier revision exists. The owning
backend contract verifies that absent capture restores empty state, whereas the
existing close(pause=true) path captures an encrypted checkpoint before release
and restores authenticated storage/cart state. Capture failure retains the
source provider session. No credential values are included here.

The source-executed local reproduction initially recorded events
[disconnect, conversation, return] and failed `approval park returned without
browser checkpoint`. The permanent full activity regression was then run on an
isolated original source copy: two failures in 3.57 seconds. The unchanged
candidate tests passed two in 3.83 seconds. The backend capture/restore contract
passed five consecutive runs. Complete commands and final integration proof
are being collected before closure.

Archive searches: `browser session restart authenticated provider approval`,
`write approval pause checkpoint ephemeral session idle`. Related cases include
2026-07-13-stale-cached-provider-session-id-spawns-second-browser and
2026-10-23-logical-first-browser-took-resume-path. Neither records this omitted
approval producer checkpoint; this is a new related defect.

## Solution

Implemented locally, not deployed: write/payment approval now invokes the same
`_close_browser_with_cleanup_receipt(..., pause=True)` used by ordinary pause,
cancellation and completion. The separate `_pause_browser_for_approval` wrapper
was removed. The shared owner captures required passkey evidence, stops replay,
then calls the existing backend checkpoint/pause before local detach. Remote
CDP attachments set keep_alive so only the backend releases the provider.
Auth assistance keeps its live browser. Ordinary cleanup still records its
existing failure receipt; approval refuses successful parking when that receipt
reports failure. Strict seeded-passkey readback and reference-save verification
prevents swallowed failure from releasing the source.

The user required end-to-end proof rather than separate mocked activity and
backend tests. The permanent backend browser-session suite now runs real Python
browser activities through authenticated close/resume HTTP routes, actual local
Prisma/Postgres, encrypted artifact storage and real Chromium/CDP. The first
activity uses the real write-lock action detector. It parks, destroys the source,
resumes the same logical browser into a fresh native browser, compares cookie,
localStorage, IndexedDB, sessionStorage, URL and cart, verifies a live reconnect
reuses the native browser, then executes a second activity and exactly one
synthetic merchant order. Failure and auth-assistance cases retain the source
and execute no order. Only model, merchant/native paid-provider adapters and
workflow/message orchestration are synthetic; this does not prove a real
merchant purchase or paid Kernel service roundtrip.

The real test found two additional defects inside the existing checkpoint path:
Playwright storageState on a fresh CDP connection had no known origins and saved
cookies but omitted live localStorage/IndexedDB. Reusing the existing
createOriginPayloadWriter registers missing live tab/frame origins via a synthetic
exact-origin document without issuing a merchant request, then storageState
captures those stores. The checkpoint had correctly saved sessionStorage but
the auxiliary CDP session had not enabled Page before registering its navigation
script. A real Chromium probe returned null before Page.enable and the saved
value afterward. The existing restore path now enables Page before the script.
The existing checkpoint artifact gains an optional origin on iframe sessionStorage entries; old top-level entries remain readable. The same checkpoint/resume owner and provider selection remain in use.

Exact unchanged permanent E2E with only the original two approval pause calls
omitted failed in 6.747s; current shared pause passed in 14.737s. A separate
identical final E2E command with only the old backend checkpoint failed in
10.46s; fixed checkpoint passed all three modes in 23.65s. Test/fixture hashes
remained identical for each comparison. The backend normal runner and
--pause-checkpoint-only both register these cases, so deploy coverage runs them.
The exercised agent-domain sources passed both canonical domains in 142.4s;
subsequent new E2E-driver edits are not imported by those domains. TypeScript,
Ruff, ESLint and Prettier checks passed. Runtime/code/test receipts are in the
RCA handoff artifacts; cloud-native provider and full Temporal approval workflow
execution are explicit unverified limits.

The acceptance review then reproduced omitted storage in a cross-origin iframe.
The permanent E2E now seeds a same-site, different-port iframe with distinct
localStorage, IndexedDB and sessionStorage, and compares its nonempty state after
recreation, live reconnect, capture failure and auth assistance. Capture now
registers live frame origins and records origin-scoped sessionStorage; restore
enables Page and retains the script through frame load. On identical final test
and fixture bytes, the top-level-only implementation failed in 11.91s and the
corrected implementation passed all three modes in 25.65s. The final source was
restored and hashes verified after the controlled comparison.

The same review found unbounded test-process cleanup. Test-owned children are
now registered immediately after spawn, retired with bounded exact-process
SIGTERM/SIGKILL and verified exit, and covered by failed-connect, ignored-signal
and missing-exit-receipt controls. Shared cleanup completion and startup-failure
cleanup cover the isolated database, directories and HTTP servers. Five repeated
cleanup control runs passed; the integrated E2E requires a successful shutdown
receipt. These are test harness changes, not a new production lifecycle.

Coverage is local browser-state integration with a static supported cross-origin
frame. It does not prove arbitrary partitioned third-party storage, live JS heap,
WebSocket continuity, a paid native provider, a full Temporal human wait, or a
real merchant purchase. No 10k-agent load run was performed.

The first independent review caught release-before-checkpoint on Browser Use
Cloud; the follow-up caught swallowed passkey failures. Both were repaired and
permanent tests cover the actual installed SDK and actual readback/persistence
boundaries. The user's later acceptance required reusing the shared lifecycle
and real E2E proof; this revision implements that direction. The user later withdrew the B2 identity guard and requested resolving the original
blocked tool after permission is granted, then letting the ordinary actor retry.
That separate continuation change is recorded in the related B2 case. Production
deployment is pending.

References inspected: installed browser_use/browser/session.py:755 saves state
before BrowserStopEvent, and :1289 honors keep_alive before provider release;
OpenClaw chrome.ts:716,734,1558 retains profiles/cookies through shutdown;
Hermes browser_tool_session.py:683 keeps the profile outside temporary storage.
The SDK methods are executed directly by the regression; reference harnesses
supply the durability/ownership analog rather than an identical remote flow.

At 10k agents there is one existing scoped checkpoint/pause per suspended
browser, with artifact verification and one row CAS. No shared fan-in, recurring
poll, global lock, new channel or extra browser is introduced. Payload scales
with that browser's state. Failed capture retains the source under its existing
provider TTL; successful parked waits release browser compute.


## Full Rose-agent verification, October 27 follow-up

The user required the test to run through a Rose agent rather than a scripted
ActivityEnvironment actor. A real root/browser Rose agent
`c4d90385-9b3f-497e-bb71-cf1350218c1f` completed the synthetic Canvas Shop task
in 225.8 seconds through the normal local backend, real model calls, Temporal
Cloud, actual Kernel browser and attention-request APIs. No model decisions or
browser executor results were mocked. The merchant and approving test user are
synthetic; no real payment or shipment occurs.

Before approval, the merchant ledger contained zero order attempts and the
logical browser had checkpoint revision1 and PAUSED status. After approval, the
same logical task used a different Kernel native ID. The original click's tool
result appeared once with its original call ID, permission granted and
`action_executed=false`. The actual model chose read_browser_state, then a fresh
click. The merchant validated the restored cookie, localStorage, IndexedDB and
sessionStorage and recorded exactly one accepted order, no duplicate/invalid
attempt and no duplicate approval. The root completed and reported the visible
order number. This closes the prior single-path paid-provider/full-Temporal
positive-coverage gap; intentional retry failure and iframe scenarios remain
separately covered by the component/integration tests, not this full-agent run.

The unchanged catalog `browser-auth-password-app-approval` also passed through
a real Rose agent in145.8s. The main typed-approval test is explicitly an ad hoc
functional test; no catalog task definitions or grading thresholds were changed.
Its recording and66messages were published and verified in a fresh browser.
All owned test agents, native sessions, local stack/database, merchant and tunnel
were retired. Private receipt: `.context/rca-3392/real-rose-agent-final-validation.json`.


## Final combined-source Rose verification

After integrating shared Steel/Kernel custody, partitioned frame persistence,
and same-agent denial continuation, ordinary Rose agent
`a280adfb-ddb9-427a-9d76-41e35e039f3e` repeated the positive approval flow on
the final runtime in **174.5 seconds**. It used actual root/browser models,
Temporal Cloud, Kernel, and the normal attention-request API. The merchant
recorded zero attempts before approval and exactly one valid synthetic order
afterward, with no duplicate or invalid attempt. Cookie, localStorage,
IndexedDB and sessionStorage proofs all passed across native recreation under
the same logical browser. The original click result retained its call ID and
`action_executed=false`; the next actual model action was `read_browser_state`.
No real payment or shipment occurred. This run does not add a full-model
negative-denial, intentional failed-retry, or cross-site-frame claim; owning
integration tests cover those separately.

[Final Rose recording and 84 messages](https://www.roselabs.ai/?agent-id=a280adfb-ddb9-427a-9d76-41e35e039f3e#benchmark-share=98dab579-4c4f-45b5-bc54-0bf53f495064.1795725487.6259e800cece29507247ee9e63a18b44fe7b7a50d8396de78553c521d658c403) were published
and verified in a fresh browser. The exact terminal agent, merchant and
merchant tunnel were retired; the deployment semantic stack remains owned
until its mandatory gate finishes. Runtime source binding and strict ledger:
`.context/rca-3392/final-rose-positive-validation.json`.


### Post-sync namespace qualification

The same real Rose acceptance was repeated after integrating upstream worker
and namespace isolation, using `rose-labs-bench.tch2n`. Agent
`505428f6-4e43-41b0-a0dc-8f8473c5e6b9` completed in **245.1 seconds**.
It again produced one valid order and one approval, retained all four storage
proofs across same-logical-browser/native recreation, and chose
`read_browser_state` after the original permission result. The recording and
65 messages were [published and verified in a fresh browser](https://www.roselabs.ai/?agent-id=505428f6-4e43-41b0-a0dc-8f8473c5e6b9#benchmark-share=8533a9bd-e91d-432f-806f-5245eed89b08.1795727033.72ab38ef627b24aa71ab1653f00d1dea6a63d042070f23aa91478a6a91d5a833).
The raw observer's same-host historical rows are preserved; the audit selects
the exact current agent owner and verifies one parked/restored logical browser.
No model result or browser action was mocked. Private current-source binding:
`.context/rca-3392/postsync-rose-positive-validation.json`.

## Human feedback

The user explicitly required: "The test needs to be done through a rose agent".
The full-agent follow-up above satisfies that requirement for the successful
approval/resume flow; earlier scripted-model integration tests alone do not.

The user rejected treating approval as a separate browser lifecycle pipeline:
we should reuse the existing pause/resume logic, preserve the browser's state,
and prove it end to end with tests or benchmarks. The revised implementation
removes the approval-only parking wrapper and invokes the same shared close
helper used by normal pause/cancellation/completion. A permanent real local
activity/API/Postgres/encrypted-store/Chromium roundtrip now passes;
separate mocked activity and backend contracts alone do not satisfy this
acceptance criterion. Native cloud-provider transport remains a separate limit.

The user asked whether all authentication options were tried, whether the
browser had previously been signed in, and whether the approval resolution
rotated providers. The factual audit distinguishes provider, profile and
session identity. The retry executed only read_browser_state, goto /orders,
and read_network_requests before requesting help. Password/passkey/email OTP
were unavailable in inventory; social and SMS flows were not exercised. No
claim is made that those untested flows could have succeeded. No original
purchase or live authentication action was performed during the RCA.

## Reusable lesson

Persist private browser state through its existing checkpoint owner before suspending for an unbounded approval wait.


### Review stabilization: terminal cleanup and exact native reconciliation

Code review exposed an ordinary-terminal leak in the first strict passkey
implementation. The shared close helper now requires complete passkey evidence
only for write/payment approval. On ordinary completion, max-steps, cancellation
or error, incomplete usage readback is explicitly logged and the same existing
backend checkpoint/pause still executes. Approval capture failure continues to
retain its source; successful auth assistance remains live. The unchanged four
owning tests failed one/passed three before (25.48s), then passed four (22.23s).
The new full-activity matrix covers84 fault/provider/path cases, including24
strict approval-retention cases. No new close API or pipeline was introduced.

Two backend review regressions are registered in the normal browser-session
provider-lifecycle fixture. An opaque sandbox has effective `globalThis.origin`
null even when `location.origin` is HTTPS; only the effective opaque-origin
case is skipped. A readable frame's storage failure still retains the source.
The real-CDP encrypted-checkpoint case failed1.302s before and passed1.541s
with the guard. Exact released Steel candidates now settle their existing
resume receipt under request/native identity, creating-phase ownership and
unchanged-source fences. The actual shared-owner/Steel/isolated-DB regression
failed4.675s before and passed1.207s afterward; it covers expired known-terminal
recovery plus hydrating, unknown, foreign-owner and changed-source no-create
controls. Missing state is never silently replaced with an empty baseline,
and receipt age/null binding alone never authorizes a second native create.

At source29e2c47e3, full backend coverage passed233 domains and325 unit files;
normal TypeScript and all-TS/importer lint passed. The follow-up34c71e5f5 changes
only test registration: explicit child-fixture URL dependencies let the existing
structural ratchet see imported cases. Runtime hashes are unchanged. These
checks supplement prior actual Rose-agent evidence; current post-stabilization
real-model acceptance and production deployment remain pending.
