---
id: 2026-10-20-rose-usage-carried-leased-compute-credential
date: 2026-10-20
title: Rose completion usage carried the raw leased compute OAuth token into dumps, logs, message metadata and Temporal results
surface: agents
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/client.py::_compute_token_payload copied ComputeAuthContext.token into the usage chunk's compute_token_used
symptoms:
  - usage["compute_token_used"]["accessToken"]
  - output.usage.compute_token_used.accessToken in llm.context.dump_updated payload_gzip_b64
  - metadata.writeLockNotificationUsage.usage.compute_token_used.accessToken
  - probe script printed the leased OAuth access token when dumping the Rose result
tags:
  - credentials
  - secret-leak
  - compute-token
  - rose-client
  - llm-dumps
  - clickhouse
  - temporal-history
sources:
  - commit f0668e4d8
repro: agents/tests/blackbox/rose.blackbox.py::test_client_completion_never_serializes_compute_credentials
status: fixed
---

## Problem

A Rose completion's usage chunk exposed the leased compute OAuth access token
at `usage["compute_token_used"]["accessToken"]` (plus the GPT `accountId`). A
live reasoning probe printed it when dumping the result. Read-only exposure
audit (counts only, no values read out):

- ClickHouse `observability.fly_logs` (7-day retention): 2,743 of 7,958
  `llm.context.dump_updated` events (2026-10-14 21:10Z to 2026-10-20 02:30Z,
  108 root agents) carried it at `output.usage.compute_token_used.accessToken`;
  10 distinct token values across 6 credential identities. 5 further plain log
  lines (`Creating approval request`, `Verifier raw context`) carried it in
  approval metadata.
- Prod Postgres: 1,258 `Message` rows (135 agents, 5 users, 2026-07-09 to
  2026-10-20) and 541 `AgentAttentionRequest` rows (64 agents) carried it in
  `metadata...writeLockNotificationUsage.usage.compute_token_used`; 13 pool and
  user credential identities, 46 distinct token values. Message metadata is
  served to the owning user by the API/realtime, so pool credentials were
  readable by the users whose agents used them.
- Also: encrypted R2 trace-archive `llm-updates/*` records, Temporal activity
  results for `call_llm_activity`, local `.llm-dumps`.

## Diagnosis

`_compute_token_payload(auth)` built the usage identity from the full
`ComputeAuthContext`, including `auth.token`. Every sink that serializes
usage then persisted it: `_finalize_dump` -> `update_llm_dump` ->
`llm.context.dump_updated` (ClickHouse) and the archive; browser write-lock
notification usage -> message metadata and attention requests; activity return
values -> Temporal history.

Why was it possible: the field existed to transport an in-call rotated
credential back to the workflow (`_remember_compute_token`) and to
activity-hosted loops (`run_agent._remember_successful_compute_token`), so the
credential was treated as data instead of being resolved by reference. The
backend already binds the rotated credential to the lineage lease
(`fetchCredentialForLease`), so the secret never needed to travel. Next rung
(workflow state and activity args still carry tokens by design via
`fetch_compute_token_activity` / `_active_compute_token_payload`) is a
documented design decision outside this fix; it is recorded as a follow-up.

Repro (pre-fix): `env -u FLY_APP_NAME agents/venv/bin/python .context/rca-token/run_one.py agents/tests/blackbox/rose.blackbox.py test_client_completion_never_serializes_compute_credentials`
-> `FAIL ... AssertionError completion stream serialized a compute credential`.

## Solution

Usage now names only the lease: `{type, source, poolTokenId, lineageKey}`.
Consumers re-read the credential by reference:

- Workflow `_on_tokens`: when the served lease identity differs from the cached
  token or a rotation occurred, `_refresh_compute_token(force=True,
  token_type=...)` re-reads the lineage-bound lease (no release). An unchanged
  identity schedules no activity.
- `run_agent` inside an activity re-reads the same lineage lease via
  `fetch_compute_token_activity` only after a rotation; in workflow mode the
  getters already observe the refreshed token, so semantic retries use them.
- `scripts/replicate_llm_dump.py` leases a fresh GPT token through the
  supported path instead of reusing a credential stored in the dump.

Siblings prevented: every current and future usage sink (dumps, ClickHouse,
approval metadata, message metadata, run records, Temporal results, probes).
10k-agent behavior: neutral. Usage bytes shrink; one extra backend lease read
happens only on an in-call rotation (rare, already preceded by a
mark-rate-limited + fetch_fresh pair); no new shared state or fan-in.

Golden reference: `claude-code-src/src/services/mcp/auth.ts:97-117,701` redacts
OAuth params and the Authorization header before any log;
`codex/codex-rs/memories/write/src/phase1_output.rs:49` redacts secrets before
persistence. The fix converges further: the credential never enters
telemetry at all.

Follow-ups needing user approval: rotate the exposed credentials and purge the
historical rows/log events listed above.

## Human feedback

None recorded.

## Reusable lesson

Never put a credential in a result or telemetry object; return the lease identity and re-read the secret by reference at the consumer.
