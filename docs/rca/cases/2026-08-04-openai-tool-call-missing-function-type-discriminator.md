---
id: 2026-08-04-openai-tool-call-missing-function-type-discriminator
date: 2026-08-04
title: Assistant tool_calls without OpenAI's type discriminator failed the strongest waterfall leg on every SMS round
surface: back-end
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/smsSupervisor/environmentMessages.ts built an assistant tool_call without type function, and providers/rose/types.ts never modeled the field so no serializer added it
symptoms:
  - Tool-call assistant message produced no valid function calls but is followed by tool result messages. The conversation transcript is malformed.
  - OpenRouter google/gemini-3.5-flash returned 400
  - step_failed pool=rose-1-lite step=1 model=google/gemini-3.5-flash
  - every SMS supervisor round logged actual_model=moonshotai/kimi-k2.7-code pool=rose-1-lite
tags:
  - sms-supervisor
  - rose
  - openrouter
  - gemini
  - tool-calls
  - waterfall
sources:
  - memory: Render prod logs 2026-08-04, 100 sampled SMS rounds all served by kimi
  - memory: blackbox run 1785862244-54900-27333 with 32 malformed-transcript rejections
  - memory: blackbox waterfall rerun after fix, 13 rounds served by gemini
repro: back-end/src/tests/blackbox/rose.blackbox.ts
status: fixed
---

## Problem

Every production SMS-supervisor round was served by the last model in the pool.
100 sampled prod rounds all logged `actual_model=moonshotai/kimi-k2.7-code
pool=rose-1-lite`, never the pool's stronger first leg.

Two independent defects stack to produce that symptom, and they are separate
cases. The claudeAuth leg was rejected for its own reason — see
[2026-08-04-sms-claudeauth-rejected-by-anthropic-schema-limits](2026-08-04-sms-claudeauth-rejected-by-anthropic-schema-limits.md).
**This case owns the second hop only:** once a round had fallen off claudeAuth,
the OpenRouter waterfall's strong first leg also failed. Prod confirms that hop
directly — a Render window returns 100 `transcript is malformed` rows with
`step_failed` attributed entirely to `google/gemini-3.5-flash` (50/50 of the
parsed step_failed rows):

Locally, on the same no-compute-token path, `google/gemini-3.5-flash` failed 32
times in one run with an OpenRouter 400 from Google AI Studio:

```
Tool-call assistant message produced no valid function calls but is followed by
tool result messages. The conversation transcript is malformed.
```

Every one of those 16 rounds fell through to the kimi leg. Downstream, that
degraded model answered contact questions with "I checked your contacts and
didn't find anyone named Jane Grepwell" for a contact that existed, and searched
the web instead of delegating purchases.

## Diagnosis

Critical path: `supervisorHandler` -> `buildEnvironmentToolMessages` (synthetic
`get_environment` assistant tool_call + tool result) -> Rose client -> waterfall
-> `buildOpenRouterBody` -> OpenRouter -> Google.

The SMS supervisor injects run-local environment state as a synthetic
assistant/tool pair rather than user text. That assistant message carried
`{"id": "sms-environment-1", "function": {"name": "get_environment"}}` with no
`type`.

A controlled A/B against the live provider, with every other byte identical,
isolates the cause to one field: the tool_call without `type: "function"`
returns 400 malformed; the identical call with `type: "function"` returns 200.

A second probe held `type` fixed and varied the tool surface: both
`response_format`-only and native-tools requests returned 200, which rules out
the schema/tool projection as a contributing cause.

Step 5a ladder:

1. Google rejects the transcript because the assistant tool_call lacks
   `type: "function"`.
2. It lacks it because `buildEnvironmentToolMessages` never set it.
3. It could omit it because `CompletionMessage.tool_calls` in
   `providers/rose/types.ts` did not model `type` at all, while the streaming
   response type in the same file requires it. No constructor was obliged to
   emit it and no serializer added it. Anthropic's transform reads
   `.function.name` directly, so the defect stayed invisible on the only path
   with coverage.

Rung 3 is the deepest owned cause: it explains why a constructor could drift
undetected, and the same gap was open to every other message constructor.

## Solution

Model the field, correct the source, and guarantee it at the egress boundary so
no future constructor can reintroduce it:

- `providers/rose/types.ts` gives `CompletionMessage.tool_calls` a
  `type?: 'function'` field. This is documentation only — it is optional, so it
  obliges no constructor. The runtime normalizer below is the actual guarantee.
  Making the bad state unrepresentable (a discriminated union over the nested
  and flat shapes) is the stronger fix and is deliberately deferred: it touches
  every tool_call consumer and belongs in its own change.
- `providers/smsSupervisor/environmentMessages.ts` emits the discriminator.
- `providers/rose/transforms.ts` adds `normalizeOpenAiToolCalls()`, applied at
  **all four** OpenAI-dialect body builders: `buildOpenRouterBody` (waterfall),
  `buildCerebrasChatBody`, `buildOpenRouterCerebrasBody`, and
  `buildOpenRouterFastChatBody`. The fourth is the hedge route armed when
  Cerebras stays silent; its model is `google/gemini-2.5-flash-lite`, the same
  vendor family that rejects the transcript, so it was a live path back to this
  outage. The Responses and Codex builders are unaffected because they project
  messages into `input` items instead of passing `messages` through.
- The normalizer also lifts the flat `{id, name, arguments}` tool_call shape
  that `CompletionMessage` permits and the Anthropic/Responses transforms read.
  Passing it through would have been *more* malformed than the original defect.
- `agents/providers/rose/transforms.py` gets the mirrored normalizer in
  `transform_messages_for_openai`. The Python path was safe only by convention
  (its single producer hand-writes the field) on the far higher-volume agent
  surface; ClickHouse shows 0 occurrences there, so this is enforcement of an
  invariant rather than a fix for an observed failure.

Deliberately not shipped: an earlier attempt also projected the response_format
envelope into native OpenRouter tools. The second probe proved that was not
required for this bug, so it was reverted rather than kept as unjustified
complexity.

At 10k agents this is strictly cheaper: it removes one guaranteed-failing
provider request per LLM call and stops routing traffic to the most expensive
fallback leg. No new queries, locks, or per-agent state.

### Detection gap

`src/tests/structural/sms-environment-tool.test.ts` was a dedicated test for
these exact injected messages — and it asserted only the *Anthropic*
projection. That is precisely why the defect shipped green: the one construct
with bespoke coverage had coverage that structurally could not see the OpenAI
dialect. It now asserts both dialects.

### Verification, with unchanged assertions

- Live repro through our own client with `provider_route=openrouter-waterfall`,
  the production SMS schema, and the production environment injection. Before:
  gemini 400 malformed, `served_by = moonshotai/kimi-k3`, FAIL. After:
  `served_by = google/gemini-3.5-flash`, PASS.
- Permanent blackbox in `rose.blackbox.ts` — table-driven across all four
  builders and both tool_call shapes. Verified failing on each reverted hunk
  independently: reverting the fast-route call site fails
  "buildOpenRouterFastChatBody must stamp the discriminator"; reverting the flat
  shape lift fails "must stamp the discriminator on a flat name/arguments
  tool_call". 71 passed / 0 failed with the fix.
- `sms-environment-tool.test.ts` fails "environment tool_call must carry the
  OpenAI type discriminator" on the reverted code and passes after.
- `agents/tests/blackbox/rose.blackbox.py` gains the mirrored case; it raises
  `KeyError: 'type'` on the reverted Python transform and passes after (150
  cases).
- Full unchanged real-LLM SMS acceptance on the waterfall path: 0 malformed
  rejections (was 32), all 13 rounds served by `google/gemini-3.5-flash` (was
  100% kimi), and the real-LLM contact-grep case now passes.

Caveat on that last line: those real-LLM cases are gated on
`BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1`, which no recurring suite sets, so it is a
one-time manual observation and not cemented coverage. The deterministic tests
above are what actually run on every deploy.

### Bundled change disclosed

The same branch swaps the rose-1-lite last-resort leg from
`moonshotai/kimi-k2.7-code` to `moonshotai/kimi-k3` at user request. Verified
against the live OpenRouter models API: k3 is $3.00/$15.00 per Mtok vs
k2.7-code's $0.74/$3.50 — roughly 4x. That is unrelated to this cause, and it
means the pre-fix repro line reads `served_by = moonshotai/kimi-k3` where prod
ran `kimi-k2.7-code`. The repro's assertion is "the gemini leg serves", which is
independent of which model sits behind it, but the difference is recorded here
rather than left implicit.

Still open and explicitly not fixed here: the real-LLM purchase case still times
out on this path. Post-fix Gemini reasons "I will search the web for the best lip
balms" and runs four `web_search` calls plus `send_user_message` instead of
`start_new_agent`. That is a tool-selection symptom on a now-correct transport,
tracked by
2026-08-03-sms-purchase-request-never-delegated-to-start-agent.

## Human feedback

The human rejected the earlier framing that the SMS path was the claudeAuth
path, pointed out that the repro was not exercising the model production
actually uses, and required the RCA be redone against the real waterfall path.
They had previously rejected prompt-text fixes for SMS tool selection as
overfitting, which is why no prompt change appears here.

## Reusable lesson

When one provider accepts a message shape and another rejects it, suspect a
field your own type never modeled, and normalize at the egress boundary so no
constructor can drift again.
