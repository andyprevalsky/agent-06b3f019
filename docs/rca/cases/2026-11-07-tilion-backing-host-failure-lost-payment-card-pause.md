---
id: 2026-11-07-tilion-backing-host-failure-lost-payment-card-pause
date: 2026-11-07
title: Two co-located Tilion sessions died together, so the payment-card pause failed and no card request reached the workflow
surface: cross
component: tilion-browser-session-pause-checkpoint
classification: third-party-failure
problem_class: observability-trace-capture-gap
first_bad_boundary: Earliest observed candidate, causality inside Tilion unproven - Tilion sessions sess_993d70da041b (browser-smoke) and sess_993d70cb6a2a (agent-payment-abandonment) stopped answering CDP at the same instant (last provider reply 33.1s before 12:09:20.1Z in both guests) and the provider closed both sockets at 12:09:33.43Z; our code first misbehaves only afterwards, when checkpointLogicalBrowser cannot connect during the payment-card pause
symptoms:
  - "Expected validated payment-card request but none was observed"
  - "BrowserSessionCloseError: Browser session cleanup failed: session=sess_993d70cb6a2a4cf28aa5a3276625076f, pause=True, HTTP=500"
  - "[CdpMux] Input.dispatchMouseEvent not answered by the provider within 10s; failing it to the client"
  - "[CdpMux] Provider closed the CDP socket (label=session:caeb33b4-3b96-4362-95da-c709b3676683, code=1000, reason=)"
  - "Browser checkpoint connection failed"
tags:
  - tilion
  - cdp
  - pause
  - checkpoint
  - provider-outage
  - agent-payment-abandonment
  - payment-card-request
  - deploy-smoke
sources:
  - commit 9c6d9c3622680aaa2a2668fae861573500023615
  - fleet run 20261107-120351-779261
  - fleet run 20261107-120351-779238
  - agent caeb33b4-3b96-4362-95da-c709b3676683
  - memory:busy-renderer-late-cdp-acks
repro: none-recorded
status: open
---

## Problem

PR #1751 cloud smoke on source 9c6d9c3622 (`scripts/run-bench ... --runs 1 --concurrency 15 --retry-infra 0 --ref 9c6d9c3622`) failed `agent-payment-abandonment`
(agent caeb33b4-3b96-4362-95da-c709b3676683) with `Timeout after 900s ... Expected validated payment-card request but none was observed`. The agent's whole
card path was three browser actions (`goto`, `read_browser_state`, `request_payment_card`). No AgentCard card, transfer, purchase or wallet funding was ever
created (`payment_lifecycle.integrity` all zeros), so there is no stranded fund. Unlike the standing release-stall, nothing was minted and closed.

Run record: `.context/deploy-cloud/b59395a1.../runs/20261107-120351-779261/agent-payment-abandonment/` (`cloudbench-run.json`, guest
`remote-logs/runtime-evidence/logs/{worker,backend}.log`).

## Diagnosis

Timeline (UTC, 2026-11-07; guest worker.log line numbers in brackets):

1. 12:08:42.5 `read_browser_state` finishes; the next LLM step returns `request_payment_card` at 12:08:52.03. A normal run executes that action in about 0.1-0.3 s
   (earlier smokes of this PR: 08:35:13.898 to 08:35:14.018 and 11:17:41.253 to 11:17:41.511).
2. 12:08:57.058 `[CdpMux] Input.dispatchMouseEvent not answered by the provider within 10s` [1379]. The request was sent about 12:08:47.06; the provider has been
   silent since. Guest was idle (diagnostics: 2% CPU, 6 GB free, event-loop lag 0.002 s), so the silence is not local.
3. 12:09:07 `CDP request snapshot/dom_tree/ax_tree/device_pixel_ratio timed out` [1387-1392]: the pre-action page observation consumed the 19 s between the LLM
   answer (12:08:52.03) and `Payment card approval required - returning to workflow` (12:09:11.130 [1403]). The approval return's own state read then stalled
   too (DOM build timeouts 12:09:26 [1419-1424], `ScreenshotWatchdog ... WebSocket connection closed` 12:09:33.433 [1439-1440]).
4. 12:09:20.129 `[CdpMux] Session B881AEF0BC4C silent for 33s ... 15 pending, oldest Runtime.evaluate ... last reply on any session 33.1s ago` [1409].
5. 12:09:33.431 `[CdpMux] Provider closed the CDP socket (... code=1000, reason=)` [1435]; browser-use reconnect attached a new socket at 12:09:35.95 and the provider
   closed that one with `code=1011` at 12:09:36.473 [1459]; all 3 reconnects failed [1477].
6. 12:09:39.529 backend `Pausing browser session sessionId=sess_993d70cb...` (backend.log:2388) then `Retry: Steel session validation: attempt 1/3 failed` and `2/3` (`ws disconnected code=1011`), `Session validation failed` and
   `Browser checkpoint connection failed` (`back-end/src/providers/browser/checkpoint.ts:144-145`), `POST /api/browser-session/close -> 500 duration_ms=9241`
   (backend.log:2460). The activity raised `BrowserSessionCloseError` (`agents/domains/spawn_browser_agent_v3/handler.py:12633-12637`) at 12:09:48.777 [1487] instead
   of returning `awaiting_payment_card_approval`, so the workflow never created the card request. The root agent, forbidden to start a second browser, spent the
   remaining time on four read-only recovery runs and reported the failure (final message 12:23:51, after the 900 s deadline).

Third-party attribution evidence (same fleet run):

- `browser-smoke` (different guest, page https://www.roselabs.ai/, session sess_993d70da041b48d58a816da6e94689e7) shows the identical sequence with the same
  timestamps: mouse unanswered 12:08:57.071 [worker.log:4032], `silent for 33s ... last reply on any session 33.1s ago` 12:09:20.098 [4061], provider close
  `code=1000` 12:09:33.429 [4085] (2 ms from the abandonment guest) and `code=1011` 12:09:36.408 [4121], backend `close -> 500 duration_ms=9899` (backend.log:2763).
  It passed because its answer had been produced before the cleanup failed.
- The two sessions share the Tilion session-id prefix `sess_993d70` and the identical CDP target id `7B6D1EC62A7D`; the other 17 Tilion sessions of the 15-task
  smoke each reported a distinct target id, and the live sessions with prefixes 98241c and c3d0eb (webdecoy, member-discount) saw no trouble. A later sess_993d70
  session (12:11:36) worked. The co-location reading (one backing host or slot) is an inference from those identifiers, not a Tilion statement.
- Tilion control plane degraded in the same window (backend.log of five guests): `POST /v1/session` was 0.6-0.9 s in the first 8 creates, then 502 at 12:08:55.8,
  12:09:35.8 and 12:10:46.2, a 15 s client timeout at 12:09:19.9, and 2.8-10.9 s creates until 12:10:14; normal again at 12:11:36 (0.8 s). No 429/concurrency_limit
  (never more than about 9 concurrent sessions against the 250-session pilot cap).
- The same task's two earlier smokes of this PR (f8c0511b0d, 826c8cf8b8) show 0 CdpMux warnings and 0.5-0.9 s session creates.

Deploy attribution: `git diff --stat 826c8cf8b8 9c6d9c3622` touches only `.claude/commands/deploy.md`, `.claude/shared/*.md`, `scripts/deploy_failure_report.py` and its
test; no agent/back-end/runtime file differs. The AgentCard float floor is exercised only by `POST /api/test-payment/lifecycle/agentcard-setup` (12:08:14-12:08:16, HTTP
200, `list_cardholders`, 4x `get_cardholder_kyc_status`, `recover_funds`), which finished before the agent started; no AgentCard call occurred afterwards.

Deepest owned cause (Step 5a): our pause is deliberately fail-closed (`checkpoint.ts:128` "failure must prevent a successful pause"; registered control
`agents/tests/blackbox/browser_approval_lifecycle_support.py:67-68` `checkpoint_failure`), so a provider session that dies before the approval return loses the
request. That is a documented design decision, not a defect, and a fallback would hide a third-party failure (Step 4). The agent's own `report_bug` (message 39)
blamed cleanup retention; the evidence confirms the 500 and the discarded request but locates the cause one level earlier, in the dead provider session.

Not established: why Tilion ended these sessions, whether browser-smoke's page or our 15-way concurrency (8 session creates in 48 s) triggered it, and whether Tilion
had a public incident. No Tilion-side record was captured. This could not be reproduced locally (it needs the provider to fail), so per the hard gate this is an
observability gap, not a completed RCA.

Archive: searched "Expected validated payment-card request but none was observed", "BrowserSessionCloseError ... pause=True HTTP=500", "Tilion CDP socket closed 1011
provider ... checkpoint", "agent-payment-abandonment timeout no payment card request observed". Relatives, not recurrences:
`2026-11-06-browser-state-fetch-failed-silently-on-dropped-cdp-socket` (same open item: the cause of the provider drop was never observed; recurrence appended
there), `2026-10-28-tilion-pause-checkpoint-waited-for-worker-owned-cdp-socket` (pause failed for a different, local reason: held socket),
`2026-10-02-agentcard-abandonment-closed-card-transfer-never-released` (standing stall, after a card was minted). task_attempts.jsonl rows with this exact symptom
(2026-07-11, 07-28, 08-04 x5, 11-03) predate Tilion's default (2026-10-28) or ran with zero browser trajectory steps; none records a provider socket loss.

## Solution

No code fix. The failing boundary is a third-party provider session death; a fallback that returns the approval over a dead session would mask it and change a
registered fail-closed contract (an approval-gated agent-recovery semantic). The benchmark's one-browser rule and timeout are unchanged (CLAUDE.md rule 25).

Single diagnostic to capture next time: when the backend checkpoint cannot connect (`checkpoint.ts:144-145`) or the worker's CdpMux records a provider close, read
Tilion `GET /v1/session/{id}/status` (fields `state`, `closed_at`, `reason`, already modelled as `TilionSessionRecord` in `back-end/src/providers/browser/tilion.ts:104`)
and put it in the `Failed to close browser session` log line and the `BrowserSessionCloseError` receipt, before the final DELETE. The end-of-run DELETE returned 204 at
12:30:42, 21 minutes after the close, so the record was probably still readable.

## Human feedback

None recorded.

## Reusable lesson

When a Tilion CDP socket goes silent and the provider closes it, compare the last-reply time with every other live Tilion session in the same run before debugging the page, the agent or the AgentCard path.
