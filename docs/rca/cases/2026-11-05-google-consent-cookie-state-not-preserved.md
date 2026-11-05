---
id: 2026-11-05-google-consent-cookie-state-not-preserved
date: 2026-11-05
title: Observed-realm credential discovery overwrote an active Google OAuth transaction
surface: cross
component: browser-session-auth-restore
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Observed-realm preparation coupled credential inventory to cookie replacement and reloaded an already-started OAuth transaction
symptoms:
  - "The server cannot process the request because it is malformed. It should not be retried."
  - "HTTP 400 /signin/oauth/v3/consent after Google account selection"
tags:
  - google-oauth
  - tilion
  - cookie-restoration
  - reproduced
sources:
  - agent 532bb208-f642-400e-9141-307796e0bd67
  - commit cb18bbe044b77a362aaa74055318feba01e4d0f4
  - plan:.context/phone-harness/google400-rca-result.json
  - agent ba0296d9-c93d-4043-8318-9bdd6f88199d
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: mitigated
---

## Problem

The user's ordinary production Rose agent reached DoorDash's Google sign-in,
selected the configured Google account, then observed Google's literal malformed
request page. Captured network diagnostics record a GET to
`accounts.google.com/signin/oauth/v3/consent` returning 400. This happened before
password entry or phone approval; it is not evidence of rejected credentials or
the separate "browser may not be secure" failure from earlier local runs.

The run used production-default Tilion direct US egress and observed Windows
Chrome 156. The user fingerprint payload was null. The existing exit-locale
emulation path still applied a user-agent override; therefore "all browser
emulation was disabled" would be inaccurate. The browser task closed, and the
owned phone lease was released with no pending operation. Root COMPLETED denotes
completion of the honest blocked report, not successful DoorDash login.

## Diagnosis

Observed path: normal root -> browser task -> DoorDash sign-in -> observed
standalone sign-in link -> Google account chooser -> just-in-time saved-cookie
restoration -> account selection -> consent HTTP 400. The standalone link's
state matches the actual `signIn[0].href` returned by the page-evaluation tool;
it differs from the iframe's state because it is a different observed link.
Do not mistake that difference for an invented state parameter.

The investigation decrypted the run manifest and 96 private artifacts,
including all 92 archived LLM requests, both DB snapshots, and pause/resume
state. The full tool history establishes the navigation and restore sequence.
The snapshots do not contain Cookie, CookieBundle, or LocalStorageOrigin rows.
The network export redacts query values and lacks response bodies. The chosen
Google cookie source had been updated after the failed run when inspected;
current data cannot reconstruct its original payload. The older local seed
selects a different cookie bundle and is also not a faithful replay fixture.

A bounded two-session diagnostic used the same current cookie payload and
locale/UA path, restoring before versus after OAuth started. Neither produced
400: the before-flow arm reached `/v3/signin/challenge/dp`; the after-flow arm
remained at `/v3/signin/identifier`. Both exact diagnostic sessions returned 204
on deletion. This is negative exploratory evidence, not causal proof: the
payload differs from the incident, local storage was omitted, and the probe
used a fresh iframe-derived standalone route instead of the original observed
header sign-in link. No claim of a passing normal-agent outcome follows.

Those preliminary candidates were not a completed diagnosis. The resumed
investigation reproduced the failure through a second normal production agent,
`ba0296d9-c93d-4043-8318-9bdd6f88199d`, with the identical task and production
defaults. A read-only private capture bracketed its DoorDash and Google
preparations with unchanged data digests. Both runs selected DoorDash cookies
from Chrome Default, then selected Google cookies from Chrome Profile 1.

The missing initial condition was the Default profile's existing Google jar:
`cookieSelectionWhere` deliberately carries SSO cookies alongside DoorDash's
cookies. Google realm discovery subsequently selected a different profile,
merged its cookies into the existing jar, and reloaded an active transaction.
Thus the earlier empty-jar timing experiments did not exercise this sequence.

A frozen-source two-arm comparison reproduced Google's literal malformed400
when Profile 1 replaced Default after OAuth started. Applying the same
replacement before starting OAuth reached Google's device-approval challenge.
Both used the same Tilion direct/locale path, and both sessions were deleted
with HTTP204. This locates the issue in mid-transaction state replacement,
without attributing it to fingerprinting, provider choice or model intelligence.

The exact live owning-service reproduction then called the actual local
`prepareSessionCredentials` boundary with an inventory-only option. Before the
change it ignored that option, returned `worker_apply`, and the real Google flow
failed with malformed400 (exit1, 51.9 seconds). After the change, the identical
command returned inventory without mutable state, and account selection
advanced to Google's ordinary password challenge (exit0, 9.6 seconds):

`agents/venv/bin/python .context/phone-harness/private/google400-rca/live-service-policy-repro.py`

Private real-user payloads remain outside Git. Permanent registered regressions
use synthetic data: the authenticated backend inventory-only route initially
failed because it returned `worker_apply`; the agent tests initially failed
because observed redirects restored/reloaded state. The final affected Python
domains pass, including explicit pre-navigation restore, new-realm private
inventory, stale-backend mutation rejection and failed-discovery quarantine.

Archive searches used `Google HTTP 400 malformed consent` and
`oauth popup accountchooser cookie injection`. The cookie-bundle-ranking and
stale-pre-minted-OAuth cases are relatives, not demonstrated recurrences.
Managed new-thread creation returned `delegation_service_unavailable`; an
existing independent managed investigator was subsequently reused. Its report
independently identified the source-lineage mechanism and reviewed the
reference lifecycle. The implementation approval review is recorded separately.

## Solution

The local fix separates credential inventory from browser-state restoration.
The existing owned preparation endpoint accepts optional
`restore_browser_state=false`; it returns full credential inventory before any
world-state fork or cookie/origin injection. Omission retains existing restoration.
Observed redirects/popups use inventory-only preparation and never reload that
active transaction. Explicit pre-navigation restoration remains unchanged.
The worker rejects an unexpected Tilion mutable payload on an inventory-only
request and preserves existing credential-failure quarantine and redaction.

This converges on the lifecycle used by browser-use's storage-state watchdog
(restore on connect or explicit load), Hermes's context-before-navigation state
loading, and OpenClaw's separate read/write cookie operations. It is not a
Google-specific URL/error classifier or a fingerprint workaround.

Status remains mitigated while approval, deployment and the unchanged normal
agent's post-deployment login outcome are pending. Reaching a password or device
challenge is causal fix evidence, not proof of successful DoorDash login or phone
approval. No timeout, task goal or evaluator was relaxed.

## Human feedback

The user required the test to run through a normal Rose agent with the cloud
phone attached, challenged assumptions about fingerprint injection and alternate
browser routes, and explicitly requested `/rca`. A hand-driven provider probe
does not replace that normal-agent acceptance criterion.

## Reusable lesson

Keep credential discovery separate from browser-state restoration once an authentication transaction has started, and preserve private source-lineage evidence for replay.
