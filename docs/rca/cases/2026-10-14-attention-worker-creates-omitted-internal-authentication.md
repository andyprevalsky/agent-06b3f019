---
id: 2026-10-14-attention-worker-creates-omitted-internal-authentication
date: 2026-10-14
title: Credit and approval gates omitted worker authentication after attention creation was secured
surface: cross
component: attention-request-worker-transport
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/gate/repo.py create_gate_request_activity and agents/domains/request_user_approval/repo.py create_approval_request_activity POSTed to authenticated attention creation without their configured internal credential
symptoms:
  - '401 Unauthorized for /api/attention-requests'
  - 'Credit gate setup failed after depletion (pausing): Activity task failed'
  - 'Agent paused, waiting...'
  - 'create_gate_request_activity failed after three attempts'
  - 'create_approval_request_activity failed after three attempts'
tags:
  - attention-requests
  - authentication
  - credit-gate
  - approval
  - payment
  - worker
sources:
  - PR #1511
  - commit d940fda32b4ee9fd82893097c8e93dc7758ac676
  - agent 68b2795f-5816-44d7-aad1-3d32ecf89812
  - agent b32f4e86-1d09-47c0-99b6-9ae62996b6d3
  - benchmark run 20261014_214347_b4880458-8d1e-4331-a7ab-767eb86844f3
repro: back-end/src/tests/blackbox/attention-requests.blackbox.ts
status: fixed
---

## Problem

The paid Group4 smoke agent `68b2795f-5816-44d7-aad1-3d32ecf89812`
(`agent-payment-new-user-journey`) remained at four messages and zero cost.
Its schema activity completed, then activity 18 (`create_gate_request_activity`)
received HTTP 401 on all three attempts at 21:32:34.657Z, 21:32:35.763Z, and
21:32:37.869Z. The credit handler paused the workflow at 21:32:37.963Z;
`run_agent` logged its paused wait at 21:32:38.445Z. It was waiting without
an actual created gate, so the expected subscription fixture could not resolve it.

The separate setup-resume agent `b32f4e86-1d09-47c0-99b6-9ae62996b6d3`
failed approval creation nine times: activities 33, 46, and 73 each exhausted
three attempts. Browser write approval and AgentCard setup share that producer.
The backend returned `Authentication required. Provide JWT token, API key, or
x402 payment.`
The unchanged first smoke batch ultimately passed seven of eight tasks; this
payment task failed naturally after 545.3 seconds. Setup-resume also failed
naturally after 912.5 seconds. Those outcomes confirm the failed ingress had
task-level consequences, rather than only appearing as a transient warning.

Raw backend, eight worker logs, report card, and service metadata were copied
with SHA-256 manifests before task ownership ended. Payment evidence is under
`.context/rca-credit-gate-authority/evidence/before` and
`.context/rca-ae17b024/payment-gate-401-evidence`; setup evidence is under
`.context/rca-ae17b024/approval-producer-401-evidence`. No running task was
signalled, restarted, deleted, or otherwise changed during diagnosis.

## Diagnosis

Critical path: workflow credit depletion or browser write-lock requests an
attention activity; the Python producer posts the actual user, agent, and
workflow identity to the backend; `hybridAuth` authenticates the request; the
attention service validates authoritative agent/workflow ownership; the
durable pending gate becomes visible to the user or task fixture.

The first bad boundary was the outgoing Python request. Both create activities
sent JSON and a timeout but omitted authentication headers. Their backend
credential was already available as `config.backend.api_key`. Adjacent checkout
minting and attention resolution already forwarded it. Securing attention POST
creation exposed the two unauthenticated callers. The correct repair belongs
at those producers; accepting claimed user IDs at the public receiver would
reintroduce the ownership vulnerability the receiver guard prevents.

The deeper gap was independently testing the producer against an unconditional
HTTP mock and the receiver with hand-authenticated requests. Neither test
exercised their shared authentication contract. The new owning test invokes
each actual Python producer against the actual public HTTP route, using a real
owned agent and its native root workflow identity. Its subscription payload
comes from the production `build_subscription_gate` builder.

Audit found exactly two production HTTP create implementations. Approval tool
management, direct browser write locks, message actions, and AgentCard attention
all delegate to the approval activity. The gate helper delegates subscription,
KYC, and enabled connection gates to the gate activity. Existing resolution
calls already supply the credential and user provenance; backend-native
creation does not traverse this HTTP route.

Archive searches: `attention requests 401 missing X API Key gate approval` and
`credit depletion pause failed subscription gate worker authentication`. The
setup-fixture 502 and gate-abandonment cases have different first bad
boundaries; this is a new case.

Golden references: the existing resolver in
`agents/domains/request_user_approval/repo.py` forwards both the configured
`X-API-Key` and actual `X-User-Id`. Claude Code's
`src/services/remoteManagedSettings/index.ts:166` derives auth headers and merges
them into the real request at line 269; Hermes'
`scripts/aa_quality_sync.py:47` supplies the configured key at its HTTP boundary.
Codex's `codex-rs/rmcp-client/tests/streamable_http_oauth_startup.rs:443`
requires the resource credential on the receiving mock server. OpenClaw's
LM Studio adapter preserves authenticated client headers in its cache identity,
but has no matching worker attention-creation mechanism. These references
support verifying transport authority where the request is actually received.

The ubiquitous `Failed to poll queue metrics` warnings were separate autoscaler
observation failures (`namespace rate limit exceeded`), caught by the poll
loop. Other tasks completed and activities continued while they were logged.
They do not explain the deterministic HTTP 401 followed by the credit pause.

## Solution

Both actual create POSTs now forward their existing backend credential and
their actual `user_id` as `X-API-Key` and `X-User-Id`. Their payloads, timeout
budgets, task prompts, and receiver authentication/ownership checks are unchanged.
There is no new credential, caller-trust assertion, unauthenticated exception,
gate suppression, synthetic message, or task workaround.

The permanent API suite launches the real Python producers over HTTP. For each
producer it verifies successful owned creation (200), an unowned target (403),
and missing credentials (401), then checks the actual pending rows. Python
owning boundary tests also tie the outgoing owner header to the actual body.

Exact same local owning command on both sides:

```text
cd back-end
BLACKBOX_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_credit-gate-authority CONDUCTOR_PORT=24200 bash scripts/run-blackbox-tests.sh attention-requests
BEFORE: 55 passed, 4 failed, 59 total; both actual create producers returned 401
AFTER:  59 passed, 0 failed, 59 total (5419 ms)
```

Artifacts: `.context/worker-attention-authority-before-native.txt` and
`.context/worker-attention-authority-after-native.txt` in the isolated
`.context/credit-gate-authority` checkout. That checkout uses a distinct local
database and backend port; active paid stacks and their databases remain unchanged.
The normal agents runner also passed the gate and request-user-approval domains.
Scoped Ruff, Python compilation, ESLint, formatting, and full backend typecheck
passed. At 10000 agents this adds only two headers to existing requests, without
new network calls, retries, state machines, or per-agent credential storage.

The source mechanism and unchanged task outcomes are verified. The local agent-payment-new-user-journey task passed in 209.7 seconds and agent-payment-setup-resume passed in 178.7 seconds, without changing their definitions, timeouts, evaluators, or pass criteria. The corresponding run IDs are 8af77f88-95a2-42ad-bea9-8b72b296c0f6 and e2b96199-42c4-4eb3-bb29-3ddb1dc0e24a. Deployment verification and retained evidence are tracked in PR #1511.

## Human feedback

None recorded.

## Reusable lesson

When securing an ingress, verify every real producer against that authenticated receiver instead of trusting separate producer and receiver mocks.
