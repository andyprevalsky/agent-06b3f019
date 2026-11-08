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
   report-bug fixture's live chats: 2 router responses at 33.527/.531, 17 Cerebras responses
   recorded within 3 ms at 16:10:34.642–.645 (a backlog draining after a ~1 s block), then
   nothing until 41.402, then ~25 OpenRouter entries at 42.037–.042. The same CI cache holds
   those chats' follow-up LLM requests whose tool result is `Grep {"pattern":"report-bug.*blackbox.*fixture|..."}
   Error: Pattern safety analysis did not complete`, built at server times 34.687/.688 and
   42.071, 42.117, 42.592, 42.699, 43.020. That ties the CI stall to failed safety analyses
   (some entries are duplicate builds of one turn, one per raced model, so the exact count of
   distinct greps in the 6.76 s gap is about 5–7, not proven). On 6427f84e1 those fixtures
   still started live chats (removed later by PR #1760).
3. Local repro on 6427f84e1 (`run-coverage.sh` with `BACKEND_COVERAGE_BLACKBOX_DOMAINS=report-bug`,
   a fresh-connection `/health` prober every 100 ms): 104 probes slower than 500 ms, worst
   8198 ms. A second run with integration-accounts and integrations beside it reached 10452 ms.
   A third, under `--cpu-prof`, failed `POST /report-bug/screenshots -- signed URL serves the image:
   fetch failed`. Same domain on main: worst probe 78 ms. Not reproduced: the exact assigned
   case. The run with integration-accounts (`bad-ia1`) stalled 10.4 s but its LinkedIn case
   passed. That is consistent with the inferred keep-alive collision, which needs the request
   to land on an idle reused socket during a stall longer than 5 s.
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
on them get `fetch failed`. The keep-alive step is inferred, not captured: no `err.cause`
was recorded in CI or locally. It rests on both processes failing 6 ms after the stall ended
(41.402 → 41.408); a request that was only delayed would have been answered.

Repro commands (system Postgres, from `back-end/`):
`BACKEND_COVERAGE_SKIP_UNITS=1 BACKEND_COVERAGE_BLACKBOX_DOMAINS=report-bug bash scripts/run-coverage.sh`
on 6427f84e1 with a 100 ms fresh-connection `GET /health` prober (stall reproduction), and
`BACKEND_COVERAGE_SKIP_UNITS=1 BACKEND_COVERAGE_BLACKBOX_DOMAINS=data-grep bash scripts/run-coverage.sh`
for the regression: unfixed main `FAIL data-grep ... GET /health took 8498 ms while 8 greps ran
their ReDoS analysis (limit 2000 ms over 85 probes)`; fix branch `PASS concurrent ReDoS
analyses keep the backend answering` (5 consecutive runs).

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
  its native agent subprocess (falling back to a worker thread). `validateGrepInput` and
  `grep()` await it. The verdicts and retries are unchanged, and the 1000 ms shared deadline
  is now enforced in wall-clock time. Adversarial review found that recheck's own timeout
  starts only when its agent runs a request (64 concurrent checks took 9 s on 8 cores), and
  that a dead agent never settles a call. Each call now carries `AbortSignal.timeout` and is
  raced against the deadline. Measured afterwards: 8, 64, and 4-after-SIGKILL-of-the-agent
  calls all settle (fail closed) in ≤1.01 s, with ≤97 ms event-loop lag. A memoized warm-up
  owns the first agent spawn, because recheck races concurrent first calls into several
  agents (7 of 8 leaked). After the agent dies, every grep that needs the analyzer keeps
  failing closed within 1 s until the process restarts, and nothing logs it yet (follow-up:
  warn when the deadline fires, or respawn the agent). Unit regressions in
  `regex-safety.test.ts` cover an analyzer that never settles (dead agent) and one that
  settles only on abort (queued). Both fail without the deadline race.
- Trade-off, stated plainly: under load the deadline rejects benign patterns too. A
  range-based pattern like `[A-Z]{2,4}-[0-9]{2,5}` passed alone in 58 ms and 4/4 beside 4
  in-flight unclassifiable analyses on 8 cores, but 0/4 beside 8 or 16. On a 1–2 vCPU
  instance one or two in-flight analyses are enough. This deliberately trades grep
  acceptance for bounded latency and a free event loop.
- Same trigger with only the fix applied to 6427f84e1 (report-bug, prober): worst probe
  1349 ms, with 25 probes over 500 ms during the 16 concurrent fixture chats. The server log
  has no gap over 0.3 s, so this is CPU load from those chats, not a block. PR #1760 already
  removed those chats from the fixture.
- Regression at the owning boundary: the data-grep blackbox case `concurrent ReDoS analyses
  keep the backend answering`. It sends 8 concurrent greps with the captured pattern, asserts
  each one ran the analysis to its deadline (400 `did not complete`), and probes `/health` on
  fresh connections every 100 ms. Before the fix: `GET /health took
  8498 ms while 8 greps ran their ReDoS analysis`. After: PASS. The unit test now awaits the
  async API with the same fail-closed assertions.
- Observability: `remote_bundle` orders the gate's named evidence and every `.log`/`.txt`
  file (plus `summary.json`/`manifest.json`) ahead of bulk JSON (`bundle_priority`), so a failed shard's server log survives the
  cap. Regression: `deploy-test-github.test.py`
  `test_capped_bundle_keeps_server_logs_before_bulk_coverage_json`. It fails on the old
  ordering and passes now.

Siblings prevented: every grep caller (planner/chat tools, agents, Rose CLI, any other
domain) could freeze a production instance for 1 s per unclassifiable pattern. With the
change this is per-request latency only.

10k-agent behavior: before, N agents grepping such a pattern on one instance serialized into
N seconds of total unavailability for all users of that instance. Now each analysis is one
JSON-RPC message to a single recheck agent subprocess per backend process. That adds no
per-agent channels, rows or locks. The analyses use CPU in the agent process, so beyond
about one per core they queue. The wall-clock deadline bounds each grep's analysis at 1 s
and rejects the overflow fail-closed, rather than letting latency grow with N. Analyses
compete with Node for CPU on small instances, but they never block its event loop.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Never run a bounded CPU analysis synchronously on a shared server's request path; a "sync with timeout" call (checkSync/Atomics.wait) still freezes every other request for the whole budget, so use the async off-thread API and test the server's responsiveness while it runs.
