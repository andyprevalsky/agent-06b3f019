---
id: 2026-09-10-browser-cdp-latency-causal-evidence-gap
date: 2026-09-10
title: Browser CDP waits precede a WebDecoy deadline failure without enough evidence to assign the cause
surface: agents
component: browser-cdp-observation
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Unresolved within browser state acquisition; CDP document/accessibility/runtime requests timed out, but request transport and renderer liveness were not captured
symptoms:
  - Timeout after 421s (dynamic cap=420s)
  - CDP requests failed or timed out
  - DOMWatchdog.on_BrowserStateRequestEvent
  - Received duplicate response for request
tags:
  - browser
  - cdp
  - webdecoy
  - latency
  - observability
  - unresolved
sources:
  - agent 584b2ac3-e297-458f-b0fb-eee2406767f8
  - agent 31f6bd48-d8ad-47ed-9ac0-3fc8cbcaec65
  - agent 85eff536-1fce-4126-8ec1-9c412993c228
  - fleet run 9e0a52e9-7a52-422a-83cd-23ec69f006f9
  - commit 50284e1ec3ced062b0a1ad42cdc3bb07f0b6ea26
repro: none-recorded
status: open
---

## Problem

The unchanged `browser-biometrics-webdecoy` task failed during a local isolated
deploy smoke run. It reached useful browser completion near the deadline, but
the benchmark paused the root before verification completed. This case remains
an **open evidence gap**, not a diagnosed production defect or timeout-policy fix.

The retained run is
`agents/benchmarks/runs/20260911_011333_browser-biometrics-webdecoy,spawn-sub-agents,parallel-tool-calls,claude-code-agent,browser-smoke,chat-mode.json`.
Run ID: `9e0a52e9-7a52-422a-83cd-23ec69f006f9`; browser task ID:
`de46ca89-806d-5619-8a18-f52a00fa5bcc`.

Verified durable evidence:
[failed agent and browser recording](https://www.roselabs.ai/?agent-id=584b2ac3-e297-458f-b0fb-eee2406767f8).
The canonical `scripts/publish_evidence_links.py` publisher verified 57 messages
and its browser termination/recording checks. Local publication manifest:
`.context/acceptance/rca_evidence/584b2ac3-e297-458f-b0fb-eee2406767f8/manifest.json`.
Private source captures remain under
`.context/acceptance/biometrics-slow-rca/` (directory 0700, files 0600); they are
not checked in and their signed URLs and payloads are not reproduced here.

Observed local outcome:

- `FAILED`; `Timeout after 421s (dynamic cap=420s)`; retained total duration
  435.8 seconds, including termination/collection work.
- Browser activity span: 417.523 seconds. Seventeen browser LLM calls totaled
  58.367 seconds; the slowest was 5.460 seconds. Across all 20 captured LLM
  cache events, the cache tool reported 88% cache hits.
- Two browser-state CDP timeout events and three blocked DOMWatchdog warnings
  preceded long gaps between completed actions and subsequent LLM calls. The
  gaps were approximately 40–65 seconds; they are **not measured durations of
  individual CDP requests**.
- All following timestamps are UTC on 2026-09-11: browser completion response
  at 01:06:32.971; verifier started at 01:06:35.263; root status changed to
  `PAUSED` at 01:06:40.606; verifier reported progress 1.0 at 01:06:41.946.
  Terminal browser metadata and recording were subsequently persisted. This
  does not prove that an unpaused root would satisfy every task evaluator.

Exact executed controller command, from the repository root:

```bash
exec /opt/homebrew/bin/bash .context/setup/run-reviewed-group4-smoke.sh > .context/acceptance/deploy-smoke-bench-4.log 2>&1
```

That local wrapper sourced the reviewed workspace and group-4 environments,
selected Node 22.13.0 and the PG17 client, set loopback `NO_PROXY`, selected
isolated Docker Postgres (`ROSE_USE_SYSTEM_PG=false`), and retained the existing
`BENCHMARK_SKIP_WMH_BUILD=1` setup. It then ran:

```bash
bash scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-local
```

The selector chose seven tasks. The first six ran through the canonical local
runner; the smoke controller exited 1 before the separate mass-agent task. The
recorded child command ran from `agents/`:

```bash
venv/bin/python -u benchmarks/run_benchmark.py \
  --task browser-biometrics-webdecoy --task spawn-sub-agents \
  --task parallel-tool-calls --task claude-code-agent \
  --task browser-smoke --task chat-mode --port 22900 --ci \
  --keep-failed-agents --parallel --max-concurrency 2
```

The scheduler ran WebDecoy in its existing exclusive fixture phase. Source HEAD
was `50284e1ec3ced062b0a1ad42cdc3bb07f0b6ea26`; only generated history changed
during the run. This is the observed local smoke failure. A standalone
`scripts/run-bench --local browser-biometrics-webdecoy` before/after causal
reproduction has **not** been established; no post-fix outcome is claimed.

## Diagnosis

Critical path:

```text
benchmark → Temporal root → browser activity → handler loop browser-state read
→ browser-use DOMWatchdog → CDP snapshot/document/accessibility/runtime calls
→ next browser LLM call → attempt_completion → verifier → benchmark pause
```

The first observed failure is missing/timed-out CDP results during browser-state
acquisition. The retained logs do not distinguish a remote renderer stall, the
remote CDP service/transport, or client receive/dispatch waiting. Consequently,
the deepest owning cause, an owning-boundary failing reproduction, and a
generalizable production repair remain unresolved. `problem_class` describes
the capture gap; it does not assign the task's latency to observability.

Executed comparisons of retained worker events:

| Agent                                  | Outcome | Task seconds | Browser LLM calls | Browser waterfall seconds | DOM timeouts |
| -------------------------------------- | ------- | -----------: | ----------------: | ------------------------: | -----------: |
| `584b2ac3-e297-458f-b0fb-eee2406767f8` | failed  |        435.8 |                17 |                    58.367 |            2 |
| `31f6bd48-d8ad-47ed-9ac0-3fc8cbcaec65` | passed  |        334.2 |                28 |                   121.257 |            0 |
| `85eff536-1fce-4126-8ec1-9c412993c228` | passed  |        291.3 |                16 |                    54.134 |            0 |

These are observational comparisons of unchanged tasks, not controlled
experiments proving a CDP cause. The failed run spent less time in browser
model calls than the adjacent 334.2-second pass; changing model settings or
cache behavior is unsupported by this evidence.

Other executed checks narrow the investigation without proving its cause:

- Root and browser activity schedule-to-start delays were 15 and 12 ms, with
  zero recorded task-queue backlog and 16 available activity slots at start.
- Worker 10 continued emitting loop-lag baselines through its longest
  approximately 56-second agent-event gap. During the task there were 85
  baselines and one lag event; maximum recorded lag was 0.311 seconds.
  Recorded worker CPU median was 1.9%, maximum 9.8%. These samples do not
  support a long local Python event-loop stall.
- The captured `pmset` log contains no Sleep/Wake transition during the task
  window. The previous clamshell-sleep incident is not evidence for this run.
- No browser WebSocket disconnect/reconnect event was found in this task's
  retained worker events. Absence of a disconnect does not prove a healthy
  transport or renderer.
- The worker's actual standard proxy environment contained `NO_PROXY` and
  `no_proxy` for loopback. Reconstructing that environment made Python's
  `getproxies()` return only the `no` entry and produced no Kernel/Steel WSS
  proxy. Browser setup also already invokes `_disable_cdp_websocket_proxy()`
  before DOMService connects, setting `proxy=None`. Both existing blackbox
  assertions pass unchanged (0.413 seconds):
  `test_cdp_use_websocket_patch_disables_proxy_discovery` and
  `test_disable_cdp_websocket_proxy_sets_default_proxy_none`, in
  `agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py`. This is evidence
  against ambient proxy discovery, not a reproduction or fix of this timeout.
- Retained browser network records contain 27 completed requests, maximum
  request-to-response time 2,430 ms and median 403 ms. These are page network
  requests, **not CDP transport timings**, so they cannot close the gap.
- Provider quota/client-version errors were also observed and assigned to a
  separate provider investigation. Their presence alone does not explain the
  long browser-state waits. No provider change was made here.

Latency, log, and cache diagnostics were executed in parallel, using the
isolated worker/backend paths through `NAVI_WORKER_LOGS` and
`NAVI_BACKEND_LOGS`. The retained run contains the worker events used for the
comparisons. Private `findings.json` records measurements and capture inventory.
An initial direct pytest invocation did not understand the repository's
`.blackbox.py` filename; importing the existing test module through
`runpy.run_path` with `PYTHONPATH=.:tests/blackbox` ran the two selected
assertions successfully. That collection error is not the browser incident.

Archive searches executed:

1. `CDP requests failed or timed out dom_tree ax_tree device_pixel_ratio`
2. `browser biometrics webdecoy browser state slow timeout`
3. `DOMWatchdog blocked CDP duplicate response get_browser_state`

Relatives include
`2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery`,
`2026-09-03-post-verifier-reject-unbounded-get-browser-state-tree-stall`, and
`2026-09-07-webdecoy-exclusive-under-isolated-profiles-contention`.
Their boundaries are not demonstrated here: this task ran exclusively, did not
reach a post-rejection state refresh, and has no captured renderer liveness
classification proving the earlier frozen-renderer mechanism. **No recurrence
is established.**

## Solution

No runtime fix is proposed or implemented. Preserve the task, prompts, model,
cache behavior, evaluators, concurrency, and production CDP timeouts. Keep this
case open until a captured owning-boundary reproduction fails, the appropriate
fix makes that same reproduction pass, and the exact unchanged canonical local
benchmark also passes after the fix.

For the next unchanged smoke occurrence, prepare this diagnostic capture
before launch:

1. Instrument only the affected isolated browser tree. Correlate activity span,
   a synthetic connection ID, CDP request ID, CDP session/target ID and protocol
   method. Capture monotonic enqueue/send/receive/completion timestamps,
   elapsed milliseconds, cancellation/timeout/close status, numeric CDP error
   code and pending-request count. Use production `CDPClient.send_raw` and its
   existing socket reader; add no competing reader and change no production
   request contents, scheduling or deadlines.
2. Measure receive-loop and event-dispatch entry/exit separately to distinguish
   waiting for a frame from a response received but not yet dispatched. Record
   only the method, synthetic handler identifier, timings and queue counts.
   Preserve late response metadata after cancellation, pairing duplicate
   responses with their original method and wait.
3. When an outstanding request crosses 10 seconds, run one bounded read-only
   diagnostic probe pair, at most once per 15 seconds while the stall persists.
   On a separate diagnostic connection to the same browser, probe
   browser-process liveness (`Browser.getVersion`/target metadata). Attach that
   connection to the existing affected target (or use its dedicated endpoint)
   and obtain the diagnostic connection's own session ID; never reuse the
   production connection's session ID. Then probe renderer liveness with the
   constant `Runtime.evaluate` expression `1`. Connection/attachment/session
   resolution failures are probe-setup failures, not renderer timeouts. Bound
   setup to five seconds and each diagnostic probe to two seconds; never cancel
   or alter the production request. Do not navigate, reload, recycle targets,
   inject recovery instructions or change page state. Detach the diagnostic
   session and close its connection on completion and teardown.
4. Use a fixed allowlist serializer. Never log WebSocket URLs, auth headers,
   tokens, CDP parameters/results, page text, scripts, screenshots, raw protocol
   frames, provider payloads or exception bodies. Bound each event to 4 KiB,
   identifiers/method names to 128 validated ASCII characters, pending metadata
   to 2,048 entries per connection, the writer queue to 4,096 entries, and
   rotating logs to three 16 MiB files; retain overflow/drop counts. Use fixed
   enums and typed numeric fields for the remaining metadata. Test the
   serializer with synthetic token/URL/payload canaries before use.
   Measure a healthy sample's overhead and preserve worker-loop metrics.
5. Keep normal controller monitoring active. On the first slow observation,
   inspect captures in the same pass and join method waits to the action/LLM
   timeline. A responsive independent connection with delayed production
   dispatch narrows toward the client; responsive browser metadata with an
   unresponsive renderer narrows toward the target; failure of both leaves
   transport/provider liveness unresolved. These are discriminating
   observations, not automatic causal verdicts.
6. Before canonical teardown, preserve the bounded trace and probe summary with
   the run record, existing logs, and publisher-verified browser recording.
   Reconstruct the actual failed response/event sequence at the identified
   owner boundary and run it locally; do not substitute a made-up timeout
   fixture for the missing occurrence. Promote a proven repair's unchanged
   assertion into the owning deploy blackbox suite.

Production socket/dispatch instrumentation remains a plan, and no causal replay
is complete. A runnable ignored helper implements only the independent liveness
portion at `.context/acceptance/biometrics-slow-rca/probe_owned_browser.py`:

```bash
agents/venv/bin/python .context/acceptance/biometrics-slow-rca/probe_owned_browser.py \
  --agent-id <new-root-agent-id> --backend-url http://localhost:<backend-port> \
  --context-dir .context/benchmarks/<new-isolated-run-dir>
```

It reads the exact root's messages and that stack's existing session-start log
IDs, then verifies `agentId`, task row `id`, provider `sessionId` and `ACTIVE`
status using pure `GET /api/browser-session/:sessionId`. It deliberately avoids
`GET /api/browser-session/task/:taskId`, whose implementation reserves passkey
counters. It refuses ambiguous page targets, attaches its own session on its
own direct connection, and probes browser/renderer liveness every 15 seconds.
A concurrent two-second root/session monitor stops sampling on terminal state,
ownership mismatch or read failure. It detaches only its own diagnostic session
and closes only its own socket. It neither creates nor closes provider browsers.

The helper logs only bounded method/status/timing/ID metadata and message-gap
duration. It does not observe production socket requests or prove why those
requests stalled. Its ignored offline self-tests cover fresh session ownership,
terminal cleanup, ambiguous targets, setup/renderer error separation, cancelled
probes, identity mismatches, and payload-free bounded logs. Those tests validate
the diagnostic, not a repair of the benchmark failure.

Scope is one diagnostic tree, bounded per-connection metadata and probe
concurrency, with explicit teardown; no permanent polling or per-user fan-in is
introduced. Any eventual production change still needs its own 10,000-agent
analysis.

## Human feedback

No incident-specific user feedback recorded. Standing RCA rules prohibit
raising task/tool timeouts, changing task criteria, treating elapsed time as an
infrastructure diagnosis, or claiming a fix from proxy evidence. The active
investigation preserved those constraints and made no runtime changes.

## Reusable lesson

Capture CDP request timing and independent browser/renderer liveness during the actual stall before assigning browser latency to the host, proxy, model, or provider.
