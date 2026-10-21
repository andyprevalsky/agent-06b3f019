# Agent Failure Alerting + Auto-RCA

> **2026-10-20 update — agent failures moved off this path.** Root-agent failures
> no longer post to Slack or dispatch a GitHub Auto RCA; `report_failure_activity`
> only logs. Every real prod agent run that is not COMPLETED 24 hours after it
> started gets one Report Bug `/rca` from the backend's hourly stuck-agent job
> (`back-end/src/domains/agents/stuckAgentBugReportService.ts`). Chat, SMS,
> WhatsApp, and backend-crash alerts below are unchanged.

## Goal

When anything user-facing breaks in prod — an **agent breaks**, the **chat loop**
errors, the **SMS agent** errors, or the **backend/DB dies** — page a Slack
`#errors` channel. Optionally (behind a flag) auto-launch a headless Claude Code
agent that runs `/rca` and opens a draft PR with a local repro + fix + cemented
test, so a human can review a ready solution instead of a blank page.

## Design principles

1. **Never route alerts through our own backend/DB.** The failures we most want
   to hear about are the ones where the backend/DB is unhealthy, so an alerter
   that depends on our infra goes silent exactly when it matters. Every emitter
   posts **directly to Slack** (bot API, with incoming-webhook fallback); the RCA
   trigger posts **directly to GitHub's API**. No Prisma table, no internal route.
2. **Emitters never throw.** They live in callers' catch blocks and must not turn
   a handled failure into an unhandled one. Fire-and-forget.
3. **In-memory dedup, no DB.** A per-process throttle suppresses the same failure
   signature for 5 min so a crash-loop can't firehose `#errors`. Bounded map,
   O(1) per failure — holds at 10k agents (no per-agent state).
4. **RCA is flag-gated (`AUTO_RCA_ENABLED`, default off).** Production enables
   it explicitly only after the workflow, credentials, and lifecycle card are
   deployed and verified.
5. **Full outage needs an external monitor.** A dead process can't page itself;
   an external uptime monitor pinging `/health/deep` is the only net for "backend
   or DB is fully down."

## Capture surfaces

| Surface                  | Insertion point                                                         | Emitter                                              |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| Agent breaks (root only) | `agents/workflows/agent_workflow.py` `_mark_failed`                     | `report_failure_activity` → Slack                    |
| Chat loop error          | `back-end/src/domains/agents/agentMessageService.ts` chat `.catch`      | `alertError({source:'chat'})`                        |
| SMS agent error          | `back-end/src/domains/sms-webhook/service.ts` `handleSupervisorFailure` | `alertError({source:'sms'})`                         |
| Backend crashing         | `back-end/src/server.ts` `uncaughtException`                            | `alertError({source:'backend_crash'})` (best-effort) |
| DB / backend fully dead  | external monitor → `GET /health/deep` (does `SELECT 1`, 503 on DB down) | Slack via monitor                                    |

Sub-agent failures are intentionally NOT alerted (parents recover them); a
sub-failure that breaks the whole run propagates to the root and alerts there.

## Files

- `back-end/src/providers/errorAlert.ts` — `alertError()` (Slack + optional RCA dispatch, throttled, never throws)
- `agents/helpers/error_alert.py` — `report_failure_activity` (mirror, httpx)
- `.github/workflows/auto-rca.yml` — dispatch target used when `AUTO_RCA_ENABLED=1`; runs `/rca`, opens draft PR
- `back-end/src/server.ts` — `/health/deep`, `uncaughtException` hook, wiring
- Wiring: `agentMessageService.ts`, `sms-webhook/service.ts`, `agent_workflow.py`, `worker.py`

## Env vars (unset transports degrade to logging, never crash callers)

- `SLACK_BOT_TOKEN` — preferred Slack transport; returns the message handle used
  for in-place RCA lifecycle updates
- `SLACK_ERROR_CHANNEL_ID` — Slack destination (`C0BE1B87882` in production)
- `SLACK_ERROR_WEBHOOK_URL` — optional post-only fallback when bot credentials
  are absent
- `AUTO_RCA_ENABLED` — `1` to launch RCA agents (default off)
- `GITHUB_DISPATCH_TOKEN` — PAT with `repo` scope to fire `repository_dispatch` (only needed when RCA on)
- `GITHUB_DISPATCH_REPO` — default `Rose-Ai-Labs/rose`
- `SLACK_SIGNING_SECRET` — verifies Slack Events API feedback callbacks
- `PUBLIC_FRONTEND_URL` — default `https://roselabs.ai` (for the agent deep-link)

## Human lifecycle

```text
failure
  → one Slack card + one draft PR
  → /RCA evidence → unchanged local repro → fix
  → automated /deploy offline + smoke gates
  → blocked (exact failed step) | ready for review
  → formal APPROVED review or maintainer `/deploy` PR comment on the exact verified HEAD
  → immediate merge → shipped
```

The Slack card always contains the affected user's name, current state, FE/PR/
Actions links, agent ID, the exact current or failed `/RCA`/`/deploy` phase, and
a human-readable elapsed-time waterfall. The same trusted waterfall is persisted
on the PR. Timeline records live in the workflow's root-owned gate directory;
investigator prose cannot forge them.

A reviewer can reply normally in the card's Slack thread or leave a normal
top-level PR comment. Signed Slack events are durably converted into PR comments
before the webhook returns success, and the exact human message receives an eyes
reaction once accepted. One agent-keyed workflow serializes revisions and scans
all unconsumed feedback comments, so comments arriving while work is active are
included in the next batch. The agent answers in the original Slack thread;
feedback is marked consumed only after trusted finalization and the thread reply.

Chat feedback never authorizes a merge. Automated `/deploy` work proceeds without
a chat approval pause. The exact ready PR HEAD can be approved either by a formal
GitHub APPROVED review or, for a one-engineer repository where the author cannot
review their own PR, an exact `/deploy` top-level PR comment from a maintainer.
Both paths satisfy deferred prompt or recovery-behavior gates and fail closed if
the HEAD changes.

## Verification (automated)

- `back-end/src/tests/unit/error-alert.test.ts` — cemented in `scripts/run-coverage.sh`
  (which `/deploy` runs). Covers: Slack post + payload, throttle/dedup,
  number-normalized signatures, no-webhook no-op, never-throws-on-fetch-reject,
  RCA dispatch when flag on, no dispatch when flag off.
- Python: `report_failure_activity` swallows all errors and is registered in
  `worker.py`; `agent_workflow.py` calls it only for root agents.
- `back-end/src/tests/blackbox/health.blackbox.ts` cements both deep-health
  branches: the live database returns 200/up, while an injected database failure
  returns a generic 503/down response without leaking the detailed error.

## Production setup

1. Set `SLACK_BOT_TOKEN`, `SLACK_ERROR_CHANNEL_ID`, `SLACK_SIGNING_SECRET`,
   `AUTO_RCA_ENABLED=1`, and `GITHUB_DISPATCH_TOKEN` on Render (backend); keep
   the alert-emitter values on Fly (agents).
2. Configure the Slack Events API callback as
   `https://navi-j9a9.onrender.com/api/webhooks/slack/auto-rca`, subscribe to
   human message events for the errors channel, and grant message-history plus
   `reactions:write`/`chat:write` scopes.
3. Point an external uptime monitor (BetterStack/UptimeRobot) at
   `https://navi-j9a9.onrender.com/health/deep` → alert `#errors` on non-200.
4. Store the Slack and dedicated RCA OAuth credentials as GitHub Actions
   secrets so the workflow can update the lifecycle card and run Claude Code.

## Where the RCA agent runs

**Two separate concerns — do not conflate them:**

1. **The coding harness** (Claude running `/rca` — read code, edit, open PR) runs
   in **GitHub Actions via `anthropics/claude-code-action@v1`** — the same harness
   `claude-code-review-fallback.yml` already uses. We do NOT build/host an agent
   harness; this is a solved, in-repo primitive.
2. **The full-resource reproduction** is a _backend the harness calls_, not a
   place the harness lives. `auto-rca.yml` sets `FLY_API_TOKEN`, so `/rca` can run
   **`scripts/run-bench <task>`** — the existing fleet clones a credentialed warm
   Fly box (Temporal Cloud + LLM/compute + full `run.sh` stack), runs a real agent
   repro, and tears down (rule-27-safe `cleanup()`/`reap_machine`). API/provider
   bugs reproduce faster as a backend blackbox. Either way the repro must fail
   before the fix and pass after, and be cemented.

Rejected: an on-box `CLOUDBENCH_MODE=rca` that installs the `claude`/`gh` CLIs on
the Fly box and opens the PR from it. That reinvents `claude-code-action` and is
risky (the fleet deliberately `unset`s the GitHub token so it can't leak into
spawned agents — reintroducing a live push credential in the agent stack env is
the exact footgun to avoid). The harness drives the fleet from the outside
instead.

## Follow-ups (deferred)

- Stuck-agent watchdog (`source:'agent_watchdog'`) — cron sweep for agents left
  non-terminal past a threshold (catches SIGKILL/OOM that can't self-report).
- Recurring-after-resolved re-alert once dedup graduates from in-memory to shared.
