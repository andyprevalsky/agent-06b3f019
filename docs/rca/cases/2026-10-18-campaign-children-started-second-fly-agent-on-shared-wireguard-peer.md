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
  - "❌ bench.log could not be read after 5 bounded retries -- infrastructure failure"
  - "Error contacting Fly.io API when probing \"personal\": timed out (context deadline exceeded)"
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
  - fleet run 20261023-060858-2779218 (descend-full69-20261023 recurrence on 8ada0056f; also 20261023-060858-2779216/-2779217, 20261023-060710-2729411/-2729441, K5 canary 20261023-063527-3731387)
  - fleet run 20261116-012637-640093 (2026-11-16 recurrence on 26714e91d0, standalone beside campaign-20261116-014819-911365; evidence on devbox 9b1d621b /home/boxes/rca-6c5f96b1/infra-noresult)
repro: python3 scripts/tests/cloudbench-shared-transport-integration.test.py CallerIntegration.test_second_campaign_in_one_home_refuses_a_second_agent_on_the_wireguard_peer
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

## Recurrence 2026-10-23 (descend-full69-20261023, K10)

Other symptom strings: `BILLING_STOP_REFUSED`, the orphaned default `flyctl agent run` daemon with repeated status-proxy lease rotation, and passed browser-auth copies retaining their Machines while several local campaigns ran at once.

Members: browser-auth-minted-email-otp (INFRA_ERROR "complete terminal runtime evidence could not be verified"), browser-auth-email-otp, browser-auth-passkey-preferred (Machine d8d0799f321508 left draining and retained), browser-auth-created-account-reused (x2), and K5's canary browser-auth-saved-password-retry and browser-doordash-food-plan-grocery-cart-reauth. Every task itself passed or was cut off; each lost its guest /shutdown or /runtime-evidence reply through the relay.

Evidence. The live guest d8d0799f321508 was inspected read-only. Its status server answered locally in 1 ms. The cleanup ack had existed since 06:30:53, and the controller's `/shutdown` request had landed (`cloudbench-shutdown-*.request` 06:33:48). The reply was lost on the controller side. The 060858 relay agent log (`~/.fly/agent-logs/2969209047.log`) shows that cleanup's CONNECTs to `[fdaa:...:846:712c:a8da:2]:8011` ending in `err context deadline exceeded` and `broken pipe`. Six agents were live in one HOME. Two were campaign relays started at 06:07:08 and 06:08:56. Two more relay agents started at 06:20:47 and 06:20:49, from K5's proof work. The default `~/.fly` agent, alive since 21:37, carried 43–59 connects/min from 06:21 to 06:33. Every establish reply names the same peer, `interactive-boxes-ed05f94c-…-01M5JRRKX43EPAJ0RXSRA99882`. In the 060710 relay, CONNECTs taking at least 0.9 s were a steady 24/min of about 235 (guest-boot polling) through 06:19. They rose to 61/161 at 06:20, then 60–90% of all CONNECTs (for example 289/346 at 06:21) until 06:38. Browser copies finished their drivers at 06:30–06:34 and all lost cleanup. The claude-code-agent copy finished at 06:35:55, after the default agent went idle (3 connects at 06:34, none 06:35–06:40), and cleaned up. Being a browser task is not the cause. Run 1 on cbbf3dd0c was clean because its shards ran on separate remote controllers, each with its own peer. The 8ada0056f code delta (T112/T114/K4/K7) is not involved.

Why the earlier fix did not hold: it guaranteed one agent per campaign, but the invariant that matters is one agent per HOME's `wire_guard_state` peer. Each local campaign still starts its own `FLY_AGENT_ISOLATED` agent. Two campaigns in one HOME (here, the descend parent's proofs alongside K5's) therefore recreate the same two-session conflict.

Repro (red on 8ada0056f, green on the fix): `python3 scripts/tests/cloudbench-shared-transport-integration.test.py CallerIntegration.test_second_campaign_in_one_home_refuses_a_second_agent_on_the_wireguard_peer`. It runs real `start_shared_relay` twice in one HOME against the v0.4.115-model fake flyctl. Pre-fix failure: `AssertionError: ValueError not raised` at `with self.assertRaisesRegex(ValueError,'WireGuard peer')`; the second campaign started a second agent.

Fix: `start_shared_relay` first takes `claim_home_wireguard_peer`, a non-blocking exclusive `flock` on `$HOME/.fly/rose-campaign-wireguard-peer.lock` that records its holder. A second campaign in the same HOME now refuses before it starts any agent or Machine. The refusal names the holder and points to a single or sharded campaign, and the campaign's startup failure line prints the reason. The lock descriptor is passed to the agent's bootstrap, so the claim ends with that agent, and a dead holder releases it. Fixture tests that start relays now use a private HOME. This is the guard rung: a per-campaign peer would require creating and deleting a Fly WireGuard peer per campaign. Moving all campaigns onto the default agent would change token and lifecycle ownership. Neither is verifiable offline.

Still open: (1) an ad-hoc `flyctl ssh`, or a concurrency-1 local run that uses the HOME default agent while a relay campaign runs, still opens a second session on the peer. Operational rule until fixed: run no other flyctl tunnel traffic in that HOME during a relay campaign. Prefer sharded campaigns, whose controllers each have their own peer. (2) For a natively stopped guest whose provider manifest was never sealed, `--recover-stale-owner` prints `stopped exact Machine has no sealed provider-state proof` instead of pointing at the documented original-volume capture procedure. Outcome proof is pending the parent's cloud rerun.

## Recurrence 2026-11-16 (standalone run beside a -k 4 campaign, open item 1)

Evidence (devbox 9b1d621b, `/home/boxes/rca-6c5f96b1/infra-noresult`). A standalone `scripts/run-bench browser-auth-email-otp --ref 26714e91d0 --durable` (run 20261116-012637-640093) started the HOME default agent (pid 769131, 01:36:47, `~/.fly/fly-agent.sock`). A `-k 4 --concurrency 4 --durable` campaign of the same task (campaign-20261116-014819-911365) then started its private relay agent (pid 915279, 01:48:38). Both agents' establish replies named the same peer, `interactive-boxes-ed05f94c-…-01M7GZZTQ2F9ZJ7S22D92C9ANB`, with the same public key. At 01:56:06.8 both degraded in the same second (`Error contacting Fly.io API … timed out (context deadline exceeded)` / `context deadline exceeded`). About 6% of connections to all 4 guests then failed, evenly spread. All 5 guests printed "passed", but every run ended REAL NORESULT / INFRA_ERROR: sealed runtime-evidence read `TimeoutError`, guest shutdown got no HTTP answer, and `bench.log could not be read after 5 bounded retries`. 4 owners were retained.

Archive searches: `bench.log could not be read after 5 bounded retries default fly agent wireguard peer` and `standalone run default agent fly-agent.sock campaign second agent context deadline exceeded`. Both rank this case first. `2026-10-20-preterminal-infra-failure-waited-runtime-evidence-backstop` shares the bench.log symptom but sits at a different boundary (post-loop evidence wait). This is a recurrence of open item (1): the guardrail failed because only one side of the conflict was guarded.

First bad boundary: `run-bench-campaign.py claim_home_wireguard_peer` excluded only another campaign. A standalone `run-bench-fleet` controller took no claim, and the campaign never looked at `~/.fly/fly-agent.sock`, so it started a second agent on the HOME peer beside a live default agent. The reverse order was equally unguarded. Why 1: tunnels on the peer lost packets. Why 2: two agents held sessions on one peer. Why 3: the peer invariant (one live agent per HOME) was enforced between campaigns only, and a standalone run's default agent was invisible to it. Why 4 is flyctl's single-peer-per-HOME design (third party), so the ladder stops at Why 3.

Fix: one lock, both modes. A standalone (relay-unbound) `run-bench-fleet` controller now holds `~/.fly/rose-campaign-wireguard-peer.lock` with `LOCK_SH` for its lifetime (`claim_home_wireguard_peer_shared`, called right after Fly token resolution and before any WireGuard flyctl call). A campaign still takes `LOCK_EX`. Standalone runs share with each other, while a standalone run and a relay campaign refuse in either order:
- A standalone run beside a campaign exits 1. The message names the campaign holder (`pid=… campaign=…`).
- A campaign beside a standalone run raises before starting any agent. When the exclusive lock fails but a shared lock succeeds, the holders are standalone runs or agents they started. Their PIDs and command lines are found from `/proc/*/fd` and named in the message.
- A campaign that wins the lock still sends a v0.4.115 PING to `~/.fly/fly-agent.sock`. If a default agent answers, or something accepts the connection but does not answer, the campaign refuses. The message names the socket and agent PID and gives the action: stop it with `flyctl agent stop` once no standalone run or ad-hoc tunnel uses the HOME. A missing or stale socket (connection refused) passes.

Relay-bound campaign children are covered by the parent's exclusive claim and skip the shared claim. A width-1 campaign without a relay, or a campaign with `CLOUDBENCH_CAMPAIGN_SHARED_RELAY=0`, starts no private agent. Its unbound children each take the shared claim like standalone runs. No healthy work is serialized: a refusal fails immediately and never waits, and standalone runs still run together. Benchmark tasks, timeouts and concurrency are unchanged. 10k-agent behavior: one flock and one Unix-socket PING per campaign start; the `/proc` scan runs only on refusal.

Repro: `python3 scripts/tests/cloudbench-shared-transport-integration.test.py CallerIntegration.test_second_campaign_in_one_home_refuses_a_second_agent_on_the_wireguard_peer`, extended to cover both orders. Order 1 holds the standalone claim and starts the fake HOME default agent, then a campaign must refuse; with the controller gone but its agent still answering, the campaign must still refuse; after the agent dies (stale socket), the campaign starts. Order 2 starts a campaign first; a second campaign and a standalone run must both refuse, and the standalone must make no WireGuard call and start no agent. The negative control runs two standalone runs together and expects them to share one agent. On origin/main c678865ab9 it fails: the standalone claim does not exist (`ValueError: substring not found` extracting `claim_home_wireguard_peer_shared`). With only the fleet half applied, a campaign still starts beside a live default agent (`AssertionError: ValueError not raised` at the `fly-agent.sock` refusal). With the fix it passes: 6 consecutive runs of the single test, then the full 21-test file.

Still open: (1) ad-hoc `flyctl ssh`/`proxy` outside run-bench, and `run-bench-fleet` recovery-only maintenance (`--recover-stale-owner` and similar), take no claim. They are operator maintenance that must stay able to release retained Machines. A campaign still refuses on their lingering default agent through the PING check, but such a call started during a campaign is unguarded. (2) Item (2) from the 10-23 section is unchanged.

## Human feedback

The coordinator assigned the binding edit to this RCA and asked for an evidence-based decision on caf73e6de. It also asked that the change stay scoped to the relay binding and its env export. No user feedback recorded.

## Reusable lesson

One HOME has one Fly WireGuard peer: allow exactly one live agent on it, which means children reuse the campaign's agent and a second campaign in the same HOME must refuse, because any second agent session silently degrades every tunnel on that peer.
