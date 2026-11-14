---
id: 2026-10-30-it27-bu100-schema-anchor-and-retained-count
date: 2026-10-30
title: BU100 schema names an unspecified Pokemon before a later false count and answer mismatch
surface: agents
component: schema-author-and-browser-trajectory
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Schema author inserts Mime Jr. as the unnamed second Pokemon; causal effect on the later answer remains unproved
symptoms:
  - common_ability schema names Mime Jr.
  - two base 60 Pokemon with Intimidate
  - final Intimidate differs from declared Defiant ground truth
tags:
  - r117
  - polar-bu-100
  - schema-author
  - retained-claim
sources:
  - commit 98c8668b47b5e9b2fd2b807c2f083f2e46a04733
  - agent 3d401d83-4901-4223-940c-3e2bf400401d
repro: none-recorded; hash-bound original schema actor and verifier payload comparison
status: open
---

## Problem

It27 BU100r2 completes natively in987.0seconds with progress1 but fails two of
four declared rubrics. C1/C2pass; C3 rejects a retained exhaustive count and C4
rejects final Intimidate against the declared Defiant ground truth. Original
producerinfraFALSE and all grades remain unchanged. Neither a supported subset
of pages nor the final browser verifier supersedes that C4 result.

The user supplies an indirect Pokemon identification puzzle: a Kanto Pokemon
with a later-added type, a related second Pokemon, and a2023 competitive format
allowing a post2018 legendary. The question asks for a common stat-related
ability among speed-tied Pokemon. It does not name the second Pokemon.

## Diagnosis

All seven normal files independently match manifest lengths/SHA256. Normal run
SHA256 is
`7598f099e3a3f5719d9ff376d2f3d18137a1c1c49e1e347b126b3d8dc17226ca`;
worker SHA256 is
`ae0dea29c97b724b6aa8726159f09c68e4eeca0f2fb95b49eefdb2da2dbf11f6`.

The earliest observed semantic specialization is raw schema output worker77,
SHA256 `b19d4e9dcb637ee0a1b513321c490846c8e349e08cbd36ec4d9fc0ed1e037a6a`.
It names the otherwise unspecified second Pokemon as Mime Jr. in the required
common_ability description. Its reasoning calls Mime Jr. base speed63;
original later Pokemon Database observations give60/max240. The description's
Mime Jr. specialization survives into actor system instructions and the final
verifier schema. Reasoning63 is not part of that persisted field. This is an
answer-anchoring lead; no unanchored-schema control establishes that it caused
the final answer. The actor also explores other entities and formats.

Original message74 (judge75) states “There are two base60 Pokemon with
Intimidate: Growlithe and Incineroar,” within a longer exploratory passage.
Browser-use-step14 raw output worker16076, SHA256
`f4a6caae42cba69f3faf6dbc003bbd4da86dcd22ba4bf45c9c402e585b767e7d`,
has action.thinking exactly equal to the persisted text. No observed parser or
persistence mutation creates the count. Later Luxio and Herdier observations
(messages131/136; judge132/137) each show Intimidate and Speed60/max240, which
contradicts the stated exhaustiveness. The actual count assertion, rather than
mere exploratory uncertainty, is the C3 discrepancy.

Final browser-verifier input worker20508, SHA256
`1b16c497f87c7704a8bb088511e6ca183a6e54d4606b35c9a59f821e4d8961bb`,
contains the selected Mime Jr. group, Luxio/Herdier evidence, and mentions of
Defiant. It omits the exact false “There are two” passage; its rubric explicitly
excludes actor reasoning. A search mentioning Defiant is not proof of the
answer. Output worker20518, SHA256
`ddb03bc790cfcf84b5fcb858f9fcc7125ce9f5a9537b56595226fa1c266efc7c`,
returns Intimidate/task_completedtrue/score1 using Mime Jr., equal maximum
Speed240, and National Dex usability. This validates the selected chain under
the supplied schema; it does not resolve all original indirect predicates or
why C4 expects Defiant. Do not rewrite the original failure from this verifier
score.

Two searches used Pokemon/ability/speed and unsupported schema-specific-answer
terms. The available local archive index was older than98c and gave no exact
causal precedent. Supplied retained-city/R113 cases are related claim patterns,
not proof of a shared runtime cause. The streamed-commentary parsing case is
contrary: here actor output and persisted claim agree.

## Solution

OPEN. No runtime patch or causal outcome reproduction. A controlled comparison
would need to distinguish schema anchoring from the actor's independent
interpretation and establish the intended puzzle chain. Neither was run under
the no-model-call instruction. No forced Defiant output, prompt nudge, schema
edit, reasoning suppression, cap change or evaluator bypass is proposed.
The decoded original application payloads were independently size/hash checked;
this is application-boundary evidence, not raw vendor-wire parity or proof of a
model capability limitation.

## Human feedback

The user prioritizes native failures, zero progress and schema/validator data
flow while requiring all failures, including semantic evaluator failures, to
remain tracked. This priority does not authorize discarding C3/C4 or changing
the answer to match ground truth. No new runtime or model operation was made.

## Reusable lesson

Keep schema-author assumptions, actor assertions and final-output verification
separate, and prove their causal connection before repairing a failed puzzle
with a prompt or schema change.
