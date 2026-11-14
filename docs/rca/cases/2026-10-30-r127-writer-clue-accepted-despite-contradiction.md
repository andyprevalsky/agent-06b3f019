---
id: 2026-10-30-r127-writer-clue-accepted-despite-contradiction
date: 2026-10-30
title: BU098 verifier accepts White Mischief while acknowledging the unmatched writer clue
surface: agents
component: browser-verifier-semantic-verdict
classification: unresolved
problem_class: other
first_bad_boundary: Final captured browser verifier returns task_completed true despite acknowledging that the proposed film does not satisfy the writer clue
symptoms:
  - White Mischief writer clue is unsupported
  - First verifier task_completed false becomes true
  - Native COMPLETED progress1 but declared C1 FAIL
tags:
  - r127
  - it30
  - polar-bu-098
  - verifier
sources:
  - commit 691b9059a9ca3b41552be9679d712b50edcf24d5
  - agent 3d7b3db2-d78f-4082-85b1-deb6251ba876
repro: Original captured verdicts through exact parser and handler gate reproduce false then true acceptance; no causal repair tested
status: open
---

## Problem

It30 BU098r1 completes natively in810.3seconds with progress1 but fails C1:
White Mischief does not satisfy the requested writer's evangelical-Christian
and return-to-acting clue. C2/C3/C4 pass. Original benchmarkFAILED and all
grades remain unchanged. Archive
`b0ef83bb314770c136278f51e76a4b4a49c5158cd3cadfef5b43ba89bbc02882`
and all seven normal manifest members were independently verified.

## Diagnosis

Schema-author output worker121, SHA256
`6a28fa911ac7aa5b7b5436a736a7071b44b77e94c937e911ea32f016090e6ccb`,
requires generic movie_name matching runtime, director and writer clues. It
adds no specific film/person. Original pages identify screenplay writers
Michael Radford/Jonathan Gems and source-book author James Fox the journalist;
the evangelical actor James Fox is a different person. The actor investigates
this mismatch, rather than a transport failure silently substituting a name.

First verifier output17565, SHA256
`26c9b2529aeed7c137ac3b1e29d9f6ea19633706cdc09f808450ba8906715b92`,
returns White Mischief but task_completedfalse/score0, explicitly rejecting the
writer clue. Saved message79 relays that rejection and the actor continues.
Final output26852, SHA256
`5479def5aba7dc561942d20d079f4f746db57f50446a11f4fe7c8ec296f3850d`,
returns the same title and acknowledges the mismatch, yet says
task_completedtrue/score1. Inputs16929/25088 have byte-equal system messages,
including the rule requiring grounded completion of the original goal.
Additional evidence differs; no removal of the writer requirement was shown.

Exact691b llm.py SHA`c10b7aaad3cdf9cdd08b1213c2fe8fdc2b53263a49539041c6cb46c84c69f59c`
requires StrictBool, preserves the verdict, and caps non-true completion.
Handler SHA`568e54fadc4067fcac6b2741bb8b610cee9c813a198e04633641a7c71a7db831`
at12055 requires both score>=1 and task_completed isTrue. An offline replay of
the exact extracted parser/admission functions and handler expression keeps
the first response incomplete and accepts the final response unchanged;
string/number/null flags reject. This is not a full activity or model replay.
No typed failure field was discarded. The unsupported clue is free-form
reasoning while the model explicitly supplies a positive semantic verdict.

Normal browser close27414 and rootCOMPLETED27515 follow successful work.
No positive unrecovered operational transport failure was established. R119 is
not the demonstrated mechanism. Two archive searches and prior partial-verdict,
requirement-version and supplied R116/R117 cases were reviewed. R116 shares
the film but fails retained intermediate claims under C3; R127 is a distinct
final semantic acceptance under C1. The local search index was older than691b.

## Solution

OPEN: no general causal runtime repair established. Do not infer the task is
unanswerable merely because this candidate fails; no alternative film was
proved here. No reason-text regex, forced title, schema weakening, added judge,
prompt patch, timeout change or grade promotion is justified by this record.
A general verifier correction requires separate causal/compatibility evidence.
No model/provider/native call, source application or controller stop occurred
in this investigation. The original false-positive is preserved.

## Human feedback

The user prioritizes native failures, progress0 and schema/validator flow while
requiring every failure to remain tracked. This does not authorize changing
the original task or ignoring its writer clue.

## Reusable lesson

A strict typed completion flag prevents coercion and missing-verdict success;
it cannot by itself make a model's semantic verdict consistent with the
evidence. Trace the original verdict through its consumer before adding a
deterministic gate for a field that was never discarded.
