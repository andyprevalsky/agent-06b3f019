---
id: 2026-09-10-claude-oauth-client-version-below-model-minimum
date: 2026-09-10
title: Stale Claude OAuth client version rejected the selected model before inference
surface: cross
component: rose-anthropic-transport
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Both Rose OAuth transports advertised a Claude CLI version below the configured model minimum (2.1.81 vs 2.1.251 for Fable 5.1; 2.1.251 vs 2.1.280 for Opus 5.5) with no check binding pool models to the advertised version
symptoms:
  - "rose.transport.anthropic.error status=400"
  - "Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required"
  - "claude_code_version_too_old"
  - "rose.transport.anthropic.client_version_too_old"
  - "no claude-opus-5-5-claude served"
tags:
  - anthropic
  - claude-oauth
  - user-agent
  - client-version
  - recurrence
  - silent-fallthrough
sources:
  - PR #1299
  - agent 278b1938-5ec6-491e-84fb-33f5f5488fa0
  - commit 50284e1ec3ced062b0a1ad42cdc3bb07f0b6ea26
  - PR #1311
  - commit 8f3c22f31
repro: agents/tests/blackbox/rose.blackbox.py::test_anthropic_transport_accepts_captured_client_version_requirement
status: fixed
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

**Recurrence 2026-10-20.** A sibling live probe with the prod Claude OAuth token
of user 1f85ff25 found every `claude-opus-5-5` claudeAuth request (pool
`rose-1-ultra`, also `rose-wmh-gpt61`) rejected with HTTP 400
`Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is
required` (`details.error_code: claude_code_version_too_old`). Sonnet 5 and
Haiku 4.5 still returned 200 at 2.1.251. `rose-1-ultra` was retargeted to
Opus 5.5 in commit 8f3c22f31 (PR #1311, merged 2026-09-28 03:39Z) while both
transports still advertised 2.1.251. Prod `ToolUsage` rows from 2026-09-10 to
2026-10-20 contain no `claude-opus-5-5-claude` served model at all. Ultra was
served by `gpt-6-sol-gpt`, `gpt-6-sol-foundry` and `openai/gpt-6-sol` instead.
A sibling count found zero Opus/Sonnet Claude-token calls from 2026-09-13 to
2026-10-20 (775 from 08-01 to 09-12) and 1,851 gpt-6-sol calls where Opus would
have served. No alert fired.

Retained ClickHouse Fly logs (2026-10-13 to 10-20) show 39 OAuth
`claude-opus-5-5` starts. Each was rejected, but every logged 400 had
`error_body_len=234`, including Haiku calls. The captured version rejection is
326 bytes. Those prod 400s are therefore a different provider error, the
expired-credential cluster owned by sibling PR #1554, which masked the version
rejection on the live path. The transport logged only the body length, so the
exact code could not be read from prod. That observability gap is closed below.

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

**Why the 2026-09-10 guardrail did not hold.** It encoded a single captured
minimum (2.1.251) for one model (`claude-fable-5-1`) inside each test. It never
looked at the pool registry. Retargeting a pool to a model with a higher
minimum therefore passed every deploy gate, and the provider's typed rejection
was logged as an opaque `status=400 error_body_len=N`. Fall-through then raised
a bare `RoseInvalidRequest("Anthropic 400")`, so the waterfall silently served
GPT. Two gaps share one class, a hardcoded client identity that silently ages
out:

1. No check that every configured `claude_auth_model` has a live-verified
   client-version requirement.
2. No visible signal when the provider says the client is too old.

Other pinned headers were inventoried. `anthropic-version: 2023-06-01`,
`x-app: cli`, the beta list and the `agent-sdk/0.2.75` suffix were all held
constant in the live 200 proofs and are not version-gated by the provider today.
The OAuth mint/profile helpers that advertise 2.1.88 call non-inference endpoints
and were not observed failing.

Repro, recorded 2026-10-20 (`.context/ua-probe/`):

- Live, through the real `post_anthropic_stream` with a leased prod token. The
  same body was sent each time and only the CLI version changed:
  2.1.251 -> 400 `claude_code_version_too_old` (0.31s); 2.1.280 -> 200 (0.94s);
  2.1.251 -> 400 again (0.16s); 2.1.304 -> 200 (1.15s). Sonnet 5 and Haiku 4.5
  returned 200 at both 2.1.251 and 2.1.304.
- Owning blackboxes, red before the transport edit:
  `agents/venv/bin/python agents/scripts/run_blackbox_tests.py rose` failed
  243/245 with `AssertionError: OAuth transport advertised a client version
  claude-opus-5-5 rejects (captured provider contract)`, and the surfacing test
  failed on the missing error code. `node --import tsx
  src/tests/blackbox/run.ts rose-transport` failed with `400 !== 200`.

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
Python red/green plus TypeScript green.

**2026-10-20 recurrence fix (generic):**

- `shared/claude-oauth-client/contract.json` is the single recorded source. It
  holds the advertised `client_version` (2.1.304, the current published Claude
  Code release), the UA suffix, each configured claudeAuth model's live-observed
  minimum with its evidence, and the captured rejection body. The separately
  deployed transports keep their constants. Both blackboxes assert that each
  constant equals the contract and iterate the real pool registry.
  - The test fails when any `claude_auth_model` lacks a contract entry.
  - The test fails when the advertised version is below any model's minimum;
    the mock answers with the captured rejection.
- Both transports parse the provider's enum fields `error.type` and
  `error.details.error_code` into `anthropic.error`. On
  `claude_code_version_too_old` they log an error-level
  `rose.transport.anthropic.client_version_too_old` (TS:
  `anthropic.client_version_too_old`) with the model, the advertised UA and the
  provider's requirement message. `RoseInvalidRequest` now carries the code
  (`Anthropic 400 (claude_code_version_too_old)`), so a fall-through is
  attributable. Routing, rotation and retry semantics are unchanged.
- Golden reference: `claude-code-src/src/utils/http.ts:34` derives the UA from
  the build's own `MACRO.VERSION`. `claude-code-src/src/utils/autoUpdater.ts:77-87`
  fetches a remote `minVersion` and fails loudly ("A newer version ... is
  required"). Rose cannot self-update a vendored identity. It converges on that
  design with one recorded identity and a loud, typed signal instead of a
  silent downgrade.
- Post-fix: the identical blackbox commands pass (rose 245/245, rose-transport
  PASS), each five consecutive times. Live, the default transport (2.1.304)
  returned 200 for `claude-opus-5-5`. A forced 2.1.251 returned 400 and emitted
  the new error-level event with the provider message.
- 10k agents: the error path adds one JSON parse of an already-read error body
  and at most one log line per rejected request. It adds no requests, state,
  locks or per-agent allocations.
- Remaining gap: a provider-side minimum raised for an already-configured model
  is still only caught at runtime. It is now caught loudly through the new
  error-level event, not silently. Status remains open pending full deploy
coverage and production verification. Tracked changes were held until the root
agent confirmed all affected local stacks and the cloud proof were stopped.

## Human feedback

None recorded.

## Reusable lesson

Bind every configured provider model to a live-recorded client-version
requirement in one shared contract checked against the real pool registry,
and log the provider's typed rejection code, never just a body length.
