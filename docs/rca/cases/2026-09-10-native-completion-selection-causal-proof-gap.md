---
id: 2026-09-10-native-completion-selection-causal-proof-gap
date: 2026-09-10
title: Native execute model selected waits after successful payment without a proven causal fix
surface: agents
component: rose-native-completion
classification: undetermined
problem_class: other
first_bad_boundary: Native provider emitted wait_for after completed browser results; the underlying cause remains unresolved
symptoms:
  - "Timeout after 901s (dynamic cap=900s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - Root selected wait_for ten times after both browser invocations succeeded
tags:
  - completion
  - gpt-auth
  - agentcard
  - causal-replay
sources:
  - PR #1299
  - agent 1c869d97-ec9e-462c-bed9-2073ae2f4561
  - commit 604618bac
repro: none-recorded
status: open
---

## Problem

Unchanged local AgentCard gate run `2bbf5c56-1a9c-459b-91c3-d28e7d31eda7`
failed `agent-payment-idempotent-abandonment`: the root remained ACTIVE until
its 900-second cap, with a recorded duration of 907.8 seconds including final
observation. The other three lifecycle tasks passed. Payment workers were on
`604618bac`; the worker-port repair committed during this run did not hot-reload
them. The benchmark catalog, evaluator, fixtures, timeout and concurrency were
unchanged.

Both sequential browser invocations succeeded. The first prepared the exact
cart and card without submitting. The second independently obtained the
matching card and confirmed paid order `tp_70a51acd` around 00:32 UTC on
September 11. The root then emitted ten `wait_for` calls and never invoked
`attempt_completion`. Both approvals were resolved. Canonical benchmark
cleanup preserved diagnostics and then tore down the isolated stack.

The run record is
`agents/benchmarks/runs/20260911_004625_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json`,
with its sibling diagnostics directory. The first incorrect execute call is
`.llm-dumps/1c869d97-ec9e-462c-bed9-2073ae2f4561/1789086779541-e19df5ec44b5-execute_loop.json`.
Private preserved logs, replay commands, outgoing requests and raw SSE are in
`.context/acceptance/payment-idempotency-rca/`, restricted to mode 0600.
Do not publish their raw contexts or credentials.

## Diagnosis

This remains an **open causal investigation**, not a model-intelligence diagnosis
or a demonstrated production-code defect. The unresolved problem class is
causal classification: the observed bad tool choice is located, but the
condition producing it has not been isolated.

Path: completed browser results → root execute context and six-tool schema →
Rose native GPT request → provider SSE → Responses decoder → `wait_for`
dispatch → benchmark timeout.

Required latency and cache summaries ran together. The benchmark's retained
`agent_logs.txt` supplies its tree summary (125 messages at diagnostic capture).
Manual diagnostic tree queries returned an archive-index warming 503; those
requests were not used as evidence for the task failure. Latency captured
4653 spans over 908.4 seconds; browser success and short HTTP operations do not
support a database stall as the cause of the later repeated waits.

The recorded context explicitly advertises parameterless completion. The task
requests completion after the second browser invocation and forbids progress-message tools. There is
no prior-context statement that completion is unavailable. The model's reasoning
summary suggesting unavailability is not evidence of a missing declaration.

Captured-input replay reproduced the wrong selection:

```bash
agents/venv/bin/python scripts/replicate_llm_dump.py \
  .llm-dumps/1c869d97-ec9e-462c-bed9-2073ae2f4561/1789086779541-e19df5ec44b5-execute_loop.json \
  --mode exact
```

The replay used the captured GPT credential and `gpt-5.6-sol-gpt`, and again
returned `wait_for`. The repository replay tool changes its tracing call-site
and cache identity; this is not a claim of identical historical provider state.
Output was redirected privately, never pasted as raw context or credentials.

A diagnostic wrapper then captured the actual request and raw SSE while passing
unchanged bytes into the existing decoder. It restored the original messages,
native tool declarations, model, credential, xhigh effort and provider settings:

```bash
agents/venv/bin/python \
  .context/acceptance/payment-idempotency-rca/reduce-native-tool.py full
```

All 11 message text parts survive translation; both browser results retain paired
native function-call outputs. The request includes all six tools, the exact
zero-property completion schema, and `tool_choice=required`. Raw SSE emits only
`wait_for` (163 argument characters), and the decoder returns that same call.
No completion call is dropped in this reproduction. Safe structural evidence is
`wire-summary.json`; request and SSE files remain private.

Reduced forced-selection controls (`reduce-native-tool.py forced` and
`reduce-native-tool.py two forced`) differ only in their declared tool lists.
Both emit and decode parameterless `attempt_completion` with `{}` arguments.
They falsify deterministic inability to transmit or decode that tool. Earlier
unforced full-six probes selected a progress-message tool, while a two-tool
probe selected completion; these single trials do not establish a deterministic
tool-count or schema defect. An earlier uninstrumented forced probe returned
zero calls, but that outcome was not reproduced under wire capture. Keep it as
a separate unresolved lead: a reasoning-only truncated stream is possible in
the current decoder, but no captured event sequence proves it occurred here.

A previous passing exact task (`9493579d-33de-43ab-bfba-1f13e29fa639`, 438.3 s)
used OpenRouter `openai/gpt-5.6-sol`. That changes transport relative to this
native GPT run, so the comparison cannot establish model intelligence. The next
causal test is a bounded, predeclared alternating comparison (for example,
five original-model and five stronger-model calls on the same endpoint),
changing only `model`, capturing complete requests and SSE, and asserting
completion selection without executing returned tools.

Archive searches used `agent-payment-idempotent-abandonment timeout`,
`payment repeated card request waiting`, `Codex tool unavailable function declaration`
and `attempt_completion wait_for loop`. The June 29 user-reply wait case and
July 17 completion-summary invalid-request case are relatives, not established
recurrences: no user response was missing and completion was never dispatched.
Independent adversarial review confirmed the wire/input checks and approved
these findings only as an open investigation.

## Solution

There is no supported payment-runtime fix, causal red/green regression, or
post-fix exact benchmark pass. No prompts, runtime schemas, routing, recovery,
tool nudges, cache contents, task contracts, timeouts or concurrency were changed.
Forced selection was a diagnostic control only; no payment tools were executed
by the replays. A later unchanged gate pass establishes that run's outcome and
must not retroactively close this causal investigation.

The same unmodified task later passed in 375.1 seconds on `50284e1e`, agent
`8b48ad6e-3ec1-452f-a71e-c2f57dc017d7`, in run
`dbd2a71a-6ced-403b-adf8-75dfeedc6d0c`. That run passed all four AgentCard
lifecycle tasks. The worker-port repair landed between these runs; no
completion-selection repair did. This later outcome does not establish the
cause of the earlier repeated waits, so this case remains open.

The canonical evidence publisher verified the later
[passing task and browser recordings](https://www.roselabs.ai/?agent-id=8b48ad6e-3ec1-452f-a71e-c2f57dc017d7),
including 106 messages and every browser's terminal state and recording.

The archive itself previously required an asserted cause even for unresolved
cases. Its validator now accepts `classification: undetermined` only with
`status: open`. The existing archive structural suite reproduced rejection of
a valid open/undetermined case before the repair and passes afterward; it also
rejects undetermined classifications for fixed, mitigated, wontfix, superseded
and invalid resolved statuses, and preserves unknown-enum rejection. This
repairs honest recordkeeping, not the payment timeout. No per-agent runtime
state, polling or work was added; 10k-agent behavior is unchanged.

## Human feedback

The user authorized completing the work without repeated permission requests
and required ten sequential cloud slices with no infrastructure failures. No
benchmark definitions or acceptance criteria were relaxed.

## Reusable lesson

Compare native provider wire events with decoded calls before treating a
completion stall as a missing tool, parser defect or proven model limitation.

### Follow-up: repeated failure and bounded affinity controls

The unchanged four-task gate on `10e8df231859970a3db513fbf39ae260d934c592`
ran as `406e6853-7bee-4c44-9282-1771934adc9f`. Three tasks passed; idempotent
abandonment, root `bf9b2c89-9c5d-4fb6-916f-8c433ec814f2`, failed after the
unchanged 900-second cap (908.1 seconds including final observation). Its
payment snapshot was settled: purchase CLEARED, wallet CONSUMED, Stripe charge
succeeded with zero capturable balance, and the issued card CLOSED with zero
balance. No open payment attention or refund remained.

After two successful browser invocations, two native GPT responses reached the
length limit without selecting tools. The root then delegated three formatting
or consistency checks of the already obtained checkout results. Its final
captured execute call selected `attempt_completion` through Claude, too late
for the root to become COMPLETED within the budget. All eight root execute
calls retained the same six-tool contract, SHA-256
`bc7e0d23ef0b87a4a6d992d34d9577e2cf59f08ac5ce3cdd718d4ec3db885f82`.
Some delegated children also recorded TLS bad-record-MAC and unclosed-session
errors. Those observations do not establish a missing completion declaration.

Bounded captured-input controls executed no returned tools:

- Three original-model and three stronger-model calls alternated on the same
  endpoint, changing only the model in a body reconstructed through the native
  builder. All six selected `attempt_completion({})`. This does not support a
  model-intelligence diagnosis.
- A full-client replay advertised all six functions with `tool_choice=required`.
  The raw provider selected `wait_for`, and the decoder preserved that call.
- Those reconstructed bodies differed only in `prompt_cache_key`. The transport
  also derives three routing headers from that key. Six subsequent requests
  alternated this coupled affinity condition while holding model, endpoint,
  authentication, input, instructions, tools and generation settings constant.
  The client-derived affinity selected completion in zero of three requests
  (one wait and two incomplete/max_messages responses); the direct-builder
  affinity selected completion in all three. Every response was HTTP 200.

The common body excluding affinity had SHA-256
`945b2b12bf347d3165bcace394034ade2a5be9708fcf37be177a6e523be5e716`.
This demonstrates affinity-dependent behavior in these captured-input controls.
It does **not** capture or reproduce the historical wire identity: production
passes an explicit `cache_sequence_id`, whereas these replays used the fallback
namespace, and dump serialization removes an internal system boundary used in
cache-scope hashing. The cache key and derived routing headers are one coupled
condition, not independently isolated causes. No cache busting, routing change,
model substitution, timeout increase or prompt repair is justified by this
comparison. Provider handling remains an open causal gap.

The next unchanged control, run `19624b67-ae9e-4228-8b1c-9e55945fbb67`,
passed this exact idempotency task in 323.5 seconds, root
`8df0d54d-4891-4935-becf-9df8a7450ff0`. A later pass establishes that run's
outcome; it does not close this case. The full gate passed all four tasks; the final abandonment task passed in
231.0 seconds. No runtime completion-selection change preceded this control.

Raw requests, SSE, captured dumps and credentials remain private under
`.context/acceptance/idempotent-gate5-observation/`,
`.context/acceptance/idempotent-gate5-replay/` and
`.context/acceptance/idempotent-gate5-affinity-replay/`. Read the replay README
for the exact controls and limitations. The canonical publisher verified the
[failed task's browser terminal states and recordings](https://www.roselabs.ai/?agent-id=bf9b2c89-9c5d-4fb6-916f-8c433ec814f2).
The case remains **OPEN / undetermined**; no completion-runtime repair landed.
