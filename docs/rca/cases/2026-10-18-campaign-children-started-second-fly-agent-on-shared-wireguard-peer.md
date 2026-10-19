---
id: 2026-10-18-campaign-children-started-second-fly-agent-on-shared-wireguard-peer
date: 2026-10-18
title: Campaign children started a second Fly agent on the relay's WireGuard peer and stalled guest collection
surface: infra
component: run-bench-campaign
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-campaign.py bind_shared_relay gave children the relay route keys but not the relay's agent socket, so the autoscaler's fly_with_timeout ssh console/sftp calls resolved ~/.fly/fly-agent.sock and started a second agent on the same single wire_guard_state peer
symptoms:
  - "❌ complete terminal runtime evidence could not be verified -- infrastructure failure"
  - "❌ guest cleanup request failed (HTTP 000)"
  - "err context deadline exceeded"
  - "failed writing: write unix /tmp/cb-relay-*/fly-agent.sock->@: write: broken pipe"
  - orphaned default `flyctl agent run` daemon and repeated status-proxy lease rotation
tags:
  - cloudbench
  - shared-relay
  - fly-agent
  - wireguard
  - collection
  - autoscaler
sources:
  - fleet run original600-1792308435478660056 (100-copy sharded diagnostic, source 373585f80c006fc53412c8f9ccc0c7335e32f32a)
  - commit caf73e6de28e36e97cd226662dcff974f7648871 (reverted)
repro: python3 scripts/tests/cloudbench-shared-transport-integration.test.py CallerIntegration.test_campaign_child_wireguard_flyctl_reuses_the_relay_agent
status: open
---

## Problem

Evidence: copies r001-j0005, r001-j0029 (shard-00), r001-j0003 (shard-02), r001-j0052 and r001-j0068 (shard-03), plus each controller's `/home/rose/.fly/agent-logs/*.log` (Machines 80e334c6d32dd8, 8655526f9741d8, 8111699a5d2d98, 84ee290f49d6d8). The other symptom strings were `TimeoutError: timed out`, `guest-shutdown.confirmed: No such file or directory`, `Original exit code: 125` and `Error: tunnel unavailable: Error contacting Fly.io API when probing "personal": timed out (context deadline exceeded)`.

The 100-copy sharded diagnostic ran 4 disposable controllers with 25 copies each. Five finished copies (j0005, j0029, j0003, j0052, j0068) on 3 controllers failed post-execution collection after the guest printed "driver exited rc=…; holding for controller collection". `cloudbench_collect_runtime_evidence` raised `TimeoutError` (urllib's 6 s socket budget). In j0005 this happened mid-file `response.read`; in j0003 it happened at the final manifest `getresponse`. The single `curl --max-time 3` POST `/shutdown` then returned HTTP 000. Without `guest-shutdown.confirmed`, the runner exited 125, the guest was natively stopped and its resources were retained. j0029 had a genuine FAILED verdict after 977 s. About 51 other copies collected and cleaned up normally.

## Diagnosis

Critical path: run-bench-cloud request → 127.0.0.1 relay lease (cloudbench-shared-relay.py) → relay agent `connect` over the private `fly-agent.sock` → WireGuard tunnel → guest status server :8011.

1. **The relay route, not the guest, degraded.** The relay agent logs every CONNECT. Before onset, p95 CONNECT latency was 0.01 s at up to about 2,500 connects/min. After onset, about 25% of connects per minute took 1/3/7 s (the TCP SYN retransmit schedule), some failed with `err context deadline exceeded`, and some replies hit `broken pipe` after the relay's 10 s dial timeout. Throughput fell to roughly 300–900/min, so load was not the cause.
2. **The onset is the start of a second agent, to the second, on every controller.** The default `flyctl agent run` started at shard-03 07:49:11, shard-00 07:54:49, shard-02 07:57:51 and shard-01 08:11:24. Each start equals the first timestamp of that shard's autoscaler `worker-<id>.stage.log`. That staging and the `worker_operational` health probe call `fly_with_timeout 20 ssh console/sftp` with no `FLY_AGENT_SOCKET_PATH`.
3. **Both agents use the same peer.** `~/.fly/config.yml` has one `wire_guard_state.personal` entry (`interactive-80e334c6d32dd8-…`). The relay agent's establish replies and the default agent's establish replies both name that peer. Both are v0.4.115 background agents.
4. **Degradation tracks the second agent's tunnel traffic.** Relay slowness appears in the minutes when the default agent serves connect/establish requests. It clears about a minute after that agent goes idle, even though the agent stays alive (shard-02 08:08–08:15, shard-03 08:07–08:15). The worker stage logs show the default tunnel failing too (`FLY_COMPLETION_TIMEOUT`, `tunnel unavailable`).
5. **Why about 51 succeeded.** Every copy collected before its own shard's onset had exactly one status lease and succeeded. After the onset, `ensure_status_proxy` rotated leases 4–23 times per copy, because each 3 s health probe miss re-leases the route. All five failures fall after their shard's onset. The few post-onset successes got through intermittent loss. Shard-01's onset (08:11:24) came after its last normal collection, so it had no Cluster A failure. Long-running copies failed only because they finished after onset. Neither the route nor the status server has a time-bound lifetime.

Step 5a ladder:
- **Why 1:** collection requests timed out because the relay agent's tunnel lost packets.
- **Why 2:** a second agent was carrying traffic on the same WireGuard peer.
- **Why 3:** campaign children never received the campaign agent's socket, so every WireGuard-dependent flyctl call in a child (autoscaler staging, worker health and the legacy ssh paths) used the HOME default socket and started a daemon there.
- **Why 4** would be flyctl's per-HOME single-peer design, which is third-party. Stop at Why 3.

The same gap also explains the orphaned default agents that kept every controller export pending: siblings `2026-10-18-closed-fleet-left-default-fly-agent-writer` and `2026-10-18-parent-canary-omitted-shared-relay-environment`.

The local reproduction runs real `start_shared_relay` and `bind_shared_relay`, then the production `worker_operational` → `fly_with_timeout` → `FLY` path, against a fake flyctl that implements v0.4.115 agent resolution. That resolution is: use `FLY_AGENT_ISOLATED` for a private agent, else `FLY_AGENT_SOCKET_PATH`, else `~/.fly/fly-agent.sock`, and start a background agent where no agent answers PING. On the buggy source it fails with `a campaign child started a second Fly agent: {... 'agent_socket': '…/home/.fly/fly-agent.sock', 'started_agent': True}`.

The orphaned `flyctl ssh console`/`sftp put` children on shard-03 were stuck on the degraded default tunnel. They catch SIGTERM (Go runtime SigCgt). `fly_with_timeout` stops escalating to SIGKILL once its subshell exits, so they were reparented to PID 1. That reaping defect is separate and remains open. It did not cause the collection failures, which use the relay.

## Prior archive search

Searched `flyctl agent wireguard peer default agent shared relay tunnel` and `guest cleanup request failed HTTP 000 complete terminal runtime evidence could not be verified TimeoutError`. Relatives: `2026-10-18-parent-canary-omitted-shared-relay-environment` (same binding-boundary class; it explicitly left SSH/SFTP default-agent starts open) and `2026-10-18-closed-fleet-left-default-fly-agent-writer` (it treated the orphaned default agent as an export writer without identifying its originating call or its transport effect). `2026-10-12-group-term-killed-guest-shutdown-proxy-before-delivery` has the same symptoms but a different boundary. This case identifies the missing default-agent source, so it is a relative, not a recurrence of a fixed case.

## Solution

`start_shared_relay` now exports the relay's own `FLY_AGENT_SOCKET_PATH` in the consumer environment. `bind_shared_relay`, the single binding used for both the parent canary and worker dispatch, removes any inherited `FLY_AGENT_ISOLATED` before applying it. Every child flyctl ssh/sftp call then reuses the one campaign agent and tunnel, and no second agent starts on the peer. Standalone (relay-less) runs keep the operator's agent selection.

Commit caf73e6de pre-started the default agent from `/` before the campaign. It is reverted on this branch: with the binding, no shared-relay controller path needs a default agent, and a pre-started one would only be a second agent on the same peer, waiting for an unbound caller to re-create the conflict silently.

10k-agent behavior: this adds no process, socket or route. Each controller has one agent and one tunnel instead of two contending ones. Per-route cost is unchanged.

Simplification: this removes a second agent per controller and needs no new transport retry or timeout. Raising the 3 s/6 s budgets or retrying POST `/shutdown` would only mask the packet loss.

## Verification and limits

Pre-fix, the command in `repro` fails with the assertion above. Post-fix, the identical command passes. The full owning file (13 tests) passed 5 consecutive times with unchanged test code. `cloudbench-cleanup-ticket-campaign.test.py` (18), `cloudbench-campaign-env.test.py` (10) and `cloudbench-original600-supervisor.test.py` (16, after the revert) pass. The suite is registered as "Cloud Benchmark Shared Relay" in `scripts/test.sh` and change-selected for `scripts/run-bench-campaign.py`.

Limits: the gateway's handling of two concurrent sessions on one peer was inferred from native agent logs (same peer, onset to the second on 4/4 controllers, idle recovery). It cannot be reproduced offline; the local test proves the owned boundary only. Outcome proof is pending a sharded cloud rerun showing a single agent per controller, one status lease per copy and zero collection failures. Separately, the single-attempt 3 s `/shutdown` request and the `fly_with_timeout` SIGKILL escalation remain unchanged. The adversarial sub-agent review (Step 7) was not run because the RCA agent had no sub-agent tool; it is delegated to the parent.

## Human feedback

The coordinator assigned the binding edit to this RCA and asked for an evidence-based decision on caf73e6de. It also asked that the change stay scoped to the relay binding and its env export. No user feedback recorded.

## Reusable lesson

When one shared Fly agent owns a campaign's tunnel, hand its socket to every child, because any flyctl ssh/sftp call that resolves a different agent starts a second WireGuard session on the same peer and silently degrades the shared tunnel.
