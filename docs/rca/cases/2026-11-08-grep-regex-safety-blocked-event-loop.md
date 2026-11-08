---
id: 2026-11-08-grep-regex-safety-blocked-event-loop
date: 2026-11-08
title: Grep's synchronous ReDoS analysis froze the shared coverage backend and dropped keep-alive sockets
surface: back-end
component: data-grep-regex-safety
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/data/regexSafety.ts checkPatternSafety called recheck checkSync, which parks the Node main thread on Atomics.wait (synckit) for up to its 1000 ms deadline on every grep the local proof cannot classify
symptoms:
  - "FAIL  LinkedIn upload: a corrupt archive ends the run sync_failed -- fetch failed"
  - "Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards."
  - shared coverage backend stopped answering for seconds, then several domains got fetch failed in the same millisecond
  - backend-coverage-blackbox artifact has no server-shard2.log (bundle.json skipped it)
tags:
  - backend-coverage
  - blackbox
  - event-loop
  - grep
  - regex
  - recheck
  - keep-alive
  - fetch-failed
  - deploy-gates
sources:
  - PR #1762 deploy cycle 2 (head 6427f84e11f0a9c0becc754ae5017858e9903607), GitHub Actions run 42389794271 artifact deploy-gate-result
  - PR #1760 (report-bug fixtures no longer start live chats; removed this run's trigger)
  - commit 4a0e080d71e3f8f9972e912d4ecc1c44de7ed6b1 (originating merge)
repro: back-end/src/tests/blackbox/data-grep-responsiveness.cases.ts (registered by data-grep.blackbox.ts)
status: fixed
---

## Problem

Backend coverage shard 2 (Blacksmith 16 vCPU, `cd back-end && npm run test:coverage:sharded`)
on 6427f84e1 failed `integration-accounts` / `LinkedIn upload: a corrupt archive ends the run
sync_failed -- fetch failed`. The LinkedIn code was correct: its last DB read logged at
16:10:34.693Z, then its `GET /api/integrations` to the shared backend (localhost:12024) got no
answer until undici reported `fetch failed` at 16:10:41.408Z. In the same millisecond the
separate `integrations` domain process logged `FundedKeyCooldownWait: attempt 3/40 failed ...
error=fetch failed`. In-process domains (`rose`, `rose-transport`) kept logging through the
window, so the host was running; only the backend stopped answering.

The uploaded artifact had no backend server log. `scripts/deploy_test_github.py remote_bundle`
copied files smallest-first under a 400 MB total cap: about 3,000 raw V8 coverage and
replay-cache JSON files (≈360 KB each) filled the budget, and `bundle.json` listed both
`back-end/coverage/server-shard2.log` (10.3 MB) and the preserved failure copy as skipped.

## Diagnosis

1. Schedule reconstruction from `summary.json` durations and the runner's order (weight, then
   name, 4 workers) matched the observed start times within 0.4 s. It put `report-bug`
   (started ~16:10:33.4) on the server when the stall began. Its screenshot case took 9255 ms
   where its siblings took ~200 ms.
2. The server's outbound replay cache (`.context/fast-forward-cache/outbound-fetch`, entries
   carry write timestamps) shows every chat-completion call in the window came from the
   report-bug fixture's live chats: 16 Cerebras responses were recorded at 16:10:34.642–.645,
   then nothing until 41.402, then ~25 OpenRouter entries at 42.037–.042. On 6427f84e1 those
   fixtures still started live chats (removed later by PR #1760).
3. Local repro on 6427f84e1 (`run-coverage.sh` with `BACKEND_COVERAGE_BLACKBOX_DOMAINS=report-bug`,
   a fresh-connection `/health` prober every 100 ms): 104 probes slower than 500 ms, worst
   8198 ms. A second run with integration-accounts and integrations beside it reached 10452 ms.
   A third, under `--cpu-prof`, failed `POST /report-bug/screenshots -- signed URL serves the image:
   fetch failed`. Same domain on main: worst probe 78 ms.
4. The server log shows each silent gap (1.00–1.02 s, one of 2.09 s) ends in
   `[ChatHandler] Grep failed ... Pattern safety analysis did not complete`. The chats grepped
   `report-bug.*blackbox.*fixture|blackbox.*fixture|report-bug` with `-i`.
5. CPU profile: 9.3 s of main-thread self time in synckit `receiveMessageWithId`
   (`index.cjs:375`, its Atomics.wait receive) under `regexSafety.ts`, 35% of the 26.6 s
   profile and the largest consumer.
6. Standalone: `checkSync` on that benign pattern returns `unknown` after the full 1000 ms on
   every call, uncontended. Async `check` (native agent) ran 8 concurrent analyses in 1.2 s
   with ≤25 ms event-loop lag.

Causal chain: one grep the local proof cannot classify → `checkSync` blocks the only JS
thread for its whole deadline → concurrent greps from many agents queue one after another →
the backend serves nothing for N seconds → when it resumes, Node's 5 s `keepAliveTimeout`
timers run before the queued socket reads and close reused idle sockets → clients waiting
on them get `fetch failed`.

Step 5a ladder: Why 1, the shared backend stopped answering: its event loop was blocked.
Why 2, blocked: `checkPatternSafety` ran the ReDoS analyzer synchronously on the request
path. Why 3, possible: the guard was written as a pure synchronous validator inside
`validateGrepInput`, and nothing tested the backend's responsiveness while it ran. Why 4
would be recheck's design (it documents that `checkSync` blocks the process), which we do
not own. Stop at Why 3.

Gate: NOT_INTRODUCED. PR #1762 (web_fetch title label) does not touch the grep path; the
blocking call predates it. The assigned repair is owned here regardless.

## Solution

- `regexSafety.ts`: `checkPatternSafety` is async and uses recheck's `check`, which runs on
  its native agent subprocess (falling back to a worker thread). The 1000 ms shared deadline,
  the two retries and the fail-closed verdicts are unchanged. `validateGrepInput` and
  `grep()` await it.
- Regression at the owning boundary: the data-grep blackbox case `concurrent ReDoS analyses
  keep the backend answering`. It sends 8 concurrent greps with the captured pattern and
  probes `/health` on fresh connections every 100 ms. Before the fix: `GET /health took
  8498 ms while 8 greps ran their ReDoS analysis`. After: PASS. The unit test now awaits the
  async API with the same fail-closed assertions.
- Observability: `remote_bundle` orders the gate's named evidence and every `.log`/`.txt`
  file ahead of bulk JSON (`bundle_priority`), so a failed shard's server log survives the
  cap. Regression: `deploy-test-github.test.py`
  `test_capped_bundle_keeps_server_logs_before_bulk_coverage_json`. It fails on the old
  ordering and passes now.

Siblings prevented: every grep caller (planner/chat tools, agents, Rose CLI, any other
domain) could freeze a production instance for 1 s per unclassifiable pattern. With the
change this is per-request latency only.

10k-agent behavior: before, N agents grepping such a pattern on one instance serialized into
N seconds of total unavailability for all users of that instance. Now each analysis is one
JSON-RPC message to a single recheck agent subprocess per backend process. It adds no
per-agent channels, rows or locks, and the event loop stays free. The analyzer verdict and
its 1 s bound per request are unchanged.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Never run a bounded CPU analysis synchronously on a shared server's request path; a "sync with timeout" call (checkSync/Atomics.wait) still freezes every other request for the whole budget, so use the async off-thread API and test the server's responsiveness while it runs.
