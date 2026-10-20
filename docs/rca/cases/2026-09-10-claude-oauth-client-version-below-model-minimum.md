---
id: 2026-09-10-claude-oauth-client-version-below-model-minimum
date: 2026-09-10
title: Stale Claude OAuth client version rejected the selected model before inference
surface: cross
component: rose-anthropic-transport
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Both Rose OAuth transports advertised Claude CLI 2.1.81 while the selected model required at least 2.1.251
symptoms:
  - "rose.transport.anthropic.error status=400"
  - "rose.claude_auth.invalid_request"
  - "Claude Code version 2.1.81"
  - "2.1.251"
tags:
  - anthropic
  - claude-oauth
  - user-agent
  - client-version
sources:
  - PR #1299
  - agent 278b1938-5ec6-491e-84fb-33f5f5488fa0
  - commit 50284e1ec3ced062b0a1ad42cdc3bb07f0b6ea26
repro: agents/tests/blackbox/rose.blackbox.py::test_anthropic_transport_accepts_captured_client_version_requirement
status: open
---

## Problem

Five Claude OAuth calls during agent-payment-test-shop received HTTP 400 with a
provider version requirement: the transport advertised 2.1.81, while the selected
claude-fable-5-1 model required at least 2.1.251. The agent ultimately COMPLETED;
this is a direct-provider compatibility defect, not a claim that the benchmark
failed. Slow successful click and payment-coordinate operations were independent
observations and are not attributed to these quick provider rejections.

The private evidence directory is
`.context/acceptance/payment-shop-slow-rca/`. It preserves all 12 worker logs,
backend logs, 18 full LLM dumps, provider responses, and replay wire bodies/SSE.
Files are mode 0600. No credentials or private messages are copied into this case.

Durable run evidence: https://www.roselabs.ai/?agent-id=278b1938-5ec6-491e-84fb-33f5f5488fa0
The canonical publisher verified 67 messages and all browser termination and
recording checks. Its local manifest is
`.context/acceptance/rca_evidence/278b1938-5ec6-491e-84fb-33f5f5488fa0/manifest.json`.
The run completed; the reproduced failure here is the direct-provider HTTP 400.

## Diagnosis

Critical path: captured completion_summary messages/config -> existing
claude_auth_complete -> build_anthropic_body -> post_anthropic_stream -> provider
version validation -> HTTP response. The owning boundary is the User-Agent built
by `agents/providers/rose/transport.py` and its TypeScript mirror in
`back-end/src/providers/rose/transport.ts`.

Controlled local replay used the captured completion_summary request and the
captured user Claude credential from the same root's response_schema dump. All
three trials used the same messages, model, body, token, request ID, config, and
provider path. The only changed header was User-Agent; only its CLI version
substring changed, leaving the Agent SDK suffix and all other header fields
unchanged. The byte-identical body hash is recorded in `version-replay/summary.json`.
No returned tools were executed.

Command (from the repository root):

```bash
agents/venv/bin/python .context/acceptance/payment-shop-slow-rca/claude-version-replay.py
```

Results: 2.1.81 -> HTTP 400 version rejection in 0.555s; 2.1.251 -> HTTP 200 and a
complete parsed SSE response in 7.385s; restore 2.1.81 -> the same HTTP 400 in
0.529s. `version-replay/controlled-proof.json` confirms identical bodies and
User-Agent as the sole changed header. This demonstrates causal compatibility,
not model intelligence or a change in routing.

The deeper owned gap is that both independently deployed provider transports
retained a client identity below the selected model's accepted minimum, while
the existing blackboxes tested auth headers/error handling but did not enforce
this observed provider contract. The protocol requirement itself belongs to the
provider; no broader architecture claim is needed.

Archive searches included `invalid_request anthropic 400 insufficient_quota` and
`Claude Code required model version invalid_request_error`; no prior version
minimum case was found. The exhausted-direct-GPT case is a relative only, and
the native-completion-selection case has a different boundary. Git history and
open PR searches found no 2.1.251 compatibility fix in flight.

## Solution

Updated only the advertised CLI version in both inference transports to the
observed compatible minimum 2.1.251. Keep the
existing SDK suffix, beta headers, body, model, auth, retry and routing behavior.
The general fix applies to every call through either transport, with no task or
model special case. Four existing Python attribute type suppressions are removed
using equivalent `setattr`; no error classification or retry behavior changes. A shared runtime config across separately deployed packages
would add packaging dependencies without improving this two-line repair.

Owning permanent regressions are registered in the existing Python rose blackbox suite and the new
`back-end/src/tests/blackbox/rose-transport.blackbox.ts` suite, automatically
discovered by the existing backend blackbox runner. Each invokes the real transport and has its HTTP mock
inspect the actual outbound User-Agent and OAuth headers. The captured provider
400 is returned for older versions; the unchanged assertion requires HTTP 200.
Tracked owning-suite results (tests added before changing either transport):

```bash
# Repository root; identical command before and after the production edit.
agents/venv/bin/python agents/scripts/run_blackbox_tests.py rose
# Backend directory under Node 22.13.0; identical command before and after.
node --import tsx src/tests/blackbox/run.ts rose-transport
```

Python was red with 179 passing tests and one failure on the new header
assertion; after the transport edit all 180 passed. TypeScript rose-transport
was red on HTTP 400, then green with its unchanged HTTP 200 assertion. Logs are
`proposed/tracked-python-{red,green}.log` and
`proposed/tracked-ts-{red,green-exact}.log` under the private evidence directory.
The Python error-body test additionally exercises all four transports and
asserts that the provider classifier can read the original error response.

The broader backend run of `rose-transport,rose` also passed both domains.
Ruff lint/format and backend ESLint/Prettier checks passed. The unchanged backend
runner was also executed over the proposed directory and discovered the new
rose-transport domain. Existing deploy coverage invokes the Python blackbox
runner and the backend filesystem-discovered blackbox runner; no new live gate
or benchmark was added.

Other version-bearing paths were inventoried: OAuth mint/profile helpers,
setup/probe scripts and compute-token-semantics use 2.1.88; old debug planner
scripts use 2.1.45. Their endpoints/model choices differ and no failure was
established here, so the proposed repair is confined to the proven inference
transport boundary. The Agent SDK suffix 0.2.75 was held constant in the live
proof and requires no change for this incident.

At 10,000 agents the change adds no requests, loops, state, locks, timers,
subscriptions, or per-agent allocations: it changes the fixed header value.

Independent adversarial review passed with no blocking objections and reran
Python red/green plus TypeScript green. Status remains open pending full deploy
coverage and production verification. Tracked changes were held until the root
agent confirmed all affected local stacks and the cloud proof were stopped.

## Human feedback

None recorded.

## Reusable lesson

Preserve and replay provider client-version rejections at the actual transport
boundary before changing prompts, models, or fallback policy.
