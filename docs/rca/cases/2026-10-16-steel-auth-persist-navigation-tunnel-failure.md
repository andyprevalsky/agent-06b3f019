---
id: 2026-10-16-steel-auth-persist-navigation-tunnel-failure
date: 2026-10-16
title: Steel auth-persistence navigation failed once while unchanged focused and full follow-ups passed
surface: harness
component: browser-provider-live-qualification
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: browser-provider.auth-persist.live.ts readSignedIn (and the first Kernel sign-in block) reached the browser's cookie jar and localStorage only by a real page.goto to https://example.com through the session's residential exit, which some exits refuse for the whole session
symptoms:
  - 'FAIL live Kernel/Steel auth persist'
  - 'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/'
  - 'live-probes browser-provider FLAKY'
  - '/rotate-proxy 500: {"error":"page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://api.ipify.org/'
  - 'FAIL live Kernel provider parity: /rotate-proxy 500'
tags:
  - browser-provider
  - steel
  - auth-persistence
  - proxy
  - coverage
sources:
  - PR #1510
  - commit 7ced2be3325b7043f4e214b6ad970543febcd745
  - task lantern-7ced2be3-backend
  - PR #1975
  - PR #1734
  - commit 910dd40a1404f1cb4abaa212e585bbff842ad14b
  - memory:kernel-live-parity-upstream-reset-flake
  - PR #1809
  - commit d9ae5e3214bc75ec7320c850c9778c003092d94f
repro: 'back-end/src/tests/blackbox/browser-provider.auth-persist-origin.support.ts (browser-provider domain): real Chromium behind a local proxy that answers every CONNECT with 502; pre-fix the fixture read failed with page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/, post-fix it passes with zero CONNECTs'
status: fixed
---

## Problem

At immutable `7ced2be3325b7043f4e214b6ad970543febcd745`, full backend owner71769 started at 04:18:19Z and failed after534.0s: 276 unit files passed, 198/199 blackbox domains passed. Browser-provider failed in its live auth-persistence case; coverage thresholds and both teardown regressions were not reached. The original failure remains retained.

## Diagnosis

Initial Kernel sign-in/export/close succeeded. Steel session creation succeeded at 04:20:25.239Z. `readSignedIn(switched.ws_url)` then navigated to `https://example.com/` and raised `net::ERR_TUNNEL_CONNECTION_FAILED` through the existing bounded navigation helper, before restored-cookie/storage assertions and the later Kernel allocation. No upstream HTTP status, proxy response, or timestamped individual navigation attempt was captured. The failure is bracketed by creation and cleanup beginning04:20:33.659Z; its deeper cause is unknown.

The fixture/provider/coverage files are byte-identical to prior passing9f/5221 sources. Current credential fields were present; values were neither printed nor historically compared. Root reported official Kernel/Steel status pages operational; that does not establish this session's transport cause or exclude a localized failure.

Native custody journal `auth-persist-ZdtzOf/custody.json` records cleanup-complete, zero failures, and successful release of both browsers, Kernel profile and local fixture. Processes joined, owned ports closed and prepared DB had zero other clients.

### Recurrence 2026-10-26 (PR fix/scale-s5-cookie-sync-diff deploy)

Backend coverage at `7825de8dd` (diff limited to the cookie upload path, no browser-provider code) failed only
`browser-provider` with the same `FAIL live Kernel/Steel auth persist: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/`
(224/225 domains; bundle `backend-coverage-failed-20261026-175357-4111023`). The unchanged focused
`bash scripts/run-blackbox-tests.sh browser-provider` failed identically at ~18:00Z, so the tunnel failure persisted for
several minutes rather than being a single blip. The earlier coverage run on the same SHA (17:22Z) had passed this domain.

## Solution

Fixed 2026-11-14 (branch `fix/steel-auth-persist-tunnel-origin`). The fixture now reads and writes its example.com
sign-in state (`readTargetOriginState`, `signInOnTargetOrigin` in `browser-provider.auth-persist.live.ts`) through
production's own `createOriginPayloadWriter` (`providers/steel/injectionOriginPage.ts`): a route-fulfilled synthetic
exact-origin document that reaches the browser's cookie jar and localStorage without opening a proxy tunnel. That is
the same path production uses to restore and to harvest origin storage (`sessionAuthPersist.ts`
`readHarvestableLocalStorage`). All three navigation sites of the case (first Kernel sign-in, middle Steel/Tilion
read, later Kernel read) changed; every assertion, timeout and the session/provider sequence are unchanged. The
`quarantine` marker `pending-handoff:d8dda0b4f50146c8b81e9df5c1e965eb` was removed. Egress reachability stays covered
by the live provider parity cases, which still navigate the live site on purpose. The Kernel/Tilion variant shares
`readSignedIn` and is fixed by the same change.

The origin pages stay open, like the user's signed-in tab, so `/close` still harvests the sign-in from the open-page
branch of `readHarvestableLocalStorage` as before (independent review finding; the regression asserts an open
example.com tab after sign-in).

Same-class sites not changed, with reasons: `browser-provider.tilion-harvest.live.ts` (opt-in
`RUN_TILION_HARVEST_LIVE=1`, not in any /deploy lane) and `browser-provider.browser-use-handoff.live.ts` (opt-in
`RUN_BROWSER_USE_HANDOFF_LIVE=1`) still navigate example.com through a proxied session; both are outside the deploy
path and out of this repair's scope. Production agents meet the same ~5% per-exit refusal on Steel; challenge recovery
already treats `ERR_TUNNEL_CONNECTION_FAILED` as a transport failure that moves to another candidate
(`challengeRecoveryTransport.ts`, `challengeRecoveryCandidates.ts`), so no production change is part of this fix.

Regression: `browser-provider.auth-persist-origin.support.ts` (browser-provider domain, offline) launches real Chromium
behind a local proxy that 502s every CONNECT. A control case proves the fixture reproduces the live error on a real
navigation; the regression proves guard-cookie read, sign-in write into the cookie jar and origin storage, read-back,
no cross-site cookie leak, a fresh context reading signed-out, and zero CONNECTs.

### Earlier recovery notes (2026-10-16, superseded by the fix above)

No causal code fix was established or applied. Root authorized one unchanged normal focused retry: owner60543 ran `cd back-end && bash scripts/run-blackbox-tests.sh browser-provider`, actual start04:30:05.260021Z, next eligible due04:40:05.260021Z. It passed in105916ms (wrapper118.8s); custody cleanup succeeded and its newly owned standalone DB was dropped before further work.

The canonical coverage wrapper deletes raw V8 inputs at startup and EXIT; its failure bundle preserves logs, not raw V8. `--report-only` still runs the suites and only changes report enforcement. No supported partial resume or retained original V8 existed, so no synthetic report aggregation was attempted.

Root separately authorized one fresh full top-level coverage macro, owner50406, starting04:32:47.540323Z with the same source/normal command, explicit owned prepared DB and unchanged concurrency. It passed in545.1s: 276 units, 199/199 domains, statements/lines89.72%, branches81.25%, functions93.04%, both normal-exit and SIGTERM teardown regressions. Cleanup joined with ports closed/zero DB clients. These are recovery observations, not proof of a causal fix. Existing owning browser-provider coverage remains unchanged; no new test, skip, timeout, proxy or credential change was introduced. Transport cause remains open.

Private receipts are retained under the isolated preflight `.context/preflight-artifacts/`: original `backend-result-7ced2be3.json`, focused intent/log/cleanup, source/native timeline comparisons, and `backend-result-7ced2be3-followup.json`. The original failure bundle is `backend-coverage-failed-20261016-042712-3243065`.

## Human feedback

None recorded.

## Reusable lesson

When a test asserts browser state, reach that state the way production does, not through a live network hop the test does not assert on.

## October 29 renewed investigation — U4 original target recovered

Read-only recovery located two encrypted original checkpoint objects for task
`049e6363-f71a-596f-927e-03c3769066b8`. Revision 2's single saved tab exactly
matches the original failed ipify navigation, including its nonce; it has no
cookies, storage origins or tab-session entries. The earlier missing-checkpoint
gap is closed. Encrypted revision 2 SHA256:
`4db6f1da4c6d014d74ed79dc46a24ed52ba1e7528f351519998ea385f6b20d1a`.

A read of the exact already-released Steel session returns region `iad`,
proxySource `steel`, 60759 proxy bytes, zero events and empty metadata. These
are retained metadata, not the original CONNECT response. No allocation,
release, CDP attachment or payment was performed by this investigation.

The original proxy refusal response and reason are unavailable in retained
evidence or the installed SDK's historical APIs. This does not establish an
outage, credential failure or malformed request. Historical U4 and attribution
remain OPEN; no runtime fix is proposed. Evidence:
plan:.context/unresolved-six-20261029/storage-tunnel/U4-REPORT.md.

## November 14 root cause (recurrence on PR #1975 live probes)

Recurrence: PR #1975 deploy live-probes on `910dd40a14` (occurrence `d8dda0b4f50146c8b81e9df5c1e965eb`, 2026-11-12
18:52Z), passed on its same-source rerun (FLAKY) and was quarantined. Earlier recurrences: 2026-10-26 (above), PR #1734
(waived on `466030ae3e`), PR #1658 on 2026-10-31.

Live boundary probe (2026-11-14 03:39–03:45Z; script, JSONL results and pre/post-fix logs archived in the private R2 trace-archive bucket at `rca-evidence/steel-auth-persist-tunnel/20261114/rca-bundle.tar.zst`, sha256 `daeebe14b27b93ab4c83b5dc5df7777978f1cd2068bf3914527292bd5f701463`): 40 fresh Steel sessions with the
managed residential proxy geolocated US/CA, each navigating `https://example.com/` up to 3 times with the fixture's
1 s/2 s backoff, then `https://www.iana.org/` and `https://api.ipify.org/`. 2/40 sessions (exits `130.51.4.187` and
`66.74.59.71`) failed all three example.com attempts with `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at
https://example.com/` in about 450 ms each (an immediate CONNECT refusal, not a timeout), while the same sessions on the
same exits loaded iana.org and ipify with 200. The other 38 passed on the first attempt.

Causal chain: Steel pins one managed residential exit per session. About 5% of exits refuse CONNECT to example.com
for the session's life while reaching other hosts, so `navigateKernelPage`'s same-exit retries cannot recover. The
fixture needed that navigation only to obtain an example.com document for `document.cookie` and `localStorage`; the
case never asserts on egress. Why the exit refuses that destination is inside Steel's upstream proxy network and not
observable from the CONNECT response; we stop the why-ladder there. The owned defect is the fixture's dependence on a
live network hop it does not test, while production reaches the same state through a network-free synthetic origin.

Classification: test bug (fixture-environment mismatch). Golden reference: not applicable (no approval-gated hunk).

Before/after, identical commands from `back-end/` on this source:

| Command | Pre-fix | Post-fix |
|---|---|---|
| `bash scripts/run-blackbox-tests.sh browser-provider` (offline regression) | exit 1: `FAIL auth-persist sign-in state is read and written without a proxy tunnel: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/` | exit 0, 5/5 consecutive runs |
| `env BROWSER_PROVIDER_LIVE=1 BLACKBOX_TEST_CONCURRENCY=1 bash scripts/run-blackbox-tests.sh browser-provider` (the live-probes recipe) | intermittent FAIL on the probed exit refusal (about 5% of Steel sessions) | exit 0, 5/5 consecutive runs, each `PASS live Kernel/steel auth persist (second=steel, later=kernel)` |

Post-fix run logs: R2 trace-archive `rca-evidence/steel-auth-persist-tunnel/20261114/final-runs.tar.zst`
(sha256 `cf2b41900e07a1af087f0441fcbb0efcdc5ea6cc9dba2fe985b7960ee4cd17ff`).

## November 15: rotation restore of a saved tab (PR #1809)

This is a separate call site from the auth-persist fixture fixed on November 14. It is the boundary the October 29 U4 section recovered: the saved ipify tab inside a logical-browser checkpoint.

**Occurrence.** PR #1775 attempt 4 (source `3bf66999e`) failed live provider parity with `/rotate-proxy 500: {"error":"page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://api.ipify.org/?format=json&nonce=466beac0-...`. The handoff called it Kernel; the server log shows rotation 4, `currentProvider=steel targetProvider=steel recoveryAction=ip_rotated`. Steel created and validated session `067a4858-ac9a-...` at 07:42:09–10Z. `restoreLogicalBrowserCheckpoint` reached `navigation_started` at 07:42:11.263Z, and its one strict `page.goto` of the saved tab failed 584 ms later, turning the whole rotation into a 500. The saved tab was the live test's own exit-IP probe, captured at the earlier `/close`. PR #2106's live probes hit the same boundary on 2026-11-14 21:37:45Z (676 ms after `navigation_started`; same-source rerun passed). Attribution: `Gate: NOT_INTRODUCED` by PR #1775.

**Reproduction.** `back-end/src/tests/blackbox/browser-session-rotation-restore.cases.ts`, registered from `browser-session-hydration-failure.cases.ts` (browser-session domain), replays the captured error through the real `rotateBrowserProxy` and checkpoint restore with a fake provider and page. On unfixed code it fails with the identical `Error: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://api.ipify.org/...`, both on the original base and again after the 11-14 sync. With the fix:
- a single tunnel failure recovers on the same session;
- a persistent failure stops after 3 attempts and never publishes ACTIVE;
- a timeout stays terminal after one attempt;
- a binding change stops the retry.

**Fix (PR #1809, merged `d9ae5e3214`).** Retry only `net::ERR_TUNNEL_CONNECTION_FAILED` around the restore navigation: 3 attempts, 500 ms and 1.5 s apart, with the restore binding rechecked on every attempt. Other navigation failures stay terminal, and partial hydration still never publishes ACTIVE.

**Rejected in adversarial review: refunding the reserved rotation when restore fails.**
- The row's provider is already committed, so a retry would not retake the same rung.
- A refund on every error removes the cap on paid allocations.
- A destination that refuses connections should advance the ladder, not pin the run to one rung.

Without a refund, a caller's retry still advances to the next rung on a new exit.

**Verified.**
- The browser-session domain passes locally.
- Live Kernel provider parity passed on Blacksmith on four fixed sources: `dff3073e5` and `41e018685` in backend coverage (11-08 cycles, archived under `.context/deploy-cycles-pr1809-20261108/`), then `845860844` and `4c0ec0165` in live probes after main moved the case there.
- The final gate round passed all 17 gates on `4c0ec0165`. Its smoke ran with the five `agent-payment-*` tasks elected out (Andy, 2026-11-15 02:13:52Z, "skip agent card tests"); the previous round on `845860844` ran them and passed 11/11.
- Production at the merge SHA: Render (verified in the first production run, carried forward), backend probes and the production semantic lane passed.
- Symptoms: the archive allows five search strings, so this update replaced the bare `'net::ERR_TUNNEL_CONNECTION_FAILED'` (still matched inside the two longer strings) and `'198 passed, 1 failed, 199 total'` with the two `/rotate-proxy 500` strings.

**Still open.**
- Why the proxy failed the tunnel. No CONNECT response is retained. The `browser-checkpoint:restore-navigation` retry warnings now log each attempt, so a recurrence will show whether a same-session retry recovers. The November 14 finding (about 5% of Steel exits refuse example.com for a whole session) suggests some refusals will exhaust the bounded retry; that case still fails the rotation, and the caller's next rotation moves to a new exit.
- A restore that fails after all retries leaves its replacement session bound to the row until it is superseded or closed. This predates the fix.
