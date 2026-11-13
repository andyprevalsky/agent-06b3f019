---
id: 2026-11-13-width-one-deploy-campaign-ran-without-owned-fly-agent
date: 2026-11-13
title: A width-1 deploy smoke campaign (the single same-source rerun) ran without the campaign-owned Fly relay, so the per-HOME flyctl agent it started outlived it and voided the whole smoke gate
surface: harness
component: deploy-test-cloud
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py main() started the owned shared inventory + shared relay (the campaign's private, joined flyctl agent) only when --concurrency > 1, so a width-1 campaign's lone fleet controller ran flyctl against the unowned per-HOME `flyctl agent` daemon, which flyctl auto-starts detached and which outlives the campaign
symptoms:
  - "rerun.reason \"cloud command interrupted or source changed\""
  - "smoke receipt complete=false lingering_group=true reason \"worker result identity/inventory mismatch\""
  - "all smoke occurrences UNVERIFIED although every other task passed; triage refused waivers, reexecute refused (retained_owners==['smoke'])"
  - "rerun/cli.log.process.json: native_exit 1, orphaned_children true, term_sent [<one pid>], kill_sent [], quiescent true"
  - "first attempt cli.log.process.json: orphaned_children false (width > 1)"
tags:
  - smoke
  - rerun
  - flyctl-agent
  - supervisor
  - orphaned-children
  - shared-relay
sources:
  - PR #1981 deploy rounds 9 (af23ea2bc2) and 13 (9a0bac6eb4bf)
  - PR #1926 deploy 2026-11-11 (passing rerun voided the same way)
  - commit e5782cf49 (earlier fix of the rerun Hub join; not this cause)
repro: scripts/tests/deploy-cloud-smoke-speed.test.py SingleWidthRerunOwnsFlyTransport (drives the real deploy_test_cloud.execute() through a native FAIL and its width-1 rerun, then feeds the rerun's exact env and width to the real run-bench-campaign.py main(); red pre-fix "[] != ['inventory', 'relay']" and the conflated reason, green 5/5 after; registered in the deploy-cloud-smoke-speed structural gate). Live repro of the leak: `HOME=<tmp> FLY_API_TOKEN=… python3 scripts/deploy_test_supervisor.py --receipt r.json -- flyctl agent start` gives orphaned_children true, term_sent [agent pid], agent exit 0 — the PR #1981 rerun signature.
status: fixed
---

## Problem

In PR #1981's deploy (rounds 9 and 13), `agent-payment-idempotent-abandonment` failed natively and its one same-source rerun also failed
natively. The rerun was a clean native FAIL (source unchanged, teardown complete), but `deploy_test_cloud.launch()` recorded it as
`cloud command interrupted or source changed`. The adapter result became `cleanup_complete=false`, the cycle's `validate()` rejected it
("worker result identity/inventory mismatch"), the receipt got `lingering_group=true` plus a cleanup owner, and all 11 smoke occurrences
became UNVERIFIED although 10 passed. Triage could not waive and `reexecute` refused (`retained_owners==['smoke']`), so the gate was void.
PR #1926 (2026-11-11) hit the same signature with a rerun that passed natively.

## Diagnosis

1. The rerun's supervisor receipts (`rerun/cli.log.process.json`, both rounds) show `native_exit 1`, `orphaned_children true`,
   `term_sent [1620520]` / `[1845916]`, `kill_sent []`, `quiescent true`. The first attempts' receipts show `orphaned_children false`.
   So `lingering` (not timeout, cancellation or source) produced the reason; `launch()` folded all four causes into one message.
2. The orphan is the per-HOME flyctl agent, not the Hub. The rerun Hub owner `.owner.terminal` reads
   `disposition=terminated-verified` at 05:52:36 (joined by `join_native_hubs`, fixed in e5782cf49). On the originating box,
   `~/.fly/agent-logs/137310301.log` reads `05:18:54 srv OK 1845916` and `05:52:37 srv shutting down ... QUIT`: PID 1845916, the r13
   orphan, is the default `flyctl agent` daemon, started about 2.5 min into the rerun and stopped by the supervisor's TERM.
   `238182788.log` reads `05:18:55 srv another instance of the agent is already running`, the concurrent second start, matching reaped
   PID 1845939 (exit 1). The r9 orphan (PID 1620520) has the same receipt signature; its agent log had already rotated, so its identity
   is inferred, not read.
3. `run-bench-campaign.py` starts the shared inventory and, on Linux, the shared relay only when `args.concurrency > 1` (gate from
   807edee9f, when only the inventory existed; the relay and its private `FLY_AGENT_ISOLATED` agent were later added under the same gate).
   The rerun runs only the failed task, so `campaign_width` is 1 and the campaign has no owned relay.
4. Without the relay env, the controller's `flyctl proxy`/`ssh` uses the default per-HOME agent; flyctl starts it detached
   (`flyctl agent run`) and it intentionally outlives the caller. Under the owned supervisor (a subreaper) it is reparented and still alive
   after the native exit, so it is an orphan. Reproduced locally with the real supervisor: `flyctl agent start` in an isolated HOME gives
   `orphaned_children true`, `term_sent [agent]`, agent exit status 0 — the exact rerun signature.
5. The leak needs no default agent already running in HOME. When one is already up (started outside the supervisor), the rerun just
   uses it and nothing is orphaned, which is why the failure was frequent but not universal.
6. With the fix, a real width-1 `chat-mode` campaign through `deploy_test_cloud.launch()` with the rerun layout ran under the owned
   supervisor (2026-11-13 10:57Z, request `.context/deploy-cloud/7816188164…`). It printed `Campaign inventory`, started the shared relay, and
   its only flyctl agent was the relay's private one (`FLY_AGENT_SOCKET_PATH=/tmp/cb-relay-uzb26fsk/fly-agent.sock`, PID 40898).
   `rerun/cli.log.process.json` shows `native_exit 0`, `orphaned_children false`, `term_sent []`, and the private agent reaped with exit
   status 0 inside the run. The campaign passed. The adapter correctly reported `cloud command ran while the source changed`, because
   this case file was written into the worktree during that run.

Deepest owned cause: the campaign's ownership of its Fly transport depended on width, not on whether the caller requires owned lifecycle.
Any width-1 deploy campaign (the rerun, or a first attempt admitted at width 1 by provider headroom) was exposed.

## Solution

- `deploy_test_cloud.launch()` sets `CLOUDBENCH_CAMPAIGN_OWNED_TRANSPORT=1` for every attempt; `run-bench-campaign.py` starts the owned
  inventory + relay when `concurrency > 1` **or** that flag is set. Non-deploy width-1 campaigns keep their previous behavior.
- `launch()` reports the exact cause (`timed out`, `was cancelled`, `left a lingering process (see cli.log.process.json)`,
  `ran while the source changed`) instead of one conflated string. A genuine interruption, lingering process or source change still yields
  UNVERIFIED and incomplete; a native FAIL stays FAIL; the rerun-once rule (FLAKY on pass, else FAIL) is unchanged.
- The supervisor's orphan detection is unchanged: the fix removes the leak at its producer instead of weakening the detector.
- Remaining risks:
  - A width-1 deploy campaign now has the same startup dependencies as a wide one: the HOME WireGuard peer lock, the relay
    bootstrap and the inventory publisher. If any of them fails, `cleanup_complete` is false and the gate stays UNVERIFIED, as it already
    does at width > 1.
  - An inherited `CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=0` or `CLOUDBENCH_CAMPAIGN_SHARED_RELAY=0` still disables the owned transport.
  - Non-deploy width-1 campaigns still use the HOME agent. This is opt-in to keep the blast radius at deploy.
- Observability gap: the supervisor receipt records an orphan's PID but not its command. `deploy_test_supervisor.py` is hash-pinned by
  `cloudbench-prestart-recovery.py`, and `deploy_test_backend_post_cleanup.py` pins the receipt key set, so the identity came from the
  flyctl agent logs. Read `~/.fly/agent-logs/*` (`srv OK <pid>`) when a cloud receipt shows an orphan.
- 10k-agent behavior: unaffected (deploy-only local process ownership; one relay and one private agent per campaign, as at width > 1).

## Human feedback

None recorded.

## Reusable lesson

When an owned supervisor reports an orphan that exits cleanly on TERM, find which detached daemon the producer started outside its owned lifecycle and make the producer own it at every width, rather than relaxing the orphan detector.
