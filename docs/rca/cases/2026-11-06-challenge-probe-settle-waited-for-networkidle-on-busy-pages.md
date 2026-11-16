---
id: 2026-11-06-challenge-probe-settle-waited-for-networkidle-on-busy-pages
date: 2026-11-06
title: Challenge-recovery candidate probes waited out a 60 s networkidle cap on busy pages, so config searches outran the 300 s recover-challenge read deadline
surface: back-end
component: browser-challenge-recovery
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/browser/challengeLlmClassifier.ts classifyPageAfterSettle → waitForDomSettled waited for Playwright networkidle (up to 60 s) before its only classification; challengeRecoveryPromote.ts applied a search deadline only to transport failures
symptoms:
  - "Browser challenge recovery failed: ReadTimeout"
  - POST /api/browser-session/recover-challenge duration_ms=216235
  - Challenge recovery lane candidate probed latencyMs=66874
  - challenge recovery took 3-5 minutes of a 900 s benchmark budget
  - Challenge recovery search aborted for stopped agent after the caller already timed out
tags:
  - browser
  - challenge-recovery
  - networkidle
  - playwright
  - deadline
  - recover-challenge
sources:
  - fleet run 20261106-125725-4136708 (campaign-20261106-125707-4128298, source a17dbe5aec) browser-imax-group-tickets r1
  - fleet run 20261106-125726-4136711 browser-instacart-grocery-order r1
  - agent c5e453c4-5981-42da-8eea-85549e7e3cc9
  - agent 21b5c143-eb5a-44a2-9365-2041e3e368ed
repro: back-end/src/tests/unit/browser-challenge-recovery-settle.test.ts and back-end/src/tests/blackbox/browser-challenge-recovery-tilion-transport.cases.ts (ordinary challenge config search ends before the caller read deadline)
status: mitigated
---

## Problem

Descend batch 2 (source a17dbe5aec): the worker's `recover_browser_challenge`
POST `/api/browser-session/recover-challenge` (httpx timeout 300 s) hit
ReadTimeout exactly 300 s after "Searching browser configurations" in
browser-imax-group-tickets r1 (13:25:52→13:30:52Z) and
browser-instacart-grocery-order r1 (13:35:03→13:40:03Z). Successful recoveries
still cost 3–5 min (instacart r1 4m54s, r2 4m45s, hotel-booking r1 3m05s);
imax r1 and both instacart copies timed out before payment.

Guest backend logs (remote-logs/runtime-evidence/logs/backend.log) show every
candidate probe at 62–74 s whether clean or challenged (e.g. instacart
`latencyMs` 65842, 68587, 70147, 74269 winner; hotel clean probes 65251–65948;
imax 66319, 68527, 62421, 66488). Probes on pages that went network-quiet were
fast (3.4 s, 4.6 s, 7.9 s, 8.2 s, 27 s). Lanes run in parallel but each lane
walks up to 8 configs serially, so a search costs up to ~8 × 70 s. imax's
exhaustive search finished at 13:31:24 (332 s), 32 s after the client gave up;
instacart's second search kept probing kernel_isp/tilion candidates until the
agent stopped at 13:43:10, three minutes after the ReadTimeout.

## Diagnosis

Breakdown of instacart r1 recovery #1 (294 s): cookie-variant wave 3 parallel
ephemeral probes ~68 s; config search 216 s = 3 serial candidates per lane at
~70 s; each candidate = create ~2 s + goto ~3 s + settle 60 s + 1.5 s quiet +
classifier ~3 s. imax: 47 s provider-solver wait (45 s ceiling, intentional),
then the 8-config search.

1. First-bad boundary: `classifyPageAfterSettle` called
   `waitForDomSettled(page, 60_000)`, which waited for Playwright `networkidle`
   (no request for 500 ms) with the remainder of 60 s. Storefronts keep
   beacons/long-polls running and never become idle, so every probe on a real
   site spent the full 60 s before its single classification — even when the
   page was already clean. A static block page idles at once and is rejected
   fast, so the wait penalised exactly the candidates we want. Proof: local
   repro, a clean page polling every 150 ms took 61,607 ms to be accepted.
2. Why it could outrun the caller: `searchAndPromoteBrowserConfig` set
   `searchDeadlineMs: 210_000` only for transport-failure reasons (commit
   4605391fd3); ordinary challenge searches had no bound, so per-candidate cost
   × serial configs surfaced as a client ReadTimeout with no
   `failed_config_keys`, and the orphaned search kept renting sessions. Proof:
   blackbox case with hung probes still searching after 10 s on the old code.
3. Next rung (not fixed here, separate cluster): many candidates were rejected
   although the page was usable — the probe captures the agent DOM text at
   domcontentloaded but the screenshot after the settle (imax: "seat map is
   visible, but the DOM still shows Loading", cleanedDomChars=7/31), and the
   classifier requires the recovery reason (login reCAPTCHA, same-origin API)
   to be visibly cleared, which a single navigation probe cannot show (relative
   of 2026-10-02-challenge-classifier-rejects-clean-candidates-on-unprobed-post-failure).

Archive searches: "recover-challenge ReadTimeout 300 config search probe
latency networkidle" and "challenge recovery slow minutes candidate probe
networkidle settle 60 seconds". Relative (same mechanism, different surface):
2026-10-05-semantic-auth-readiness-waited-for-network-idle. Not a recurrence.

## Solution

- `classifyPageAfterSettle`: settle at most `CHALLENGE_LLM_FIRST_SETTLE_MS`
  (8 s) and classify; a clean result is final. Only a page that is still
  challenged AND never went network-idle waits out the rest of the original
  60 s solver budget and is classified once more. The second look uses the same
  inputs and time point as the old single look, so the accepted set is a
  superset of before; quiet pages behave exactly as before. Both classifier
  usages are forwarded to the probe ledger.
- `searchAndPromoteBrowserConfig`: every search is bounded by
  `RECOVERY_SEARCH_DEADLINE_MS` (210 s, 90 s under the worker's 300 s read
  deadline), not only transport failures. The search ends with
  `ChallengeConfigSearchExhaustedError` + `failed_config_keys`, aborts its
  lanes and releases candidates instead of being orphaned.
- 10k agents: no new shared state; per-candidate session hold time drops from
  ~66 s to ~10 s for busy clean pages and every search's session rent is capped
  at 210 s. Busy challenged candidates make one extra rose-1-mini call (~0.64¢).

Regressions: unit `browser-challenge-recovery-settle.test.ts` (real Chromium,
stub classifier: RED 61,607 ms → GREEN) and blackbox case "an ordinary
challenge config search ends before the caller read deadline" (RED still
searching after 10 s → GREEN). Golden reference: not applicable (no
approval-gated hunk); browser-use similarly bounds its page-load network wait to
a few seconds rather than waiting for raw network idleness.

Outcome proof (exact benchmark local fail/pass) not yet run; the classifier
rejection rung (3) is still open, so status is mitigated.

## Human feedback

None recorded.

## Reusable lesson

Never gate a per-candidate decision on Playwright networkidle with a long cap: sample early, accept clean, spend the solver budget only on still-challenged busy pages, and bound every search under its caller's deadline.
