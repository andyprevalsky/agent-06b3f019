---
id: 2026-08-04-challenge-recovery-misses-bing-soft-verify-overlay
date: 2026-08-04
title: Challenge recovery treated Bing soft Verify overlays as clean and skipped config search
surface: agents
component: browser-challenge-recovery
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_recovery.py — page_looks_challenged missed Bing soft Verify overlays (results in DOM + Verify CTA), so cookies_sanitized returned and config search was skipped
symptoms:
  - "Timeout after 304s (dynamic cap=300s) | Agent status: ACTIVE (expected COMPLETED)"
  - "Recovered by removing a proven non-auth cookie subset; signed-in state was preserved."
  - "Still showing verification. Let me click Verify"
  - "The DOM only shows the verify overlay, but the actual results might be present"
  - browser-bing-search-single-result
tags:
  - browser-agent
  - challenge-recovery
  - cloudflare
  - bing
  - page-looks-challenged
sources:
  - agent fcfff774-41f8-4879-a6e4-8eed77a6697f
repro: agents/tests/blackbox/challenge_recovery.blackbox.py
status: fixed
---

## Problem

`browser-bing-search-single-result` timed out at 304s with the root agent still
`ACTIVE`. Sibling `browser-google-search-single-result` passed in 240s on the
same fleet run.

Runtime evidence from agent `fcfff774-41f8-4879-a6e4-8eed77a6697f`:

1. Bing served a Cloudflare challenge, then a soft **Verify** overlay with
   organic `b_algo` results already in the DOM.
2. `recover_from_challenge` took the known-challenge-cookie path and reported
   `cookies_sanitized` success (~+149s) — **no** `browser_config_search` stage.
3. Reload immediately showed Verify again; the agent burned ~+166s–+284s in a
   Verify-click / wait loop before extracting results via `evaluate`.
4. Completion verification started at +310s — after the 300s dynamic cap — so
   the harness timed out with status still `ACTIVE`.

Google on the same fleet escalated cookie failure into config search, selected
a new browser/IP, and finished verification at +225s.

## Diagnosis

Critical path: Bing challenge → `recover_from_challenge` →
`page_looks_challenged` probe/commit → (false clean) `cookies_sanitized` →
skip config search → agent Verify-click loop → budget exhausted → ACTIVE timeout.

Archive searches (`cookies_sanitized challenge recovery false positive`,
`page_looks_challenged Verify overlay`, `browser agent stuck ACTIVE timeout
verifying`, Cloudflare challenge cases) found relatives (CDP heartbeat during
Cloudflare freeze; Google path using config search) but **no prior case** for
soft-Verify false-clean probes. Novel at this boundary; related to prior
Cloudflare browser-agent work.

First-bad boundary: `page_looks_challenged` returned false for pages whose
visible text is a lone Verify CTA (or "Verification required") over Bing
results HTML (`b_algo` / `b_results` / `b_respl`) without classic markers
(`verify you are human`, `cf-chl-`, Turnstile URL). Cookie probes/commits
therefore passed, and `recover_from_challenge` returned `cookies_sanitized`
instead of escalating to the config/IP search that cleared Google.

Pre-fix measurement (old classifier):
`soft Verify overlay challenged=False`,
`verification required + Verify overlay challenged=False`.

Post-fix measurement (new classifier + cemented tests): both challenged=True;
`soft_verify_live_commit_escalates` returns `config_selected`.

## Solution

Teach `page_looks_challenged` to treat Bing soft Verify gates as challenged:

- text marker `verification required`
- collapsed body matching only `Verify` / `Verification required`
- HTML `<button>Verify</button>` co-occurring with Bing results markers

When the live commit then fails, existing recovery logic already escalates to
`search_with_preserved_auth_state` (config/IP search) — the path that passed
Google. Cemented in
`agents/tests/blackbox/challenge_recovery.blackbox.py`
(`bing_soft_verify_classifier`, `soft_verify_live_commit_escalates`).

10k-agent behavior: pure local string/HTML classification on recovery probes —
O(1) per probe, no new shared state, fan-in, or per-agent subscriptions.

Exact unchanged benchmark outcome proof remains pending for `/descend` after
harness-fix approval.

## Human feedback

None recorded.

## Reusable lesson

When challenge recovery claims cookie success but the live tab still shows a
Verify gate, treat the soft overlay as challenged and escalate to config/IP
search — never accept a results-DOM-behind-Verify page as clean.
