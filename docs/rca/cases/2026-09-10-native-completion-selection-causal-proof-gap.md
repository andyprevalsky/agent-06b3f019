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
