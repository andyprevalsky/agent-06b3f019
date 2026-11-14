# Round 23 FLAKY attribution: browser-auth-account-locked (occurrence 0abef87d9243474f8097fbc34b36f604)

Gate: NOT_INTRODUCED

Source: PR1682 HEAD fe7238984a665af7f6636697e4528be5343892a7 (merge-base d194525202). First attempt agent
ebc611d7-3f66-4cd9-ac94-a35174c2f9be FAILED; rerun agent 2eef2834-2a94-4fa0-8e98-457269aa4ed0 PASSED on the same source.

Evidence dir (E): .context/deploy-cloud/cd796b6a00dc209dfd92816a1c9070b9ba66073728a9624eb6ae7927b8633e9f/runs/20261111-121208-2657137/browser-auth-account-locked/
Worker log: E/remote-logs/runtime-evidence/logs/worker.log ; Backend log: E/remote-logs/runtime-evidence/logs/backend.log

## Causal chain (first bad event first)

1. 12:23:43.203Z backend.log:1136 — Tilion session sess_c3d0eb3af7c9476f84c6e6e481f50c8a allocated (proxyType=direct).
   This is the only Rose->Tilion API traffic until 12:25:21 (backend.log:1128-1146, next Tilion line is 3633).
2. Browser agent behaves correctly on the locked account: password rejected `locked` (12:24:12.793Z), code
   request `code_withheld` (12:24:26.851Z) per run.json logs.auth_test_site.report.attempts. At 12:24:31 it
   issues a 30 s `wait` action ("I'll wait to see whether a code arrives automatically.").
3. During that idle wait, with no Rose CDP command or Tilion API call logged (worker.log 12:24:32-12:24:52 only
   has an EventBus watchdog line and autoscaler poll), the PROVIDER closes the socket:
   worker.log:4912 `12:24:52.779 [CdpMux] Provider closed the CDP socket (label=session:ebc611d7-..., code=1012, reason=)`
   (1012 = service restart). browser_use reconnect: worker.log:4914-4926 attempts 1-3 fail,
   `12:24:56.720 All 3 reconnection attempts failed`.
4. Tilion confirms the session is gone provider-side: backend.log:3633-3634
   `GET /v1/session/sess_c3d0.../connect status=410` -> `Tilion HTTP 410 ... connect: shutdown`.
   Rose's own pause came AFTER the close (backend.log:3268 Pausing at 12:25:02.488; 3288 `Failed to close
   browser session error=Error: Browser checkpoint connection failed`).
5. Wait ends 12:25:01; tab_rebind fails; worker.log:4948 `Browser automation failed TargetClosedError:
   BrowserType.connect_over_cdp: ... client disconnected`. spawn_browser_agent #1 returns ERROR to root
   (worker.log:4979/4981, last_status=ERROR). Because the browser agent crashed instead of finishing with its
   account_locked outcome, no auth_assistance attention request was raised (second half of failure_reason).
   credential_failure_classifier still classified `account_locked` (message 12:25:05.553Z).
6. Root planner reacts to the crash tool result by re-spawning (12:25:21, prompt: "Context from a previous
   attempt (which crashed mid-run due to a browser di[sconnect])") -> spawn_browser_agent count 2 -> exact root
   count check fails. Re-spawns fail with `Logical browser saved checkpoint is missing` (backend.log:3651..4284)
   because the pause/checkpoint could not be taken from the already-dead Tilion session.

## Why PR1682's diff is not on this path

- First bad event is a provider-originated WebSocket close (code 1012) + Tilion `410 shutdown`, during an idle
  wait with zero Rose-originated Tilion calls between 12:23:43 and 12:25:21. Nothing Rose sent precedes it.
- Code owning the failing hops is unchanged by the PR (`git diff d194525202 HEAD --stat` empty for each):
  agents/browser_tools/cdp_multiplexer.py (emits the close line), back-end/src/providers/browser/tilion*.ts
  (tilion.ts, tilionClient.ts, tilionSessionIo.ts, tilionState.ts, tilionReaper.ts, tilionRotateInPlace.ts,
  tilionConfig.ts), back-end/src/providers/browser/checkpoint.ts ("Logical browser saved checkpoint is missing" /
  "Browser checkpoint connection failed"). browser-use reconnect loop is third-party
  (venv browser_use/browser/session.py:2295; browser-use pin unchanged).
- PR-touched browser files that ran here do not explain a remote close: the schema field-ordering changes
  (agents/browser_tools/schemas.py, agents/helpers/llm.py, agents/providers/rose/browser_use.py) affect LLM
  response shape only; the browser agent's actions before the close were correct and the LLM was idle (wait).
  agents/browser_tools/cdp_probe.py (new) is never invoked in this run (0 log matches). The playwright pin
  (>=1.51.0 -> ==1.63.0) is the client side of the local mux; a client cannot make the provider report 1012 /
  session `shutdown`, and no client disconnect/Browser.close is logged before 12:24:52.
- The root re-spawn is the expected planner response to an ERROR (TargetClosedError) tool result; it is a
  consequence of the provider loss, not an independent planner/schema defect.
- Same source, same task, rerun passed with one spawn and a normal close (rerun worker.log only `code=1000`;
  only ERROR is the expected "Browser paused while awaiting authentication assistance.").
- Across all 24 locally retained cloud smoke worker logs (.context/deploy-cloud/*/runs/*/*), every other
  "Provider closed the CDP socket" is a normal code=1000 teardown with no failed reconnect; this run is the
  only code=1012 mid-run close. No main-source comparator with the same 1012 event exists locally, so the
  NOT_INTRODUCED gate rests on the provider-originated close + unchanged owning code, not on a main repro.

## Open items (not PR1682)

- Why Tilion shut down sess_c3d0eb3af7c9476f84c6e6e481f50c8a (1012) is provider-side and unobservable from our
  logs: open observability gap (Tilion X-Request-ID bf1e82ff915e405f for the 410).
- Reliability gap: after a provider-side session loss the logical re-init fails 5x with "saved checkpoint is
  missing" instead of starting a fresh session (checkpoint.ts / browser-session init, unchanged by PR) — repair
  candidate for a separate handoff under .claude/shared/deploy-failure-policy.md.
