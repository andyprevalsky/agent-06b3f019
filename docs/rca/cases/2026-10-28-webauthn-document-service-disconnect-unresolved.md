---
id: 2026-10-28-webauthn-document-service-disconnect-unresolved
date: 2026-10-28
title: Popup native WebAuthn callback fails while its virtual authenticator remains available
surface: agents
component: browser-tilion-native-webauthn
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: Chromium Blink ScopedPromiseResolver reports an abandoned native Authenticator callback in the first popup document; the initiating native lifecycle event remains unproven
symptoms:
  - "AssertionError: armed popup outcome='NotSupportedError'"
  - "NotSupportedError: Error connecting to Web Authentication service."
  - same document keeps failing while reload succeeds with the same virtual authenticator ID
tags:
  - webauthn
  - chromium
  - popup
  - document-lifecycle
  - native-callback
sources:
  - PR #1627
  - commit 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
  - agent ph76vgnm45dgks2dts4rxqy1sd8h45j4
repro: agents/tests/blackbox/browser_tilion.blackbox.py multiplexer_arms_webauthn_popups
status: fixed
---

## Problem

The deploy agents-coverage browser-tilion domain failed its armed popup assertion
in `.context/test-runs/agents-coverage-20261028-174450-1614674/browser-tilion.log:170`.
The historical assertion did not print the outcome, so its exact value cannot be
recovered. The replacement investigator captured the actual local wrong outcome:
`NotSupportedError: Error connecting to Web Authentication service.`

All evidence below is under `/var/tmp/deploy-1627/rca/tilion-webauthn/` on the
integration devbox, not committed source. The prior author's 20-second settling
wait was removed; it violated the explicit no-timeout-bump instruction and its
scratch repro returned a fabricated success before forwarding the real command.
The original polling behavior and assertions remain. The only retained source
change records native exception/start state and includes actual assertion values.

## Diagnosis

Critical path: local HTTP popup fixture -> real `window.open` -> Chromium target
creation -> multiplexer WebAuthn.enable/addVirtualAuthenticator -> target resume
and popup document commit -> native navigator.credentials.get -> Blink promise
settlement -> fixture's original 40 samples -> exact existing blackbox assertion.

Step 5: What: a live, focused popup settles to NotSupportedError instead of the
expected NotAllowedError. Where: the earliest observed wrong result is Blink's
native Authenticator callback, not a missing CDP virtual-authenticator reply.
Why: the native promise resolver is left unreleased and the document's subsequent
request continues failing; the initiating event remains unobserved. Proof: native
captures plus the same-target/same-authenticator reload comparison below.
Problem: native Authenticator response completion failure with an unresolved
initiating event and trace-capture gap. Do not equate the known error mapping with proof of its trigger.

Runtime Browser.getVersion in `native-capture/11-cdp.jsonl` reports
Chrome/153.0.8010.12, revision @971a7443b0c9b0a9b2860529b33331b76077ec62.
Launch uses the pinned Playwright executable with --headless=new --no-sandbox
--no-first-run, a private user-data-dir and a local remote-debugging port.
Capture runs additionally enable stderr logging. No provider, billing or live
third-party account is involved.

Each command below ran from
`/home/boxes/rose/.claude/worktrees/agent-a0f677519b4ea0db3` after
`. /var/tmp/deploy-env.sh`; backend/blackbox callers used CONDUCTOR_PORT=21500,
TMPDIR=/var/tmp and the assigned localhost:56005/victoria_rca_tilion-webauthn-popup
database. source-snapshots and evidence-index.json retain exact source hashes.
The parent advanced integration HEAD to 00e1c0fc while this RCA ran; the
multiplexer source hash remained unchanged and the diagnostic-only test diff
remained uncommitted.

Executed controls (each cohort is separate; early-stopped cohorts are not rate
estimates):

- `python /var/tmp/deploy-1627/rca/tilion-webauthn/repro_instrumented.py 10 --armed-only`: 9 expected results and one
  NotSupportedError (round 6, `current-instrumented.log:49`), zero emulation
  failures. This independently implements the original sampling loop.
- `python /var/tmp/deploy-1627/rca/tilion-webauthn/repro_native_error.py`: round 1 fails after one pass; native error
  text and start URL/focus/visibility are in `native-error-before.log:2`.
- `python /var/tmp/deploy-1627/rca/tilion-webauthn/repro_capture.py`: 11 passes then the identical failure.
  `native-capture/11-cdp.jsonl` preserves both CDP directions. Both successful
  WebAuthn replies are on the popup session before the final navigation.
- `python /var/tmp/deploy-1627/rca/tilion-webauthn/repro_lifetime.py`: six passes then a natural failure. On the failed
  document, the original authenticator ID returns an empty credential list;
  another native request fails identically. Reloading the same target, without
  rearming or replacing the authenticator, gives NotAllowedError, and the same
  authenticator ID remains queryable. `lifetime.log` preserves the full tuple.
- `python /var/tmp/deploy-1627/rca/tilion-webauthn/repro_raw_cdp.py`: two passes then the identical native error, using
  a single raw CDP connection directly to Chromium, no multiplexer and no
  Playwright browser connection (`raw-cdp-concurrent.log`). This proves that neither transport is required for the reproduced symptom;
  shared fixture/environment and native scheduling effects are not excluded.
- A genuine-ACK barrier passed 30 cases, then failed on round 6 of a new cohort.
  `ack-barrier-100-capture/6-cdp.jsonl` shows both successful replies BEFORE
  resume. This directly falsifies an ACK-only repair; no such fix was applied.
- Ten unarmed controls remained pending (`unarmed-capture.log`). Avoiding Window
  return-value serialization still failed on round 7 (`void-return.log`).
- Arming only on Page.frameNavigated returns pending on its first case despite
  genuine enable/add replies (`after-commit.log`): the response-completion failure is not repaired by this asynchronous
  event-triggered arming. This is not a valid fix.
- Pausing the real final popup script with an explicit debugger statement gives
  30/30 passes for early arming and 30/30 for arming at that pause. Both retain the
  same native call and record one actual pause per case. The shared pause changes
  the schedule; these paired successes do not establish an arming-phase cause.
  See `debugger-statement-{early,late}.log` and `repro_debugger_statement.py`.

The exact existing registered case was also executed 30 times with its runner's
capture/environment setup by
`python /var/tmp/deploy-1627/rca/tilion-webauthn/single_case.py 30`.
`registered-case-before.log` ended with 30 success rows and `PASS` (exit 0).
This is a separate passing cohort with diagnostic-only source, not a post-fix
proof and not a full-dispatcher run. The earlier unchanged native-boundary
failures remain unresolved. The command's environment is reproducible through
`bash /var/tmp/deploy-1627/rca/tilion-webauthn/run-case.sh 30`.

The reported earlier ERR_CONNECTION_REFUSED is the storage test's intentional
closed-origin control. Nearby input/4409 warnings belong to preceding deliberate
fault tests. Neither is evidence of the popup's initiating failure.

Pinned primary sources map the exact message to ScopedPromiseResolver's
unreleased/abandoned callback, while an empty native response can yield the same
message. AuthenticatorImpl is a document-lifetime service; the virtual
authenticator manager is instead keyed to a frame-tree node. This supports the
lifetime distinction but does not establish whether this instance lost its
receiver, rejected an inactive frame, or received a null native response:

- https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/modules/credentialmanagement/scoped_promise_resolver.cc
- https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/modules/credentialmanagement/authentication_credentials_container.cc
- https://github.com/chromium/chromium/blob/153.0.8010.12/content/browser/webauth/authenticator_impl.cc
- https://github.com/chromium/chromium/blob/153.0.8010.12/content/browser/webauth/authenticator_environment.cc

Archive searches used `NotAllowedError WebAuthn`, `popup virtual authenticator
hangs`, and the exact native error. No exact native-error case was found. The
native-UI/passkey and Amazon initiation-capture cases are relatives, not proven
recurrences. The adversarial reviewer independently confirmed the error mapping,
rejected the previous timeout/synthetic proof and the ACK-only repair, and kept
the missing native lifecycle event explicit (`reviewer.txt`).

## Solution

Open: no verified behavioral fix. Retained changes in
`agents/tests/blackbox/browser_tilion.blackbox.py` preserve bounds and assertion
semantics while recording the native DOMException message/start state and the
actual result. The existing `multiplexer_arms_webauthn_popups` registration in
run_all_tests is discovered as browser-tilion by agents/scripts/run_blackbox_tests.py;
agents/scripts/run-coverage.sh invokes its parallel blackbox runner during deploy.
The single_case.py driver calls that registered function directly; its result
does not certify full-dispatcher execution. No multiplexer, prompt, runtime
terminal semantics or benchmark definition changed.
Golden reference: not applicable (no approval-gated hunk).

Next meaningful work needs a version-matched native trace/test hook that records
Authenticator receiver bind, RenderFrameHost/document token/IsActive, service
teardown, and null-versus-abandoned response under this same popup schedule.
Neither another timeout, a reload/retry, accepting another exception, nor a
successful paused-script control closes that gap. No backend/worker restart is required. New test processes read the diagnostics;
previously imported modules do not change in a running process. This draft is validated in its own scratch archive; the parent
must integrate it into the repository archive because the investigator's source
ownership excludes docs/rca and INDEX.md.

## Human feedback

The task requires an executed local failure and the same unchanged reproduction
passing after the real fix, forbids timeout bumps/skips/retries-as-fix, and limits
source edits to this blackbox file and the CDP/WebAuthn implementation. The deploy
owner explicitly rejected the prior 20-second wait and required keeping the
cluster open unless a deterministic repair of the native failure is proven.

## Reusable lesson

Capture the native WebAuthn error and distinguish document-service lifetime from virtual-authenticator presence before changing popup readiness or arming policy.

## October30 PR1634 recurrence

The unchanged source fa0310f9f6a55cd4f937f59ab4af51bd385b16fb reproduced the exact armed-popup NotSupportedError during full one-worker agents coverage. The original browser-tilion log is .context/test-runs/agents-coverage-20261030-012155-1751030/browser-tilion.log; domain duration138.0s. The popup was focused and visible, initially loading and subsequently complete. The relevant test, multiplexer and requirements have no diff from the prior f09f6fc11 passing run. Installed browser provenance points to the same pinned Chromium revision; the actual failed browser version was not logged.

Read-only investigation matches this open document-service callback failure; it does not establish the initiating event. Original Chromium stderr was discarded and no raw CDP trace is available. No ACK barrier, wait extension, error acceptance or runtime patch is justified. The original failure remains recorded independently of any later unchanged test result.

After coverage ended, the exact registered case from a byte-identical copy of the test module passed with exit0. Browser profiles were placed under /project for this scoped diagnostic; elapsed time was not recorded. The receipt is /project/rose-speed-comparison-20261028/webauthn-rca/owning-case-result.json. This is not a full-domain or coverage pass and does not prove the initiating event or a fix. No runtime, assertion, wait or timeout changed.

## November 8 new-test-stability recurrence and repair

Blacksmith new-test-stability at 7268c6f78 (8 lanes, busy loops to nproc):
browser-tilion run 3/5 failed the UNARMED control,
`AssertionError: control: unarmed chooser hangs; outcome='NotSupportedError'`,
same native message. The unarmed multiplexer sends no WebAuthn command, so
arming order cannot be the cause (the earlier raw-CDP repro already excluded
the multiplexer). results.json carried an empty message because the domain
returns only `result.all_passed`.

Source: `AuthenticatorImpl::Create` (content/browser/webauth, 153.0.8010.12)
returns without binding when `!render_frame_host->IsActive()` ("e.g. if a
request arrives during a navigation"). The dropped receiver abandons the
callback, ScopedPromiseResolver rejects NotSupportedError, and the per-window
remote has no disconnect handler, so the same document keeps failing while a
reload succeeds — exactly the earlier lifetime observation.

Local repro on a loaded 8-vCPU devbox (4-8 concurrent loops + 6 busy loops):
the popup request started during parse or at its load event, before the
browser reports the popup's /popup commit, failed 17/496 (3.4%); the request
started only after the browser-side `Target.targetInfoChanged` for /popup
failed 0/120 in the paired concurrent cohort. A load-event start still fails
(4/105): the renderer fires load before the loaded browser UI thread has
processed the commit (parse-time calls precede that browser event by 20-75 ms).

Fix (test fixture only; no wait or deadline changed): the popup defines
`request()`; the test waits for the browser-side commit event, then calls it.
D4's hold-before-resume guarantee is asserted directly from the gateway's
ordered client commands (enable + addVirtualAuthenticator precede the popup
session's runIfWaitingForDebugger; the unarmed control sends no WebAuthn
command). Mutation check: removing `or arm_webauthn` from the hold fails it.
The runner now names failing cases and the first error in results.json
(`agents/tests/unit/test_blackbox_runner.py`).
