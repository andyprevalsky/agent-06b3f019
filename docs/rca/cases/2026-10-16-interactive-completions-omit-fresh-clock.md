---
id: 2026-10-16-interactive-completions-omit-fresh-clock
date: 2026-10-16
title: Chat searched a past year because interactive model requests lacked fresh runtime clock context
surface: back-end
component: interactive-completion-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Chat Router completion messages contain static instructions and history without a server clock; reconstructed live request reproduces the stale-year query
symptoms:
  - "OpenAI Codex open source components 2025"
  - "is codex open source? what parts of it are closed source?"
  - "model thinks its 2025"
tags:
  - chat
  - sms
  - calendar-grounding
  - runtime-context
sources:
  - agent 44006441-c576-4982-9c9a-b4efc210fb71
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
  - plan:docs/plans/completed/sms-supervisor-time-zone.md
repro: back-end/src/tests/blackbox/llm-stream-contract.blackbox.ts
status: fixed
---

## Problem

At `2026-10-16T19:57:34.887Z`, a MAC_APP chat root asked exactly:
`is codex open source? what parts of it are closed source?`.
Its first `web_search` result records the query
`OpenAI Codex open source components 2025`. The user requested current time
grounding for both SMS and chat, suggesting an initial assistant message.
This proves a stale-year query, not the model's literal internal belief.
The agent had no Temporal workflow and no spawned browser agents.

Runtime evidence was fetched read-only through the existing agent API and
`agents/benchmarks/agent_logs.py`. Private full transcript and replay artifacts
are in `.context/rca-time-grounding/`; no personal contact details are copied
into this case. The incident is a product chat, not a benchmark task.

Archive searches: `2025 current date chat`, `time grounding timezone SMS`, and
`calendar grounding relative date`. This is a relative of
`2026-08-22-browser-event-ticket-relative-date-without-clock`, whose boundary
is Python's agent prompt builder. It is not a recurrence at that boundary.
The completed SMS timezone plan already supplies UTC and validated user-local
IANA timezone context; that functionality must be preserved.

## Diagnosis

Critical path: user goal -> chat Router request -> Rose direct Cerebras Qwen ->
`web_search` queries -> tool-message persistence -> visible search result.
The Generator uses a separate completion builder. Both originally passed only
the static prompt plus transcript. SMS differs: `buildSmsContext` already puts
an ISO timestamp and optional local clock in a run-local `get_environment`
result. Its reaction/tool LLM can also receive a fresh common clock directly.

The original full production model request is unavailable: the archive listed
only a DB start fixture and two manifests, and backend `llmDump.ts` explicitly
disables production dumps. We reconstructed the opening request from the stored
user message and current canonical Router prompt/options through the same Rose
client, model selection, temperature, schema, token limit and provider route.
This is a bounded reconstruction, not an exact captured-request replay.

Live results (`replay-before.json`, `replay-assistant.json`):

- Before: 3/3 stale-year searches. Two direct `qwen-3.8-27b` samples reproduce
  the incident query verbatim; a hedged GLM sample also uses 2025. Only the two
  Qwen samples count toward the same-model comparison.
- A system-suffix timestamp did not solve the behavior: 3/3 direct Qwen samples
  still selected 2025. A separate second system message also caused a Cerebras 400. Neither candidate is the final implementation.
- Initial assistant-carrier experiment: 3/3 direct `qwen-3.8-27b` samples use
  `OpenAI Codex open source closed source parts 2026`; durations are
  689, 547 and 715 ms. An independent placement experiment, with no system
  suffix, also passes 3/3 direct Qwen samples for the initial-assistant form.

The supported causal statement is that omitted time grounding reproduces the
reported behavior in the reconstructed request and the selected runtime clock
corrects it on the same model. This is not a model-intelligence classification
and does not establish universal model compliance with every date request.

Abstraction climb: wrong-year query -> missing calendar grounding -> no shared
fresh temporal-context contract across interactive completion boundaries.
The next broader class, supplying every volatile external-world fact from one
universal source, is incoherent: such facts require distinct permissioned
sources and freshness rules, whereas current time has one owned server clock.
Unify the three completion entrypoints; do not rewrite queries or classify
particular years, goals or incident keywords.

Golden references actually inspected:

- `claude-code-src/src/context.ts:155` / `:186` supplies an initial current date;
  `src/utils/attachments.ts:1402` appends rollover updates while retaining the
  original cached prefix. Metadata uses a user-carrier reminder.
- `openclaw/src/agents/date-time.ts:71` supplies date and timezone;
  `src/agents/system-prompt.ts:857` places it after the stable cache boundary.
- `hermes-agent/agent/system_prompt.py:489` distinguishes conversation birth
  date from the latest context rebuild date. It is not fresh every turn.
- `codex/codex-rs/core/src/context/current_time_reminder.rs:18` renders exact UTC
  in developer runtime context; the optional reminder is feature-gated.

These support explicit runtime time, source/timezone labeling, freshness, and
separation from stable instructions. The initial assistant carrier was replaced
by the trailing user metadata carrier described below; Rose's CompletionMessage
contract lacks a developer role. Public primary sources:
https://docs.openclaw.ai/concepts/system-prompt and
https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py.
The live upstream OpenClaw docs differ from the local snapshot in precise
runtime-role placement; the shared time-grounding principles agree.

## Solution

The user approved deployment conditionally on avoiding cache busting and
following the golden references. The first-assistant candidate was therefore
replaced before deployment. The final helper appends a **user-role metadata
message wrapped in `<system-reminder>` after the entire existing history**,
matching Claude Code's runtime reminder carrier and the golden tail-insertion
principle. It does not rewrite the static system prompt or any history entry.
Router options (all three stages), Generator options and the SMS LLM share it.
Each completion-boundary invocation refreshes its UTC clock. Provider hedges
within one completion retain that request's snapshot. The prior SMS
`get_environment` snapshot and its IANA/user-local fields are preserved.

Actual-provider-body verification found a second issue: Anthropic's existing
breakpoint selection would cache the changing reminder instead of the stable
history. `rose/cache.ts` now marks a transient runtime suffix with an enumerable
Symbol; Anthropic conversion preserves that metadata and breakpoint selection
skips the marked tail. This uses OpenClaw's in-memory Symbol provenance pattern:
`openclaw/src/agents/embedded-agent-runner/run/runtime-context-prompt.ts:95`.
Symbol keys never enter JSON or provider payloads. Prior system blocks, history
content **and cache markers** remain identical. Responses instructions and
`prompt_cache_key` are identical; its input and both OpenRouter chat routes
retain the complete prior input prefix, with the current clock after it.

Golden tail references actually inspected:

- `claude-code-src/src/utils/attachments.ts:1402` explicitly appends rollover
  reminders without mutating the cached prefix;
  `src/utils/messages.ts:4162` wraps a user metadata message in system-reminder.
- `codex/codex-rs/core/src/session/time_reminder.rs:156` records clock context
  after existing conversation items, using its native developer-role carrier.
- `openclaw/src/agents/embedded-agent-runner/run/runtime-context-prompt.ts:212`
  appends a labeled user runtime carrier without changing existing messages.

This is a transient implementation of the same prefix-preservation principle;
it does not claim identical durable reminder histories to Codex, guaranteed
provider cache hits, or reuse through previously generated outputs. It does
keep the full existing input prefix and explicit cache boundaries intact. No
API keys, model choice, generation settings or output-cache policy change.

Live final-helper evidence (`replay-reminder.json`): all three direct
`qwen-3.8-27b` replies use the current year, including
`OpenAI Codex open source components closed source 2026`; durations are
567, 476 and 450 ms. The Generator returns 2026 for a current-year question
and 2025 for an explicit historical date. SMS selects 2026 for the current year.
An additional real SMS continuation probe answers the user's math question
with 4, then completes all three following sampled rounds without another
send_user_message. No tool side effects or actual SMS delivery were executed
by these model-only probes.

At 10k agents, the helper adds one small suffix and O(message count) shallow
array copying per completion, with one shared Intl formatter. It adds no DB
queries, network calls, timers, polling, per-agent shared state or locks.
Anthropic skips the one marked tail in constant work for this use. Every
existing message remains an identical serialized prefix; prior cache markers
and routing keys are retained. Actual hit rates remain provider-dependent.

The permanent `llm-stream-contract` test captures real outbound provider bodies
with only external HTTP responses replaced. Across all six entrypoints and a
2026 -> 2027 rollover it checks UTC time/calendar consistency, exactly one
trailing labeled reminder, byte-identical existing history, historical dates,
non-mutated inputs and preserved SMS environment tool messages. Native body
checks cover Anthropic cache blocks and history markers, Responses cache key
and input, and both OpenRouter routes. No string/year classifier is added.

The original clock-omission regression failed on the buggy code. The stronger
cache-prefix assertion failed on the first-assistant candidate; the native
Anthropic cache-marker assertion failed before the metadata fix. Their final
unchanged assertions now pass using:

```sh
cd back-end
node --env-file=.env --import tsx src/tests/blackbox/llm-stream-contract.blackbox.ts
```

Private outputs: `cache-before.log`, `cache-native-before.log`, and
`cache-native-after.log`. The normal runner auto-discovers this existing
blackbox domain; `/deploy` executes it under backend coverage. Independent
adversarial review found no production blocker in the final design. Its dump
assertion objection was resolved by comparing the serialized expected payload
because JSON deliberately omits the internal Symbol. The causal fix is verified
locally; rollout and production verification are tracked by the deploy lifecycle.

The existing failover fixture now accounts separately for the one clock suffix
while retaining the original transcript size. The search-escalation fixture
validates and canonicalizes only the dynamic clock, fingerprints the full
remaining provider request, and records fresh actual model responses. Its
failed-lookup case explicitly serves the original unrelated production search
snapshot for every query; assertions retain the search-again and Cloud Agent
escalation contract and verify the persisted snapshot. Fresh search results
had otherwise answered that case, invalidating its no-match premise.

## Human feedback

The user asked to investigate this exact agent, ground both SMS and chat with
current time, and research other agents' approaches. They then approved only
if it is "not cache busting and truly mimics golden refs". The initial
first-assistant placement was rejected by that condition; the final change
uses a trailing metadata reminder and preserves native cache boundaries.

## Reusable lesson

Append fresh runtime time beyond the stable history and its cache boundary, and verify actual provider bodies plus same-model behavior before claiming grounding preserves caching.
