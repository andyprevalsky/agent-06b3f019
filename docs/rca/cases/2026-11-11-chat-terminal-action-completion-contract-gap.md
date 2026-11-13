---
id: 2026-11-11-chat-terminal-action-completion-contract-gap
date: 2026-11-11
title: Router selected a terminal direct answer for an unresolved lookup despite its post-search rule
surface: back-end
component: chat-router terminal-action contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: chatPrompts.ts and routerDecisionJsonSchema.ts exposed incomplete and separate definitions of the terminal direct_answer action while the post-search step required resolution
symptoms:
  - direct_answer
  - a search that did not find the manga must start the Cloud Agent
  - No clear match in the results
  - Searched a few angles and nothing matched that exact combo
tags:
  - chat-router
  - completion-contract
  - unresolved-search
  - clarification
  - shared-policy
sources:
  - commit 0b12f8ecba728eae5611061cf87de070bcd9aa32
  - commit 5e5c0114d
  - task chat-router-terminal-contract-2026-11-11
repro: back-end/src/tests/blackbox/chat-search-escalation.blackbox.ts
status: open
---

## Problem

Genuine recordings using the final shared tool schema exposed a separate
behavior defect after strict replay lookup was repaired. The Router explicitly
reasoned that available results did not identify the requested item and that it
should ask for more details, then chose direct_answer. The Generator produced
a no-match reply. Two independent live captures replayed with 2/3 cases passing;
the unchanged unresolved-follow-up assertion failed in both.

The revised contract was integrated locally after fresh non-author
golden-reference review returned GROUNDED for patch SHA256
`b311a03b5dda60acbe7bc78a6b1eba7152b48293610058ea978d794e621ca9b3`.
Combined-source release and production verification remain pending. No universal
model-correctness result or model-intelligence limitation is claimed.

## Diagnosis

Path: completed search results -> post-search Router -> direct_answer ->
Generator reply. The post-search Router does receive the results and has search
and escalation available. Its Step 2 already prohibits replacing an unresolved
lookup with a no-match reply. The gap is therefore not absence of that rule.
The action list still defined direct_answer through examples of simple replies;
the schema's action description focused on emitting the requested
representation. These separate action definitions did not share a complete
current-request fulfillment predicate with the post-search rule.

The exact failing request was reconstructed from retained context, schema,
configuration and response, and its strict fingerprint matched the captured
request. A live call through the same SDK client reproduced the same terminal
action. The revised candidate changed only the system action contract and the
schema's action description; model, provider path, context, controlled clock,
generation configuration and schema shape stayed fixed. The paired live call
then chose web_search. An actual known-progress status-request control chose
direct_answer under the same revised contract.

A fresh base-definition control, holding the original scenarios and the
follow-up's pinned no-match snapshot, continued searching and produced an
escalation response. Its fresh strict replay passed 3/3. Its native recording
also encountered provider 429s and caller timeouts; the existing producer
recovered completed responses. This is not a claim that the base native live
three-case run passed its caller deadlines. The control did not establish the
same unmet-outcome failure on base, so no NOT_INTRODUCED behavior waiver was
created. No model was changed and no model-capability classification was made.

Archive searches used chat terminal direct_answer, no-match escalation,
completion, and strict replay vocabulary. Closest relations:

- 2026-10-12-chat-decided-escalation-before-search-evidence is a relative, not
  a recurrence of its first-bad cause. That incident lacked any action-owning
  Router after search. Here that repaired loop runs and observes the results;
  the newly captured post-search decision itself is wrong.
- 2026-10-07-chat-router-pointer-as-satisfaction is a relative in completion
  semantics, not a recurrence of its missing closed-media contract. That
  existing representation policy remains present and unchanged. This incident
  concerns an unresolved request for a textual result that chat could emit if
  the result were known.
- 2026-09-30-chat-router-finaltext-killed-create-on-empty-failover concerns
  parsing/deadlines. The owning semantic failure here is a complete, valid
  structured decision, not an empty stream or timeout.

Step 5b stopped at a shared terminal-action completion contract across every
stage and the provider schema. A more general independent runtime semantic
validator was considered: existing fields contain an action and reasoning, not
independent fulfillment evidence. A prose classifier would violate the rules;
a new claim field or judge would add another language-based completion
authority without repairing the action contract. The candidate centralizes the
existing authority instead of adding a guard, fallback, model switch or stage.

## Solution

The isolated revised candidate defines one DIRECT_ANSWER_CONTRACT and uses it
in all Router stage action lists and the structured action description. It
explicitly names direct_answer, requires the reply to satisfy the current
request, and directs unfinished research or missing-information work to the
available search/escalation paths. Progress and limitation information may
fully answer a request for that information; they are excluded only as
substitutes for another unmet outcome.

Fresh capture under the revised candidate answered the two resolved cases and
continued the unresolved case to escalation. The unchanged original three-case
suite passed five consecutive strict replays. Independently executed preserved
before-source plus matching fresh failing fixture failed the follow-up;
preserved after-source plus matching genuine fixture passed 3/3. Types, scoped
lint and formatting passed. Existing tests preserve all prompts, assertions,
strict fingerprints, isolation, model settings, search budget and timeouts.

Reference comparison: Hermes agent/prompt_builder.py:477-483 verifies every
stated requirement and requested output; OpenClaw
src/agents/system-prompt.ts:722-725 continues unfinished work and varies weak
results, while :750-755 allows requested progress reports; Codex
codex-rs/core/gpt_5_2_prompt.md:111 persists to task resolution. Kimi
packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.ts:6-14
explicitly names the enum value governed by its condition. The candidate
converges on those principles without claiming their architectures duplicate
Rose's Router/Generator pipeline.

At 10,000 agents the change adds one static shared description and no extra
LLM call, subscription, lock, polling loop, shared mutable counter or fan-in.
Continuing an unfinished task can still consume the existing bounded searches
and escalation work; it is not claimed to have zero cost.

## Human feedback

Repository instructions and release review required reconstructing the exact
failed call and separating behavior from strict-fixture invalidation. They
prohibit keyword classifiers, fabricated runtime nudges, hidden fallbacks,
changed models/timeouts, blind selection of passing recordings and unsupported
model-intelligence claims. Fresh review rejected the first shared text because it did not name
direct_answer inside the action enum description and categorically excluded
requested progress updates. The revised candidate names the action and ties
completion to the actual requested outcome; a live status-request control
verified the distinction. An intermediate wording still failed the exact call
and was preserved rather than hidden. Review also required executable distinct
before/after source-and-fixture selectors and exact SDK commands. All private
request contents, raw user content and reconstruction paths remain outside this
committed case. Fresh review cleared all three findings for the exact revised
snapshot, which was then integrated locally; release verification remains open.

## Reusable lesson

Give every terminal action one explicit current-request completion contract shared by its prompt stages and schema, while distinguishing requested status information from substitutes for unfinished outcomes.
