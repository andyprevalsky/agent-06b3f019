---
id: 2026-08-21-hotels-com-classifier-network-summary-omits-http-status
date: 2026-08-21
title: hotels.com recover_from_challenge false-stable because classifier network summary omits HTTP soft-block status
surface: agents
component: challenge-llm-classifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_llm_classifier.py::capture_network_summary — Performance Resource Timing only (name/duration/transferSize); no HTTP status
symptoms:
  - 'Recovered by selecting kernel_isp; live tab verified clean; signed-in state was preserved'
  - 'Provisioned request rate has been exceeded'
  - 'Expected payment_approval attention request (to ignore) but none was triggered'
  - browser-hotel-booking Timeout after 904s
  - '286ms 108B https://www.hotels.com/graphql'
tags:
  - browser-agent
  - challenge-recovery
  - challenge-llm-classifier
  - hotels-com
  - soft-block
  - graphql-429
  - false-stable
sources:
  - agent 2da69edc-2852-4a90-9d0f-dbc257e1302b
repro: agents/tests/blackbox/challenge_llm_classifier_network.blackbox.py
status: fixed
---

## Problem

After the guest-cookie commit fix, `browser-hotel-booking` still timed out on agent
`2da69edc-2852-4a90-9d0f-dbc257e1302b` (run
`agents/benchmarks/runs/20260821_190847_browser-hotel-booking.json`) with
`Expected payment_approval attention request (to ignore) but none was triggered`
after 904s.

Runtime trajectory (user-confirmed): search listed Hotel Kabuki; property page
opened; `#Offers` stayed `Loading`. Browser agent correctly called
`read_network_requests` then `recover_from_challenge` for GraphQL HTTP 429
(`Provisioned request rate has been exceeded`). Network index:
`hotels.com/graphql` **118× status 429**, **2× status 200**.

`recover_from_challenge` then reported success twice without clearing the
soft-block:

1. Cookie wave → `recovery_action=cookies_sanitized` /
   `Recovered by removing a proven non-auth cookie subset…`
2. After `cookie_recovery_successes >= 1`, handler escalates
   (`escalate_after_cookie_false_stable` in `handler.py`) → config search →
   `Recovered by selecting kernel_isp; live tab verified clean…`

Offers remained Loading / GraphQL 429 continued. Never reached room select /
checkout / `payment_approval`.

## Diagnosis

Part-by-part of `recover_from_challenge` on this soft-block:

1. **Enter recovery** — correct. Tool allows repeated 429; agent entered for the
   right reason.
2. **CAPTCHA solver wait** — N/A / idle. One classifier dump later saw a slider
   CAPTCHA (`challenged=true`); the soft-block path was primarily GraphQL 429 +
   Offers Loading, not a visible interstitial for most probes.
3. **LLM classifier (cookie probes + live verify)** — **first-bad boundary**.
   `capture_network_summary` only reads `performance.getEntriesByType('resource')`
   fields `name` / `duration` / `transferSize`. It never includes HTTP status.
   Classifier dumps for this agent: **0** true HTTP-429 / Provisioned strings in
   the Network metadata block (false-positive `429ms` durations only). Parsed
   outputs: **28× challenged=false**, **1× challenged=true** (CAPTCHA widget).
   Several clean reasons claimed "room listings" / "room-booking controls" while
   Offers were still Loading. Classifier contract asks for "usable destination UI";
   property shell passes that bar without offers data.
4. **Cookie commit** — mechanically correct for known-challenge strip under the
   guest-cookie fix, but **false success vs invocation reason**: soft-block
   remained after `cookies_sanitized`.
5. **Config rotation / live verify** — same classifier oracle → promoted
   `kernel_isp` as clean while GraphQL still 429'd. Escalation that skips further
   cookie waves after one `cookies_sanitized` compounds the false success.

Deepest owned cause: recovery success is gated on a visual/DOM anti-bot
classifier whose network evidence cannot express the HTTP soft-block that
triggered recovery — a harness-contract inconsistency (success ≠ reason cleared).

Archive searches: `classifier network 429`,
`hotels.com recover_from_challenge false success`,
`cookie_recovery_successes escalate_after_cookie`. Relative of guest-cookie
discard case (prior stage fixed) and Eventim/Expedia false-clean relatives;
**this first-bad (network summary omits status) is novel.**

Local owning-boundary repro (FAIL recorded, wall ~0.64s):

```bash
cd agents && python tests/blackbox/challenge_llm_classifier_network.blackbox.py
```

Asserts summary surfaces GraphQL HTTP 429 when status is available; current
capture formats `'286ms 108B https://www.hotels.com/graphql'` with no `429`
→ exit 1.

## Solution

Implemented:

1. `capture_network_summary` prefers Playwright/recorder rows with HTTP status +
   truncated response bodies labeled `response_body (truncated): …`; Performance
   Timing remains fallback. TS mirror updated in
   `back-end/src/providers/browser/challengeLlmClassifier.ts`.
2. Classifier DOM uses stripped full page text (or the live agent `dom_tree`
   when supplied) so Offers/Loading soft-block markers are visible.
3. Agent `recover_from_challenge` `reason` is injected into classifier messages;
   deterministic gate forces `challenged=true` while cited 429/rate-limit
   evidence remains in the network summary. Probe/commit/live-verify thread the
   reason + recorder.

Cemented by `agents/tests/blackbox/challenge_llm_classifier_network.blackbox.py`
(green). Outcome-gate: unchanged `scripts/run-bench --local browser-hotel-booking`.

10k-agent behavior: per-probe summary stays bounded (`_NETWORK_ENTRY_CAP`);
status/body text is O(entries) only — no fan-in.

## Human feedback

User confirmed search results were real, Offers never loaded, network read +
entering `recover_from_challenge` were correct, and asked for an `/RCA` of
whether recover worked — specifically LLM classifier, cookie rotations, and
config rotations. Approved the fix with constraints: truncated response bodies
explicitly labeled, DOM matching the main agent stripped tree, keep screenshot,
and reason-aware verify. Asked to rerun the exact benchmark to see whether
recovery reaches a config with stable GraphQL product responses.

## Follow-up (2026-08-21, agent fa23bb52)

Post-fix exact bench `scripts/run-bench --local browser-hotel-booking` still
**FAIL** (timeout 903s, no `payment_approval`) on agent
`fa23bb52-f77f-4ce4-a62a-8333132ccf9b` (run
`20260821_205032_browser-hotel-booking`).

Classifier/recovery behavior changed as intended:

- Agent reason: `Hotels.com GraphQL requests repeatedly return HTTP 429…`
- Config probes now reject on GraphQL 429 (steel_managed, kernel_isp,
  kernel_mobile, kernel_residential_*, …) instead of false-clean.
- Live verify rejected a promote:
  `Promoted kernel_residential_state passed candidate probes but the live tab is still challenged`
- Network index: graphql `200:3` / `429:59` (3 large 200 bodies) — intermittent
  product payloads, not a stable cleared soft-block through checkout.

Residual outcome gap: hotels.com rate-limit persists across available browser
configs within the 900s budget; fixing the false-stable oracle alone does not
yet produce payment-boundary success.

## Reusable lesson

Never treat challenge-recovery success as cleared when the classifier's network
evidence cannot see the HTTP soft-block status that triggered recovery.
