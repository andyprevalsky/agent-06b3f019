---
id: 2026-10-15-people-credentials-coupled-to-local-backend
date: 2026-10-15
title: People credential authority was coupled to the isolated application backend
surface: agents
component: people-search
classification: our-bug
problem_class: other
first_bad_boundary: The worker selected BACKEND_API_URL as the credential authority even when an independent broker origin was configured
symptoms:
  - LANTERN_NOT_CONNECTED
  - Local broker used instead of configured central authority
  - 'Timeout after 300s (wall-clock backstop=300s) | Agent status: PAUSED'
  - 'GET /api/integrations/lantern-people/credentials/token -> 404'
  - 27 of 27 lantern-people jobs hit the 300s backstop in a cloud sharded run
tags:
  - lantern
  - credential-broker
  - isolated-workers
  - benchmark-stacks
sources:
  - commit c6117542139ec0256f47de02a53e68a321d8e26a
  - task .context/lantern-broker-rca-c611/.context/broker-rca/red-checkpoint.json
  - task .context/lantern-broker-rca-c611/.context/broker-rca/proposal.json
  - task original600-1792433794419199295
  - agent 8580b4d6-9124-44ce-9f7e-d3a26fd6b7eb
  - agent c2a7b71b-31d0-42cd-abfe-7ed98ebd3920
repro: cd agents && python scripts/run_blackbox_tests.py people-search; bash scripts/tests/cloudbench-env.test.sh; scripts/run-bench --local lantern-people-discovery
status: fixed
---

## Problem

Source inspection found that ordinary isolated DAILY workers route their application
backend locally or to the fleet primary. Without a static bearer, people search
uses that same backend for credentials. A separately activated production grant
therefore does not establish a credential path for those workers. This is a
source-backed configuration gap, not a claim of an observed production exposure
or a failed native benchmark. The existing three-task native pass used an
explicit access-only bearer and remains valid within that scope.

The registered actual-activity fixture uses real configuration loading and the
HTTP transport boundary. Before the fix it observes a local credential GET and
404 LANTERN_NOT_CONNECTED instead of the configured central credential GET and
successful native request. Four new contract cases fail before the runtime fix;
existing cases, blank/default controls and FastMode zero-HTTP controls pass.

## Diagnosis

Credential authority and application backend routing were represented by one
configuration field. Local stack routing overwrites the latter by design.
Copying a rotating refresh grant into isolated database snapshots would create
independent refresh claim domains and does not repair that authority boundary.
Archive searches for credential brokers, isolated seeds and refresh grant clones
found related credential overlay history but no safe rotating-grant clone design.

## Solution

Add an optional PEOPLE_CREDENTIAL_BROKER_URL, independent of PEOPLE_API_URL and
the application backend. A nonblank broker is authoritative even when an explicit
static bearer exists. Validate its HTTPS or loopback origin before machine-auth
HTTP, reject invalid components and ports without including the URL in errors,
and keep native expected-origin validation. Use the existing machine key and
workflow actor; never forward refresh grants or fall back after broker failure.
Blank configuration preserves existing direct-token and local-broker behavior.

The same registered people-search owner passes after the fix, including typed
503 wait details, malformed-origin zero HTTP, default routing and FastMode zero
HTTP. The normal config owner also passes. Deployment still requires explicitly
configuring and propagating the broker origin and a compatible machine key, and
activating the intended server-side grant. These local tests do not assert that
those operational prerequisites have been completed.

## Recurrence 2026-10-19: benchmark stacks never activated the broker

In cloud sharded run original600-1792433794419199295 (source f9c01f05c), all 27
lantern-people discovery, enrichment and pagination jobs ended PAUSED at the 300s
wall-clock backstop (the scorecard's 28th backstop was a grep-agent-trajectories
job from a separate cluster), with $0.08 metered LLM cost for 36 jobs. This was not a
stall. Every one of 117 people_search results across the 27 jobs was
`Lantern People: LANTERN_NOT_CONNECTED`, with zero successes. The agent
re-spawned explore agents and each verifier pass took 80-110s until the
backstop. The guest agents/back-end env files set none of PEOPLE_API_TOKEN,
PEOPLE_CREDENTIAL_BROKER_URL or LANTERN_PEOPLE_SHARED_USER_ID. The
worker therefore asked the guest's own backend
(`GET /api/integrations/lantern-people/credentials/token -> 404`), and that
backend's canonical seed deliberately has no lantern_people row. Production
held the CONNECTED grant for the benchmark user. Its last refresh, one minute
before the last recorded local pass on 2026-10-16, is consistent with that pass
reaching the central broker; its run record was not retained, so the exact
credential path of those passes is unverified.

Why the earlier fix did not hold: it added an optional broker with a blank
default and left "operational broker activation" pending. Production worker
plans bind the broker origin, but `run.sh --benchmark`, which both
`run-bench --local` and every cloud guest launch, never did. No regression
asserted that a benchmark stack's worker has a credential authority.

Repro: `scripts/run-bench --local lantern-people-discovery` on unchanged
origin/main 7441b41f4 failed (Timeout after 333s, 3x LANTERN_NOT_CONNECTED,
agent 8580b4d6-9124-44ce-9f7e-d3a26fd6b7eb). The new owning case in
`scripts/tests/cloudbench-env.test.sh` executes run.sh's actual fragment and
failed before the fix.

Fix: in benchmark mode, run.sh exports PEOPLE_CREDENTIAL_BROKER_URL as the same
central origin that production worker plans bind, through
`cloudbench_people_credential_broker_default`, unless a broker or bearer is
configured in the environment or agents/.env. Ordinary dev stacks are unchanged.
The identical command then passed in 82s with one successful people_search
(agent c2a7b71b-31d0-42cd-abfe-7ed98ebd3920). The regression passed five
consecutive unchanged runs and is run by /deploy whenever scripts/run.sh or the
cloudbench env helper changes.

Scale and blast radius: each people_search makes one machine-authenticated GET
to the central broker, the same call production workers make. Refresh stays
single-owner under the existing server-side claim fence, so benchmark width does
not add refreshes. During a refresh window concurrent callers receive the
existing 503 LANTERN_REFRESH_IN_PROGRESS. A failed refresh still fences the one
production grant until a human reconnects; benchmarks now share that grant with
production workers rather than adding a second lineage.

Still open: the tasks declare no credential dependency (`secrets: []`) and no
runner preflight checks it, so a missing credential still costs the full
backstop as an agent failure instead of failing fast as configuration. Adding
that needs a reviewed task-definition and runner change.

Golden reference: claude-code-src/src/utils/auth.ts:1447 (single locked
refresher), codex/codex-rs/app-server/src/external_auth.rs:85 (refresh delegated
to the grant owner), hermes-agent/hermes_cli/auth_codex.py:172 (refresh written
back to the one root store), and openclaw/src/gateway/worker-environments/credential-broker.ts:29
(workers receive only short-lived credentials). The fix converges on that shared
pattern: one owner holds the grant and workers get short-lived tokens.

## Human feedback

None recorded.

## Reusable lesson

Represent credential authority separately from application routing, and make every isolated launcher, benchmark stacks included, bind that authority rather than leaving it blank.
