---
id: 2026-11-13-agent-loop-usage-heartbeat-dropped-without-integration-id
date: 2026-11-13
title: The agent loop's subscription usage never reached the bars because its lease heartbeats named no login and the backend silently dropped them
surface: agents
component: compute-subscription-usage
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py call_llm builds its Claude/GPT lease contexts without integration_id, so _heartbeat_lease posted the parsed usage snapshot with lineageKey and usage but no integrationId; back-end parseSubscriptionUsageReport returns null when integrationId is empty, so the heartbeat answered 200 with usageRecorded false and the worker counted the snapshot as delivered
symptoms:
  - '{"ok":true,"updated":1,"usageRecorded":false}'
  - lineage-heartbeat 200 during a claudeAuth agent run, but usageObservedAt stays null on every claude_code row
  - GET /api/compute-accounts usage null after a production code-agent run on a Claude subscription
  - compute usage bars empty after PR #1981 although rose.complete served claude-opus-5-5-claude
tags:
  - usage-bars
  - compute-accounts
  - subscription-usage
  - lineage-heartbeat
  - agent-loop
  - credential-fingerprint
sources:
  - PR #1981 (merged 5d8e6d4d39)
  - agent e6634205-da06-4a0a-a073-edd2c9259ddf (production proof run, 2026-11-13 11:14Z)
repro: agents/tests/blackbox/rose.blackbox.py test_agent_loop_lease_usage_heartbeat_names_its_login; back-end/src/tests/blackbox/compute-subscription-usage.lease.cases.ts (an agent-loop heartbeat naming its token by fingerprint records on that login only), run by back-end/src/tests/blackbox/compute-subscription-usage.blackbox.ts
status: fixed
---

## Problem

PR #1981 (merged 5d8e6d4d39) made agents report each subscription account's
5h/7d usage on the lineage heartbeat they already send. After the deploy, a
minimal production agent (e6634205-da06-4a0a-a073-edd2c9259ddf, the
`claude-code-agent` smoke prompt) ran at 11:14Z on Andy's account. Its
`execute_loop` and `completion_summary` calls were served by
`claude-opus-5-5-claude` on a user-source Claude lease, and Render logged
about 33 `POST /api/integrations/compute-code/token/lineage-heartbeat -> 200`
during the run. Yet `GET /api/compute-accounts` still returned `usage: null`
for every account, and `usageObservedAt` stayed null on every `claude_code`
row.

Archive search: `usage heartbeat usageRecorded false integrationId` and
`agent loop lease usage dropped`. The relative case is
`2026-11-12-usage-snapshot-sent-only-on-next-heartbeat-and-every-cooldown-drawn-exhausted`,
which added the heartbeat usage path. Its tests always built the lease context
with an integration id. This incident is novel.

## Diagnosis

Critical path: Anthropic response headers → `claude_auth.observe_subscription_usage`
→ `subscription_usage._snapshots` → `flush` → `_heartbeat_lease` →
`heartbeat_compute_token_lineage_activity` → `POST …/lineage-heartbeat` →
`parseSubscriptionUsageReport` → `recordSubscriptionUsage` → `Integration.usage*`.

Binary search with a local run of the supported lease path against the
production backend (`fetch_compute_token_activity` →
`_build_compute_auth_context` → `RoseClient().collect`, rose-1-ultra, printing
header names and parsed snapshots only, never the token):

- The headers are present and parsed correctly:
  `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` gave
  `fiveHour {usedPct: 2, resetsAt: 2026-11-13T14:10:00Z}` and
  `sevenDay {usedPct: 17, resetsAt: 2026-11-18T19:00:00Z}`.
- The snapshot was pending for the heartbeat. The parser and the store are
  not the first bad boundary.
- In the agent loop, `call_llm` (helpers/llm.py) builds
  `_build_claude_auth_context(...)` / `_build_gpt_auth_context(...)` with a
  lineage key but without `integration_id`. Its heartbeat body is therefore
  `{lineageKey, usage}`.
- The backend's `parseSubscriptionUsageReport` returns null when
  `integrationId` is empty, so `heartbeatComputeTokenLineage` answers
  `{"ok":true,"updated":1,"usageRecorded":false}`. The worker treats any 200
  as delivered and never resends. First bad boundary: the heartbeat names no
  login, and the drop is silent.

Ladder (Step 5a):

1. Why was no usage stored? The heartbeat named no login, and the backend
   refuses to guess one (a user has several).
2. Why did it name no login? `call_llm` receives only the token, its source,
   user and pool id from the workflow; the lease's integration id is not one of
   its 91 threaded arguments.
3. Why was it not caught? Every agents test built the lease context from a
   lease result that carried `integrationId`, and the backend test always sent
   one. No test used the agent loop's construction.

Reproduction (fails before, passes after):

- `test_agent_loop_lease_usage_heartbeat_names_its_login` builds both
  contexts exactly as `call_llm` does. On the unpatched helpers/llm.py the
  heartbeat body carries `usage` with neither `integrationId` nor
  `credential`, so the assertion fails.
- `compute-subscription-usage`, case "an agent-loop heartbeat naming its token
  by fingerprint records on that login only": with the backend fix reverted it
  failed with `usage must be recorded, got {"ok":true,"updated":1,"usageRecorded":false}`
  (24/25).

## Solution

The worker already sends a credential fingerprint
(`credential_fingerprint(token)`, backend `credentialFingerprint`) with
rate-limit reports. Usage heartbeats now carry it too, so every leased call
path names its token without threading a new argument through the agent loop.

- agents: `heartbeat_compute_token_lineage_activity` accepts `credential`
  and sends it with the usage when there is no integration id. Both lease
  closures pass `credential_fingerprint(ctx.token)`.
- back-end: `parseSubscriptionUsageReport` accepts a heartbeat that names its
  token by a 16-hex fingerprint. `recordSubscriptionUsage` resolves it through
  `resolveUserLoginByCredential` (computeLoginFailure.ts). That reads only the
  lease user's own CONNECTED logins of the lease's type and matches the stored
  token's fingerprint. It never names another user's login. A pool lease names
  its own row. With neither an id nor a fingerprint, nothing is written, as
  before.

Verification: both regressions passed five consecutive runs
(`compute-subscription-usage` 25/25 each run; the agents cases 2/2 each run).
Prettier, ESLint and back-end `tsc --noEmit` are clean.

At 10k agents: one extra 16-character field per usage heartbeat (already
throttled to one per token per 15 s). A resolution hit is a map read. A miss
reads and decrypts at most the lease user's own logins (cap 50), once per
token per 10 minutes, in a bounded 10k-entry cache. Nothing is added to the
completion path. No prompt, Zod schema or harness trajectory text changes.

## Human feedback

Andy, 2026-11-12 15:51Z (relative case): "these bars should be updating in a
non blocking way from normal Rose.complete usage". The coordinator asked on
2026-11-13 for hard production proof after normal use; the proof run exposed
this drop.

## Reusable lesson

When a contract field is optional on the wire, test the producer the way its
real caller builds it. A 200 that says "nothing recorded" is not delivery:
make the drop observable in a test before trusting the happy path.
