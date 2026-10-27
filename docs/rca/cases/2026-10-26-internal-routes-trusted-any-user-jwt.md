---
id: 2026-10-26-internal-routes-trusted-any-user-jwt
date: 2026-10-26
title: Worker-only routes accepted any user JWT, so a signed-in user could mint a sandbox holding BACKEND_API_KEY and text, call or act as any user
surface: back-end
component: auth-route-guards
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/auth.ts authenticate — admits the internal API key OR any Supabase JWT; internal-only routes relied on it alone with no req.isInternal check
symptoms:
  - POST /api/codex-code-session/create with a user JWT and harness_mode rose returns 200 with ws_url
  - user JWT reaches /api/send-sms, /api/vapi/call, /api/fast-cache/set, /api/archive/artifact
  - Internal callers only
  - POST /anthropic-proxy/<goal hash>/v1/messages with no credentials reaches the tee-proxy
  - Invalid Fast Mode proxy capability
tags:
  - security
  - auth
  - identity-binding
  - internal-only
  - scale-100-seats
sources:
  - task S1 route identity (100-seat readiness audit 2026-10-24)
  - commit b3679ea7b (reproduced on origin/main)
  - PR #1576
  - task S8 remaining route auth gaps (reproduced on origin/main 7c173ec12)
repro: back-end/src/tests/blackbox/route-identity.blackbox.ts
status: fixed
---

## Problem

The 100-seat readiness audit found routes documented as internal / API-key-only
that ordinary users could reach. Re-verified on origin/main `b3679ea7b` with the
new blackbox `route-identity` (a JWT minted for a fresh, unrelated user):

- `POST /api/codex-code-session/create` with `harness_mode: "rose"`,
  `rose_api_base_url: https://attacker.example.invalid` and a victim
  `user_id` returned **200** and a real E2B sandbox (`iqueybx63oyvazvoczke6`,
  killed immediately). `providers/e2b.ts` puts `ROSE_API_KEY=BACKEND_API_KEY`
  and the caller's URL in that sandbox's env. The caller writes the sandbox's
  goal, and hybridAuth trusts `X-User-Id` with that key. So any signed-in user,
  including about 9.3k anonymous prod sign-ups, could take the god key and
  impersonate every user.
- 27 worker-only routes returned 200/400/500 instead of 403 to that JWT. They
  include SMS to any number or `user_id`, Vapi calls with any system prompt,
  global DEMO cache get/set/purge, archive artifact writes, tool-usage cost
  writes, code-session create/close/output/health, browser-session
  close/files/CDP URLs/localStorage injection, and the external HTTP proxy.
- `GET /api/{claude,codex}-code-session/:taskId` and `/agent/:agentId` returned
  another user's session goal and output. `POST /api/archive/agent-start` and
  `/agent-finalize` accepted another user's agent.

## Diagnosis

Critical path: client → `authenticate` → route handler → service (E2B /
Surge / Vapi / R2 / Prisma).

`authenticate` (providers/auth.ts) is deliberately dual-mode. With the
internal API key it sets `req.isInternal = true` and no `req.user`. With any
valid Supabase JWT it sets `req.user` and `req.isInternal = false`. Nothing in
the route API distinguished "any authenticated caller" from "internal only".
Each route had to remember an inline `if (req.isInternal !== true) 403`. Newer
routes (keepalive, resize, usage-limit) did. Older routes were mounted with bare
`authenticate`, and their "Auth: API Key (internal)" doc comments were never
enforced. The code-session routes also took `user_id` from the body. So the
first bad boundary is the route's middleware chain: it admitted a JWT caller
into a handler written for trusted callers. The deepest owned cause is that no
named guard or structural check existed for the internal-only class. The
machine-upload class has both (`authenticateMachineUpload` and
`machine-upload-containment.test.ts`).

Archive searches ("internal only route authenticate isInternal user JWT",
"BACKEND_API_KEY sandbox leak impersonate user_id body") found no prior case.
The nearest relative is the machine-upload impersonation containment.

## Solution

- `providers/auth.ts`: `requireInternal` plus `authenticateInternal`
  (`[authenticate, requireInternal]`), returning 403 `Internal callers only`.
- Applied to every worker-only route found by a full route sweep, in nine
  route files. Every caller of these routes is an agent worker using the API
  key. The only caller of the Codex rose harness, `codex_runner.py`, posts to
  the unmounted `/api/codex-session`. So `harness_mode: rose`, and the
  `BACKEND_API_KEY` it injects, is now reachable only by callers who already
  hold that key.
- `providers/agentAccess.ts`: `callerCanAccessAgent` /
  `callerCanAccessCodeTask` scope the user-readable code-session GETs (404) and
  archive start/finalize (403) to the agent's owner. Internal callers are
  unaffected.
- `tests/structural/internal-route-guard.test.ts` (in `test:structural`):
  - Pins the internal route list.
  - Fails on any route documented as internal/worker-only that is guarded only
    by `authenticate`, with no `req.isInternal` check.
- `tests/blackbox/route-identity.blackbox.ts` proves over HTTP:
  - a user JWT gets 403 on every internal route, and the API key is still
    admitted;
  - the rose harness is refused for a user JWT;
  - code-session GETs are owner-scoped;
  - archive start/finalize refuse another user's agent.

Scale at 10k agents: the guard is a constant-time flag check with no I/O. An
owner check is one or two primary-key reads (`Agent.id`, `ClaudeCodeSession.id`)
on user-JWT reads only. Internal worker traffic, which is all agent-driven
traffic, does no extra queries. There is no shared state, lock or fan-in.

### Follow-up: S8 remaining gaps (2026-10-26)

Reproduced on origin/main `7c173ec12` with the extended `route-identity`
blackbox and `internal-route-guard` structural test.

- `/anthropic-proxy` and `/codex-proxy` are mounted with no middleware. The
  trace segment is a 16-hex hash derived from the goal, so it is guessable for
  any known (for example benchmark) goal. An unauthenticated request with that
  hash reached the tee-proxy, which forwards upstream and reads or writes that
  trace's DEMO cache entries; the observed response was Anthropic's own 401,
  not ours. Production sets `FAST_MODE_ANTHROPIC_PROXY_URL`.
  Fix: the proxy URL is the sandbox CLI's only credential, so the backend now
  appends an HMAC capability (`<segment>,<32 hex>`, keyed by
  `BACKEND_API_KEY` with its own context string) where it mints the URL
  (`codeAgentFastModeEnv.ts`). Both routers verify it in constant time before any
  trace route (403 `Invalid Fast Mode proxy capability`) and parse only the
  verified segment. The URL is no longer logged.
- `/api/world-models/*`, the WMH simulation shim, admitted any user JWT and
  let it step any session id. It has no product callers, so it is now
  internal-only.
- Re-audited and already correct: `/api/blueprints/*` (identity bound to the
  user unless internal; delete and feedback scoped by id and user) and the
  browser-session `/task/*`, `/context/:userId`, `/init` and `prepare-auth`
  routes (owner checks in the route or service).
- `agents/benchmarks/codex_runner.py` posted to the unmounted
  `/api/codex-session` with the run's (possibly user-JWT) headers, so the Codex
  harness benchmark could never create a session. It now uses
  `/api/codex-code-session` with internal API-key headers
  (`_internal_api_headers`). Regression:
  `test_codex_runner_creates_session_on_mounted_internal_route` in
  `agents/tests/blackbox/benchmark.blackbox.py` asserts the path is mounted in
  `server.ts` and that create carries the API key, not a JWT.

Scale at 10k agents: one HMAC per proxy request (microseconds, no I/O, no
shared state). Minting happens once per sandbox spawn.

## Human feedback

Andy (via parent, S8): do not spend effort on breach or exposure forensics; contain and fix only.

## Reusable lesson

A dual-mode auth middleware must never be the sole guard of a trusted-caller
route. Express "internal only" as a named middleware and make a structural test
enforce it wherever the docs say so.
