---
id: 2026-11-11-chat-schema-descriptions-invalidated-strict-replay
date: 2026-11-11
title: Shared schema descriptions invalidated strict chat recordings and exposed an unresolved-lookup terminal decision
surface: back-end
component: chat-search-escalation replay fixture and Router action contract
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: chat-search-escalation.blackbox.ts installNetwork missed full-request fingerprints after the shared grep descriptions changed inside the Router response schema
symptoms:
  - chat turn reached an unexpected outbound host
  - https://slack.com/api/chat.postMessage
  - unrecorded request
  - Cerebras 400
  - Chat router completion expired
tags:
  - chat-router
  - strict-replay
  - fixture-drift
  - shared-tool-schema
  - failure-attribution
sources:
  - commit 0b12f8ecba728eae5611061cf87de070bcd9aa32
  - commit 5e5c0114d
  - task chat-router-terminal-contract-2026-11-11
repro: back-end/src/tests/blackbox/chat-search-escalation.blackbox.ts
status: fixed
---

## Problem

The backend deploy gate failed all three existing chat-search-escalation cases
on source 0b12f8ecb. Its reported unexpected Slack host was downstream of a
strict replay miss: the user-required shared grep descriptions changed, but the
provider-request recordings still matched the prior schema. Genuine refresh
then exposed a separate unresolved-lookup direct_answer decision.

Outcome: fixed and verified locally. The parent integrated the exact reviewed
Router files and genuine v2 fixture; combined-source release gates and
production verification remain pending. This case does not claim deployment.
It concerns an existing backend regression suite, not a production report_bug
or a newly invented benchmark. The trigger is summarized here; no raw user
query, complete request, signed evidence URL or private reconstruction path is
part of this committed case.

## Diagnosis

The grep parameter descriptions pass through the strict schema emitter into
the Router's response_format. The test fingerprints the full provider request,
including that schema, with only its documented transport fields and controlled
clock normalized. Changed descriptions correctly produce new fingerprints.
The stale fixture has no entry and returns synthetic HTTP 400, unrecorded
request. The intentionally stalled hedge cannot answer; routing expires,
failure recovery attempts a Slack alert, and assertCleanNetwork reports that
later outbound host before the earlier recording miss.

Gate: INTRODUCED, comparing 0b12f8ecb with owning file
back-end/src/providers/grepTool/grepToolDefinition.json from base 5e5c0114d.
The final source failed 3/3. Restoring only that base file on the same final
source passed 3/3 with identical test and recording bytes. Provider-sync and
connected-label changes remained in the passing copy. This isolates fixture
invalidation rather than a Slack outage.

Two fresh final-schema captures removed the network/fingerprint error, but each
replayed with 2/3 passing cases: the unresolved follow-up chose direct_answer.
Its complete structured reasoning acknowledged that results did not resolve
the request and proposed clarification. A fresh base-definition control instead
continued searching and recorded escalation; its strict replay passed 3/3. That
control's live recording encountered 429s and caller timeouts; the existing
recorder recovered completed responses. It is not a native live three-case
success claim or a NOT_INTRODUCED behavior waiver.

The exact failing Router request was reconstructed with a matching strict
fingerprint and rerun through createStreamingCompletion. The v2 live pair used
the same qwen-3.8-27b model, cerebras-direct path, messages other than the system
action contract, controlled clock, generation configuration and schema shape.
Before: direct_answer in 1,144 ms. After the reviewed contract: web_search in
1,559 ms. Only system-message action wording and the schema action description
differed. A constructed known-progress status request, honestly labeled as a
control, selected direct_answer in 701 ms. No model change or model-intelligence
classification is claimed.

The semantic gap was in separate terminal-action definitions: the post-search
step already prohibited no-match substitutes, but the action list described
simple replies and the schema emphasized representation. The fix shares one
current-request completion predicate across all stages and the schema. The
separate semantic case is
2026-11-11-chat-terminal-action-completion-contract-gap.

Archive searches used chat-search-escalation, unrecorded request, schema
fingerprint, and unresolved lookup/direct_answer/completion vocabulary. Actual
closest cases, including their Solution and Human feedback, were opened:

- 2026-10-12-chat-decided-escalation-before-search-evidence is a relative, not
  a recurrence of its first-bad cause: that path omitted an action-owning
  Router after search. Here the repaired loop observes the results and the
  post-search decision itself is wrong.
- 2026-10-07-chat-router-pointer-as-satisfaction is a relative in completion
  semantics, not a recurrence of missing closed-media instructions. That
  existing representation policy remains present and unchanged. This lookup
  requested a textual result chat could emit if it had the answer.

For the prompt-related repair, Step 5b stopped at a shared terminal-action
completion contract. An independent runtime semantic validator was considered
one level deeper: existing action/reasoning fields do not contain independent
fulfillment evidence. A prose classifier violates the rules; another claim
field or judge adds a second language-based authority without repairing the
contract. Centralizing the existing authority avoids those new branches.

## Solution

Preserve the approved canonical grep definition and strict fingerprints.
Refresh responses through the existing CHAT_SEARCH_ESCALATION_RECORD=1 producer,
which records actual completed provider streams. Keep the historical scenario
inputs and pinned follow-up search snapshot unchanged. Repair the separately
exposed action contract through one DIRECT_ANSWER_CONTRACT used by
chatPrompts.ts and routerDecisionJsonSchema.ts. It names direct_answer
explicitly and requires the reply to satisfy the current request. Progress or
limitation information can be a complete answer when that is what was asked;
it cannot substitute for a different unmet outcome.

The preserved v2 before-source product files equal 0b12f8ecb. Their matching
fresh failing fixture SHA-256 is
`938d82321c23a561987fdb80317bf4813604cf61c8da31970dce87268365dee4`.
That exact source/fixture pair failed the original follow-up assertion with
2/3 cases passing in 6,365 ms. The preserved after-source and matching new
fixture SHA-256
`e786fac6c3a65ba43d66dfab9e9b2fa2ca81d2ba42f0418e4cfabb7a1d45e3f4`
passed all three original cases in 7,599 ms. Both use the canonical runner:
`BACKEND_CODEX_TOKEN_SYNC_SKIP=1 BACKEND_CLAUDE_TOKEN_SYNC_SKIP=1 bash
back-end/scripts/run-blackbox-tests.sh chat-search-escalation` on isolated local
databases. Exact source selectors and SDK invocations are retained privately by
the deploy owner, not replaced by an assertion that an unspecified command ran.

The v2 live capture took 19,160 ms and contained 11 completed responses, all
qwen-3.8-27b, plus two null discarded/speculative requests. Its unresolved
follow-up escalated after four Router decisions; the two resolved cases answered.
Five subsequent unchanged strict replays passed 3/3 in 7,375, 7,370, 7,293,
7,395 and 7,378 ms. Those are five deterministic replays, not five live trials.
Types, scoped lint and formatting passed. The owning suite remains automatically
discovered by the standard backend blackbox runner.

Fresh non-author golden-reference re-review returned GROUNDED for exact gated
patch SHA-256
`b311a03b5dda60acbe7bc78a6b1eba7152b48293610058ea978d794e621ca9b3`.
The controlled after-call Router system-message SHA-256, including the existing
cache boundary marker, is
`c51dd12f73dc949d743c4c3ffb262196e050b61fac13f301dcf3eb18ac26219e`.
The preserved canonical grep-definition SHA-256 is
`ace22e675891ce5ab41d484cbab679052ff336b9ecc9f5964389f631cb4212ef`.
Current locally integrated Router source files and fixture match the approved
v2 snapshot. Approval is scoped to the two reviewed Router files; it does not
waive final combined-source checks or production verification.

Reviewed analogs: Hermes agent/prompt_builder.py:477-483 requires the requested
output and every stated requirement; OpenClaw src/agents/system-prompt.ts:722-725
continues unfinished work, and :750-755 permits requested progress reports;
Codex codex-rs/core/gpt_5_2_prompt.md:111 persists to task resolution. Kimi
packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.ts:6-14
names the enum value governed by its condition. The change converges on these
completion principles without asserting identical harness architectures.

No assertion, task prompt, matcher, isolation boundary, model, timeout, search
budget or concurrency changed. There is no keyword classifier, synthetic nudge,
runtime override, extra schema field or fallback. At 10,000 agents the static
contract adds no extra call, subscription, lock, polling or mutable fan-in.
Continuing unfinished work can consume the existing bounded search/escalation
budget; it is not claimed to be free.

## Human feedback

The user required the exact approved grep-description bytes, genuine provider
capture, strict request fingerprints and unchanged scenario assertions. They
required separate fixture and behavior attribution with a fresh base control,
not a broad infrastructure label or a model-intelligence assertion. Initial
review rejected a shared predicate that failed to name direct_answer inside
the enum description and categorically excluded requested progress replies.
The revised predicate names the action and scopes completion to the current
request; its actual status-request control answers directly. An intermediate
wording failed the exact call and was retained rather than hidden. Review also
required distinct preserved source/fixture selectors and copy-paste SDK and
record/replay commands. Fresh review cleared only the exact v2 bytes above.
Private requests and reconstruction evidence remain outside Git.

## Reusable lesson

Refresh strict recordings through their genuine producer when shared schema text changes, then verify the newly exposed outcome against one explicit current-request completion contract shared by prompt stages and schema.
