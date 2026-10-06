---
id: 2026-10-06-ngrok-structured-upstream-address-rejected-owned-tunnel
date: 2026-10-06
title: ngrok's structured upstream address made run.sh reject its own run-scoped tunnel
surface: harness
component: run-sh-public-tunnel
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/run.sh ngrok_reported_owned_origin compared the started-tunnel addr with the string http://localhost:<port>; ngrok 3.39.10 logs it as a serialized URL object"
symptoms:
  - "❌ ngrok emitted an endpoint that does not match this run's requested origin/upstream."
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

## Diagnosis

Main's `b6f4e7ccc` added `ngrok_reported_owned_origin`. It requires exactly one
`started tunnel` event whose `url` is the requested domain and whose `addr` is
the string `http://localhost:<port>`. The smoke run's own
`ngrok-fallback.log` had one such event, with the requested URL. However,
ngrok 3.39.10 serialized `addr` as a Go `url.URL` object:
`{"Scheme":"http","Host":"localhost:22421",...}`, with every other field empty.
The string comparison therefore rejected the run's own tunnel as foreign.
`run-public-tunnel-routing.test.sh` passed only because its fake ngrok
emitted the string form. A copy of the function given the real log returned
status 2 before the fix.

## Solution

`ngrok_reported_owned_origin` now accepts an `addr` in two forms. The string
form must still equal `http://localhost:<port>`. The structured form must
have scheme `http`, host `localhost:<port>`, and no other non-empty field.
The URL, event-count, `obj` and `name` checks are unchanged.

The routing test's fake ngrok can now emit the structured form. An owned
structured event publishes. A foreign URL or wrong upstream in that form is
rejected before publication. The new case failed on the unfixed script with
the live message and passes after the fix. On the real smoke log, the fixed
function accepts the requested origin, and rejects a wrong port or a foreign
URL. The test stays in the Step 4s structural runner.

## Human feedback

None; this was found while rerunning the `/deploy` Test Loop for PR #1416.

## Reusable lesson

When validating a third-party agent's log events, build the test fixture from
a captured real event; a fake written to match the parser hides format drift.
