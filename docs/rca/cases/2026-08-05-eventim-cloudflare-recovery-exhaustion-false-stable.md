---
id: 2026-08-05-eventim-cloudflare-recovery-exhaustion-false-stable
date: 2026-08-05
title: Eventim Cloudflare Access Denied exhausted recover_from_challenge after short CAPTCHA waits and false-stable Steel promotions
surface: cross
component: browser-challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py recover_from_challenge — claimed success after promote without live-tab re-verify; same-host restore goto re-triggered WAF
symptoms:
  - 'No stable browser configuration cleared the challenge'
  - 'Waiting for the browser provider''s automatic CAPTCHA solver before changing state.'
  - 'Recovered by selecting a stable browser configuration; signed-in state was preserved.'
  - 'Access Denied'
  - browser-1015-eventim-request-card Timeout after 1201s
tags:
  - browser-agent
  - cloudflare
  - eventim
  - antibot
  - challenge-recovery
  - kernel
  - steel
  - captcha
sources:
  - agent ee191cc8-cecf-4ad2-bebf-08e960be0ae7
  - commit d0fd1b5bc5ef50d4aa63fe3724ee0b04c1b5cd7d
repro: none-recorded
status: mitigated
---

## Problem

Local benchmark `browser-1015-eventim-request-card` timed out at 1201s
(agent `ee191cc8-cecf-4ad2-bebf-08e960be0ae7`, run
`agents/benchmarks/runs/20260805_163018_browser-1015-eventim-request-card.json`)
without a `payment_approval` attention request. The browser hit Eventim's
Cloudflare hard "Access Denied" on `wl.eventim.us` / `eventim.us`, burned most
of the wall clock in staged `recover_from_challenge`, and never reached a
durable payment-card step before the dynamic timeout.

Runtime evidence (worker + backend + agent messages):

- Started on Kernel CDP (`onkernel.com`), then three live reconnects to Steel
  CDP after "proxy rotation" / config promotion.
- `recover_from_challenge` ran four times with the full staged progress:
  captcha_solver → known challenge cookies → all target cookies → parallel
  Kernel+Steel config search.
- Recoveries 1–2 finished with
  `Recovered by selecting a stable browser configuration` then immediately saw
  a new Access Denied Ray ID on the live tab.
- Recovery 3 errored with `Page.goto: Timeout 15000ms` on `www.eventim.us`.
- Recovery 4 failed with
  `browser_challenge_recovery_failed` /
  `No stable browser configuration cleared the challenge`
  (`[BrowserChallengeRecovery]` backend ERROR at 16:27:45Z).
- Late in the run (~16:29Z) a plain navigation finally loaded the LYNY ticket
  page (GA Tier 2 $31.13); quantity was set to 1, then the session died on
  checkout clicks (`Target page, context or browser has been closed`) as the
  harness timed out.

## Diagnosis

Critical path:
`spawn_browser_agent_v3` → Eventim URL → Cloudflare Access Denied →
`recover_from_challenge` (`agents/.../challenge_recovery.py`) →
`_wait_for_provider_captcha_solver` → cookie probes →
`searchAndPromoteBrowserConfig` (`back-end/.../challengeRecovery.ts`
`browserRecoveryCandidates`: Kernel residential/mobile/isp + Steel
managed/fixed) → promote winner CDP → live page still challenged / eventually
exhaust configs → timeout.

Answers to the forensic questions from this run's evidence:

1. **IP rotation tool:** There is no `rotate_ip` action in
   `agents/providers/rose/browser_use.py` / `agents/browser_tools/schemas.py`.
   IP/provider rotation for this path is the staged
   `recover_from_challenge` config search. That path ran to completion four
   times (~180–203s each). Separate `rotate_ip` was never invoked because it
   is not exposed to the browser LLM toolset.

2. **Kernel and Steel on Cloudflare:** Both providers were in play. Initial
   live session was Kernel and was Access Denied. Parallel config search is
   defined to probe Kernel + Steel together; the two "successful" promotions
   reconnected the live stack to Steel only. The fourth search ended with
   zero stable candidates (`No stable browser configuration cleared the
   challenge`), which means no Kernel or Steel candidate achieved 2/2 clean
   probe passes in that round. Per-candidate probe pass/fail rows are not
   logged — a logging gap for naming which Kernel tier failed vs which
   Steel mode won earlier promotions.

3. **Auto CAPTCHA wait:** Yes, every recovery started with
   `Waiting for the browser provider's automatic CAPTCHA solver before changing
   state.` and polled `/captcha-telemetry`. Wall times were only ~4–9s, not
   the 45s ceiling. Cause: `_wait_for_provider_captcha_solver` exits after three
   inactive polls when `isSolving` never becomes true; Kernel telemetry sets
   `isSolving: null` by design (`captchaTelemetry.ts`), and Steel never
   reported an active solve for this hard Access Denied page (not an
   interactive captcha widget). Candidate probes separately run a 45s
   page-poll `waitForProviderSolver`, but the pre-search live-session wait
   short-circuited.

Owned secondary defects (not yet reproduced as isolated failing tests):

- False-stable promotion: probe declared a winner and the agent was told
  recovery succeeded, but the live tab remained Access Denied after storage
  restore.
- Pre-search CAPTCHA wait is ineffective on Kernel (`isSolving` always null)
  and on hard WAF blocks with no solver task.

Primary outcome class remains third-party Cloudflare WAF hard-block /
antibot; the harness did exercise recovery, but not a durable path to the
payment-card gate within 1200s.

## Solution

Deduced live winner from browser-agent observations: **Steel `managed`**
(`proxy_tier: managed`, sessions `bd99b7cd` / `a34c8721` / `52e5a680`). The late
clear was on that Steel managed session, not a logged Kernel residential/mobile
winner.

Generalizable harness fixes (no timeout / evaluator relaxation):

1. Live re-verify via `verify_live_page_cleared_challenge` after promote+restore
   before emitting recovery success; false-stable promotions now fail with
   `passed candidate probes but the live tab is still challenged`.
2. That live verify must **navigation-probe** the target URL (not accept a
   static snapshot of already-loaded probe content). Repro on
   `bad0cac8-3668-462e-9a44-10e4d0d1491f`: backend promoted
   `steel_managed` (`stablePasses=2`), static live verify claimed clean, then
   the agent's next same-host goto re-hit Access Denied Ray
   `a26810d81beac303`.
3. Preloaded restore skips same-host re-navigation (WAF re-trigger) and uses the
   45s probe navigation budget when a goto is required.
4. CAPTCHA solver wait keeps polling while the live page looks challenged even
   when Kernel `isSolving` is null.
5. Backend `BrowserChallengeRecovery` logs every candidate
   create/probe/promote with `configKey` / `proxyMode` / `stablePasses`, and
   returns `config_key` on the promote payload. Deduced winner from those logs:
   **Steel `managed`**; Kernel isp/residential/mobile all `stablePasses=0`;
   `steel_fixed` unavailable (`No active fixed IP proxies`).
6. Config search always strips known challenge/clearance cookies before probing
   fresh provider/IP candidates (keep auth + opaque). Transplanting
   `cf_clearance` from the blocked exit poisoned Eventim Turnstile probes
   (`47cdeb21-…`: steel_managed `0/2`, kernel_mobile `1/2`, then
   `No stable browser configuration`). After the strip,
   `a949133c-…` got `kernel_residential_city` + `steel_managed` both `2/2`.
7. Preloaded promote must not re-run origin restore: the restore script
   `localStorage.clear()` + rewrite of the challenged capture poisoned the
   clean winner, so live nav verify failed
   (`Promoted kernel_residential_city … live tab is still challenged`) despite
   two clean candidate probes.
8. Challenge classifier must not treat bare `/cdn-cgi/challenge-platform` or
   Turnstile script URLs as a wall when the page already has substantive body
   text. Cleared Eventim ticket HTML embeds both next to "General Admission"
   inventory; that false-positive made candidate probes report `stablePasses=0`
   and live verify reject a clean tab (`d0e8ddca-…`: promote `kernel_mobile`
   1/2 then "live tab is still challenged" while network captures showed the
   ticket document). Log each probe attempt's detection `reason` + `title`.

Cemented by `challenge_recovery` + `spawn_browser_agent_v3` blackbox tests +
unit `browser-challenge-recovery` Eventim-shaped classifier cases.
Exact-bench outcome still required before status=`fixed`.

## Human feedback

User asked whether IP rotation was used completely, whether both Kernel and
Steel failed Cloudflare, and whether auto captcha solving was waited for.
No fix approval requested yet.

## Reusable lesson

Treat `recover_from_challenge` success plus a new Access Denied Ray ID as a
false-stable promotion until the live tab is re-probed, and never assume the
pre-search CAPTCHA wait ran for 45s when Kernel `isSolving` is null.
