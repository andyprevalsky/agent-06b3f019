---
id: 2026-10-30-it25-bu084-conference-title-variant
date: 2026-10-30
title: BU084 returns a captured article title variant rejected by the exact-name rubric
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Article-supported selected title reaches final output unchanged but differs from the declared exact event name
symptoms:
  - Native COMPLETED with three of four rubrics passing
  - The Future of Media in the World
  - Exact required name The Future of Media Conference
tags:
  - r100
  - it25
  - bu084
  - title-variant
sources:
  - commit 3dc00896d3b8dcc0b3666c9c8493507ee96c7809
  - agent 1494264e-7e92-45b7-8afb-81f77d4e4006
repro: original evidence inspected; no controlled model replay or task-outcome reproduction
status: open
---

## Problem

Original It25 BU084r2/r002-j0014 ran source3dc00896 with no patch.
NativeCOMPLETED1259.0s/progress1 and cleanup_failure null are separate from the
canonical three-of-four FAILED/infraFALSE. C4 requires exactly
“The Future of Media Conference”; the returned title is “The Future of Media
in the World.” The original result is not regraded.

## Diagnosis

Archive08b705d22fa516158e4c3341cd360588037d84c4ba38c80520cb7adc83b2556c
and normal manifest263e67348b5cb812ab33caae70cc77fbaab3b3a046342aea77d8170c5b431245
bind all seven original members, independently size/SHA verified. The user
requests the conference name using organizer, period and speaker biography;
no event name is supplied by the user.

The actual generated response schema requires nonempty string
virtual_conference_name, described as the requested conference name, and
selects version1 value/text presentation for that field. No schema narrowing
or lossy presentation transformation is established.

Earlier Brave page evidence in message60 at03:03:50.214Z calls the event
“The Future of Media” conference. The actor then explicitly seeks primary
sources to confirm the exact name. Original browser evaluate result message79
at03:13:02.057Z contains the Dubai Government Media Office article at
https://www.mediaoffice.ae/en/news/2020/november/21-11/uae-media-are-early-adopters-of-4ir-technologies-says-vice-chairperson-of-dubai-media-council .
Its captured text says Al Marri spoke at the opening session of “The Future of
Media in the World” conference, organized virtually by Egypt's State Ministry
of Information, and names Miguel Ángel Moratinos among the other speakers.
That is original browser-returned text, not an independent fresh website check.

The verifier pre-conversion context at worker30863 has SHA256
744546419807631c0c9ed4bbfd7e7cb734f479bd0f8f758e5ef7657735f8d926.
It retains both the shorter search-result form and the longer article form.
Worker31164 logs progress1.0 and reasoning that explicitly relies on the
article's longer title, ministry, speaker and date. This is a captured context
and logged verdict, not a claim of complete encoded HTTP request/response
parity or an independently recovered raw task_completed boolean.

The persisted child structured response and root field both contain the longer
title. Final message95 at03:14:22.389Z has identical body, answerText and field
value under explicit value/text presentation. Thus the R78 presentation path
preserves the selected value rather than introducing this mismatch.
The original declared C4 rejects that value against its exact required name.

## Solution

OPEN: no safe deterministic runtime repair is established. The original
article supports the chosen variant, whereas the exact rubric and earlier
search evidence use a shorter form. This does not prove the rubric is wrong,
that the variants are equivalent under the task, or that the model has a
particular intelligence limitation. Selecting a benchmark's required string,
stripping title words, weakening C4 or adding a task-specific prompt rule
would not constitute causal repair. Original task failure remains unchanged.
No runtime edit, new browser/provider/model/DB call or replay was performed.

## Human feedback

After the original trace, searches used “Future of Media conference name” and
“event title exact name unsupported qualifier.” The R87 section of the C3
case and the BU068 same-date paper-title case were read, including Solution
and Human feedback. R87 concerns an invented intermediate claim with a correct
final answer; this record concerns an article-supported final title variant
and C4. BU068 concerns unresolved precedence, not this event-name choice.
Neither proves recurrence, so this distinct original boundary has one case.
The coordinator required original schema/actor/verifier transport inspection
before any family or grader attribution. Tokens UNMETERED.

## Reusable lesson

Preserve competing source title forms and the exact rubric separately; intact
delivery of a source-supported string is not proof of exact-answer acceptance.
