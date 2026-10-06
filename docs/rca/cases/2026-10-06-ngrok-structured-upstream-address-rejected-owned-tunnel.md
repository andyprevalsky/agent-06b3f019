---
id: 2026-10-06-ngrok-structured-upstream-address-rejected-owned-tunnel
date: 2026-10-06
title: run.sh rejected its own run-scoped ngrok tunnel because its checks expected fixture-shaped provider output
surface: harness
component: run-sh-public-tunnel
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/run.sh ngrok_reported_owned_origin required a string addr and supervised_edge_probe required HTTP 400 for ERR_NGROK_8012; ngrok 3.39.10 logs addr as a URL object and its edge answers 502"
symptoms:
  - "❌ ngrok emitted an endpoint that does not match this run's requested origin/upstream."
  - "❌ https://rose-<worktree>-bench-<run id>-bench.ngrok.app never routed."
  - "The endpoint 'https://rose-cloud-8693ac7d.ngrok.app' is already online"
  - "ERR_NGROK_334"
  - "❌ No public tunnel provider could serve"
tags:
  - ngrok
  - tunnel
  - predeploy-smoke
  - run-sh
sources:
  - PR #1416
  - commit b6f4e7ccc
repro: scripts/tests/run-public-tunnel-routing.test.sh
status: fixed
---

## Problem

During the PR #1416 `/deploy` Group 4 rerun, Pre-Deploy smoke and the
AgentCard lifecycle gate each started an isolated `run.sh --benchmark` stack
within one second of each other. In both stacks, cloudflared's quick tunnel
did not route within 10 seconds. Each stack then started its run-scoped ngrok
fallback, `rose-<worktree>-bench-<run id>-bench.ngrok.app`, and rejected it with
`ngrok emitted an endpoint that does not match this run's requested
origin/upstream`. Both stacks then fell back to the single per-worktree
reserved domain. AgentCard won it. The smoke stack failed with
`ERR_NGROK_334` (`endpoint ... is already online`) before running any task.
After the ownership check was fixed, the next smoke attempt accepted its
tunnel. It then reported `never routed` and lost the same race.

## Diagnosis

Main's `b6f4e7ccc` certifies a run-scoped ngrok fallback in two steps, and
each step expected a provider format that only the test fixture produced.

`ngrok_reported_owned_origin` requires exactly one `started tunnel` event
whose `url` is the requested domain and whose `addr` is the string
`http://localhost:<port>`. The smoke run's `ngrok-fallback.log` had one such
event with the requested URL. However, ngrok 3.39.10 serialized `addr` as a
Go `url.URL` object: `{"Scheme":"http","Host":"localhost:22421",...}`, with
every other field empty. A copy of the function run on that real log returned
status 2.

`ngrok_tunnel_edge_is_routing` accepts an `ERR_NGROK_8012` response only
when its HTTP status is 400. That response means the edge reached this agent
before the frontend listens. A live tunnel to a closed local port first
answered 404 `ERR_NGROK_3200` for about two seconds, then 502
`ERR_NGROK_8012`, with no `Server` header, on every request for 24 seconds.

`run-public-tunnel-routing.test.sh` passed only because its fake ngrok
emitted a string `addr` and its fake curl answered 400.

## Solution

`ngrok_reported_owned_origin` now accepts an `addr` in two forms. The string
form must still equal `http://localhost:<port>`. The structured form must
have scheme `http`, host `localhost:<port>`, and no other non-empty field.
The URL, event-count, `obj` and `name` checks are unchanged.

The ngrok edge probe accepts `ERR_NGROK_8012` on a 502 as well as a 400. The
header check is unchanged: the code must be present, and any `Server` header
must be `ngrok`. A 404 `ERR_NGROK_3200`, an unmarked 400 or 502, and a proxy
response are still rejected.

The fixture now models both real shapes:
- An owned event with a structured `addr` publishes. A foreign URL or wrong
  upstream in that form is rejected before publication.
- A 502 `ERR_NGROK_8012` proves routing, and an unmarked 502 does not.

Each new case failed on the unfixed script with the live message and passes
after its fix. Driving the real fallback with real ngrok and curl reproduced
`never routed` on the first fix alone. With both fixes it routed in two
seconds. The test stays in the Step 4s structural runner.

## Human feedback

None; this was found while rerunning the `/deploy` Test Loop for PR #1416.

## Reusable lesson

Build fixtures for third-party log events and edge responses from captured
real output; fakes written to match the parser hide format drift.
