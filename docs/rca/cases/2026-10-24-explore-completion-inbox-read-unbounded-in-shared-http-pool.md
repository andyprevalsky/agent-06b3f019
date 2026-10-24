---
id: 2026-10-24-explore-completion-inbox-read-unbounded-in-shared-http-pool
date: 2026-10-24
title: Explore completion-time inbox GET hung 558s inside the shared HTTP pool, tripping the mass-agent tree-stall detector
surface: agents
component: agent-inbox
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/helpers/agent_inbox.py fetch_agent_inbox — the completion-time GET (AgentInbox.unread_before_finish, called from the explore attempt_completion_with_result branch in domains/spawn_agent/service.py) relied on httpx per-phase timeouts over the shared pooled client, which do not bound waiting inside the pool
symptoms:
  - "tree stalled — newest-active leaf c53c4301-2ded-4bfb-880c-29695bd1bf48 silent for 513s (threshold=510s"
  - "attempt_completion_dispatch duration_ms=558175 status=error"
  - "Child terminal reconciliation failed: Activity task timed out"
  - "demo_cache.web_fetch_miss_live reason=soft_complete_not_allowlisted"
tags:
  - mass-agent
  - explore-agent
  - agent-inbox
  - httpx-pool
  - tree-stall
  - demo-cache
  - web-fetch
sources:
  - agent 54bb3ec5-bccd-41f6-b7ed-586ffa1a8958
  - fleet run 20261024-221904-485227
  - agent 1f3da847-09e6-4a7c-9f70-e93df8cd4caa
  - commit 373825135
  - memory:mass-agent-stall-pins-worker-drain
repro: agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_completion_inbox_read_is_wall_clock_bounded; agents/tests/blackbox/web_fetch.blackbox.py::test_web_fetch_activity_replays_a_cached_provider_error_without_a_live_scrape
status: fixed
---

## Problem

The second cloud copy of test-mass-agent-run-0 on 7b1ea6691 failed with "tree stalled".
The silent leaf was c53c4301, the Allie K Miller GP, whose explore stopped making progress at
22:29:00. worker.log shows the explore dispatched `attempt_completion_with_result` at
22:29:00.279. That `attempt_completion_dispatch` span ran 558,175 ms and ended only when the
stall PAUSE cancelled it. Its explore `run_agent` span was the only span left open. In the same
window, backend.log has no `/agent-inbox` request for c53c4301 at all.

The suspected cause, the one live uncached web_fetch, is refuted: it ran on a different GP
(81fc3ca5, Justin Welsh), started at 22:30:46 (after the stall began) and took about 16s.

## Diagnosis

On an explore with evidence, the completion branch's only await is
`agent_inbox.unread_before_finish()`, which makes one `fetch_agent_inbox` GET on the shared
pooled `get_http_client()`. Its `timeout=5.0` is httpx's per-phase timeout, which does not
cover waiting inside the shared pool. The GET never left the worker (no backend receipt) and
never timed out.

It started during a burst of `post_agent_message` "Activity timeout (attempt 1/3)" events on the
same worker, the single-worker saturation seen in P9 (memory
mass-agent-stall-pins-worker-drain). The pool recovered for other posts, but this awaiting GET
never returned.

Deeper rung: P9 bounded the explore FE posts with `asyncio.wait_for` but left this sibling read
on the same client unbounded. The class is backend reads on the shared pool with no wall-clock
bound.

The cause of the wedged pool wait itself (httpcore state under CPU starvation) was not
reproduced. The repro proves the unbounded boundary with a client whose `get` never returns.

Separately, the mass-agent tree made one live web_fetch per run. That URL's scrape fails
(Firecrawl 500 plus Parallel Extract connect_error), and the web_fetch DEMO cache had no shape
for a failed fetch, so the recording has no row and every replay scraped live.

## Solution

- `fetch_agent_inbox` wraps the GET in `asyncio.wait_for(..., AGENT_INBOX_TIMEOUT_SECONDS)`.
  A stuck read becomes the existing logged poll failure ("[AgentInbox] poll failed; continuing
  without new agent messages") and returns [], so completion proceeds. The 510s stall threshold
  and the other timeouts are unchanged.
- `web_fetch_activity` replays a DEMO row with a `provider_error` field as the same
  non-retryable `WebFetchProvidersFailed` tool error, without scraping.
- Recorded through prod `/api/fast-cache/set`: new row
  `fastmode:v42:web_fetch:global:5b9954e2b4f4c3d42f163d91` holding the real error captured on
  2026-10-24T23:02Z (sha256 8090a0f1…). It was a miss before; the receipt is in
  `.context/descend/descend-full69-20261023/ma2-cache-backup/receipt.jsonl`.
- Verification: both repros fail on 7b1ea6691 (hang / ImportError) and pass on 373825135. The
  spawn-agent and web-fetch blackbox domains pass. Exact local
  `scripts/run-bench --local test-mass-agent-run-0`: PASS 18/18, $0, 3,485/3,485 LLM calls
  fast-cache, 0 web_fetch/web_search misses, no scrape (one `web_fetch_error_hit`), 0 stub
  strings. FE: https://www.roselabs.ai/?agent-id=1f3da847-09e6-4a7c-9f70-e93df8cd4caa
- The stall was not reproduced locally; local runs use 6 workers, the cloud guest 1.
- Golden reference: `codex/codex-rs` and `claude-code-src` bound network reads with explicit
  overall deadlines (AbortSignal / tokio timeout) rather than relying on per-phase client
  timeouts. The fix converges on an explicit overall deadline.
- 10k agents: one timer per inbox read; no new I/O or shared state.

## Human feedback

The parent relayed Andy's rules: mass-agent must be fully DEMO cached (zero live calls; cache
misses are bugs; the task's cache may be changed directly). Do not raise the 510s stall
threshold or any timeout; a hang past a tool's own deadline is a real bug that needs a
bounded, truthful error.

## Reusable lesson

Bound every await on the shared HTTP client with an overall wall-clock deadline, because httpx per-phase timeouts do not cover pool waits; and give each cache a shape for recorded failures so replay never retries live.
