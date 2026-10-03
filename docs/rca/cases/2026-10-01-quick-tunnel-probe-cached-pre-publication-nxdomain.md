---
id: 2026-10-01-quick-tunnel-probe-cached-pre-publication-nxdomain
date: 2026-10-01
title: The quick-tunnel edge probe resolved the new hostname before Cloudflare published it, so cached NXDOMAINs discarded healthy tunnels and the smoke certified a localtunnel origin browsers cannot pass
surface: harness
component: deploy-pipeline
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run.sh cloudflare_tunnel_edge_is_routing — resolved the freshly printed trycloudflare hostname through a caching resolver before the record existed, so the 60s negative-cache entry outlived the probe
symptoms:
  - "never routed within 10s; recycling the quick tunnel."
  - "has no DNS (NXDOMAIN); skipping remaining quick-tunnel attempts."
  - "rose-cloud-44cb5599-bench.ngrok.app' is already online. ERR_NGROK_334"
  - "Public tunnel smoke passed: https://upset-knives-drum.loca.lt"
  - "cloud browser stuck on the loca.lt Tunnel Password page; GET /test_payment → 511"
tags:
  - cloudflared
  - tunnel
  - dns
  - localtunnel
  - smoke-benchmark
  - deploy-gate
  - cloud-vm
sources:
  - PR #1341
  - agent fa6126ad-a099-45f4-ba27-a3927eeaf361
  - commit 006623782
  - commit 155b35a99
repro: scripts/tests/run-public-tunnel-routing.test.sh
status: fixed
---

## Problem

`/deploy`'s smoke gate failed all three AgentCard payment tasks on a Cursor Cloud
VM:

- `agent-payment-setup-resume` failed after 858s (agent `fa6126ad`).
- `agent-payment-abandonment` failed after 691s ("Expected validated payment-card
  request but none was observed").
- `agent-payment-new-user-journey` was still blocked at 19 minutes.

Each cloud browser was stuck on `https://upset-knives-drum.loca.lt/test_payment`.
localtunnel answers a browser User-Agent with a 511 "Tunnel Password" page that
asks for the tunnel host's public IP. The agents typed their own rotating egress
IPs into it until their task timeouts.

The smoke stack's `services.log` shows how it ended up on localtunnel:

1. The trycloudflare quick tunnel was declared dead ("never routed within 10s",
   then "has no DNS (NXDOMAIN); skipping remaining quick-tunnel attempts").
2. The ngrok fallback `rose-cloud-44cb5599-bench.ngrok.app` returned
   `ERR_NGROK_334`. The concurrent AgentCard lane had bound it after losing its own
   quick tunnel the same way at 19:46.
3. The worktree domain `rose-cloud-44cb5599.ngrok.app` also returned
   `ERR_NGROK_334`.

`scripts/test-public-tunnel.sh` then printed "Public tunnel smoke passed" for the
localtunnel origin, because curl's User-Agent is not gated.

## Diagnosis

Today's tunnel attempts on this VM, all pre-fix:

- Isolated stacks (10s probe, 1 attempt): 1 of 4 got a quick tunnel (stack
  `…-50640` did). The other three failed with the message above.
- The `/deploy` Step 5 stack ran at 20:10 under the default 45s / 3 attempts. It hit
  the same NXDOMAIN skip and served localtunnel.

Reproduction on the same VM:

- cloudflared prints the hostname about 3s after start, before Cloudflare publishes
  the record.
- Asked at that moment, the VPC resolver (`10.0.0.2`) answered NXDOMAIN for about
  60s, which is the `trycloudflare.com` SOA negative TTL. `dig @8.8.8.8` returned
  the record from +15s.
- A first lookup made about 10s after printing resolved immediately.
- 1.1.1.1 and dns.google poison the same way. In one trial, both kept serving
  NXDOMAIN for the full probe window with the Authority SOA TTL counting down
  (4s and 8s left), so the answer came from cache. Meanwhile 1.0.0.1 and
  cloudflare-dns.com returned the A records. No recursive resolver can safely be
  asked before publication.
- The edge routes by SNI at the zone's anycast addresses (the same addresses
  `api.trycloudflare.com` resolves to) regardless of DNS. A hostname with no live
  tunnel answers 530 there.
- Running the shipped pre-fix `start_cloudflare_quick_tunnel` on the VM with the
  isolated-run settings printed the smoke-log messages exactly: `rc=1 after 14s`.

The pre-fix probe's first `getent` call came within 1s of the hostname being
printed (cloudflared registered at 19:46:34; SIGTERM at 19:46:45), which is inside
the pre-publication window.

The DNS grace (15s) exceeded the isolated 10s deadline, so the loop never sent a
single HTTP request; "never routed" was a mislabel. Even under the default 45s
deadline, 15s of grace is shorter than the 60s cache entry.

There is no direct record of whether this specific hostname was public when it was
probed. The causal claim for the failing stack is therefore inferred from matching
timing and messages, reproduced on the same VM.

The deepest owned cause is that the readiness probe measured, and perturbed, a
different path than its consumer. It checked DNS that cloud browsers never use, at a
moment when the check itself creates the negative answer.

- `006623782` (2026-08-04) added the NXDOMAIN fast-fail, the attempt skip, and the
  localtunnel fallback. Its premise, "hostnames never enter public DNS", was this
  same artifact. The fallback it added has never been usable by cloud browsers.
- `155b35a99` then shortened the probe for isolated runs on the same premise.

A second readiness gap made the failure silent. The public smoke certified the
origin with curl's own User-Agent, although its only consumers are cloud browsers.

## Solution

`cloudflare_tunnel_edge_is_routing` no longer resolves a new trycloudflare hostname:

- It probes the Cloudflare edge pinned with `curl --resolve` to the addresses of
  `api.trycloudflare.com` (`cloudflare_quick_tunnel_edge_ipv4s`).
- It logs each result (`+Ns edge <ips>: HTTP <status>`).
- The NXDOMAIN fast-fail, the DNS grace, and the attempt skip are deleted; their
  only evidence was this artifact.
- DNS is first exercised by the public-tunnel smoke, after the frontend build.

`scripts/test-public-tunnel.sh` now requests `/test_payment` with a browser
User-Agent and requires the app shell (`<div id="root">`, the mount point in
`front-end/index.html`):

- A 511 browser gate fails immediately and says so.
- A 200 interstitial page fails as "not the app".

The localtunnel fallback is deleted. localtunnel always shows browsers its password
page, so under the browser-view smoke it could only fail, one to two minutes later,
after the frontend build. With it go its DNS helper, its process names in the
tunnel supervisor, and `.loca.lt` from the `?authRealm=` override allowlists in
`back-end/src/providers/authRealm.ts` and
`agents/domains/spawn_browser_agent_v3/service_crypto.py`. Anyone can mint a
`loca.lt` subdomain, so that entry let any such page claim a credential realm.

Blast radius: when no provider can serve cloud browsers, a stack now stops at
startup and names the providers it tried, instead of running on an origin that
fails every browser task at its timeout. That includes stacks that are not
isolated, such as `/deploy`'s Step 5 stack. On Cloud VMs a sibling can hold the
worktree ngrok domain, so those stacks depend on the quick tunnel routing. A
tunnel that routes but whose record never publishes now fails the smoke instead
of falling back.

Cemented in `scripts/tests/run-public-tunnel-routing.test.sh` (a deploy
structural gate):

- Case 12: a stateful resolver-cache stub fails the pre-fix `run.sh` at 12a for
  the causal reason, because its early lookup poisons the stub cache.
- Case 13: the smoke requests the page as a browser and rejects 511 and non-app
  pages. The pre-fix smoke fails 13a.
- Case 9b: a stack with no routable provider stops and names what it tried.
- The backend `browser-session-credential-injection` and agents
  `browser_credentials` blackbox suites assert a `loca.lt` page cannot override
  the realm.

On the VM, the fixed `start_cloudflare_quick_tunnel` with the isolated-run settings
routed in 8 of 8 trials spaced about 55s apart. Before the fix, 1 of 4 isolated
stacks routed that day.

- The pinned edge answered 530 until the tunnel route propagated, then routed at
  +4s (5 trials), +7s (2) and +10s (1) into the probe.
- In every trial the host resolver's first lookup, 20s after acceptance, resolved
  the hostname, and plain curl reached the origin.

Residual risks:

- The isolated runs' 10s probe deadline (`agents/benchmarks/local.py`) is marginal
  against that 4–10s edge-route latency. It was chosen on the debunked premise.
  Changing it needs explicit approval, so it is unchanged.
- Pinning to `api.trycloudflare.com`'s addresses assumes the whole zone shares one
  edge address set. If that stops holding, the pinned probe sees 530 and the stack
  falls back as before, and the RCA's symptom returns as a startup failure.
- The smoke's first lookup of the hostname happens after the frontend build only
  because of ordering in `run.sh`. Its 60 one-second retries are about one
  negative-cache TTL.
- The shared ngrok fallback domain is still a single endpoint per worktree, and
  Cloud VMs share the `.cloud-env` identity. See the recurrence note on
  `2026-07-27-parallel-deploy-lanes-race-one-free-ngrok-endpoint`.

On fixed HEAD `fcb24df39` (`/deploy` run `20261002-213707-2123940`), all three
payment tasks passed behind Cloudflare quick tunnels.

- Smoke passed `agent-payment-setup-resume` (117s) and
  `agent-payment-new-user-journey` (114s) via
  `atm-description-concrete-mtv.trycloudflare.com`.
- The AgentCard lifecycle lane passed `agent-payment-abandonment` (249s) via
  `discussions-perhaps-judy-blacks.trycloudflare.com`.

10k-agent behavior is unchanged. This runs once per isolated stack startup (one
lookup of a stable name and a few probes) and holds no shared state.

## Human feedback

None recorded.

## Reusable lesson

A readiness probe must measure the consumer's path without perturbing it: never
look up a freshly minted public hostname during startup (any caching resolver turns
an early miss into a 60s NXDOMAIN), and certify an origin with the client that will
use it.
