---
id: 2026-10-28-it13-bu052-conflicting-foster-availability-accepted
date: 2026-10-28
title: BU052 verifier accepted foster availability despite retained contradictory profile evidence
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Browser verifier acknowledged that Malyk was already in foster and offered for adoption but still declared the requested foster search complete
symptoms:
  - Native root COMPLETED while all three benchmark rubrics failed
  - Foster board category and individual profile availability conflict
  - Verifier reasoning acknowledges the conflict and includes Malyk anyway
tags:
  - r33
  - it13
  - semantic-verdict
  - conflicting-evidence
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 4775d90b-1e44-4a89-87a8-216fbc6c78eb
  - fleet run 20261028-230247-3988091
repro: none-recorded; original evidence proves the semantic decision but no safe general runtime repair
status: open
---

## Problem

Original assignment clock23:18:39.639949Z is retained. Jobr001-j0002,
polar-bu-052 run1, browser taska955e84b-3e2e-5694-b311-44c5cba0954d.
Native completion is not benchmark task success. This case preserves original
FAILED,0/3rubrics and infra=false. No task or schema changes were made.

## Custody and outcome

ArchiveSHA6fc3396763299d866237df9652732c82cb304fb429602b8f28deb5c57427f21d;
all7 normal-runtime members independently match supplied binding hashes.
ManifestSHA53e6421171b0213af2561b140fe1b95a64769d323b68f925e61f52b727da7030.
RunSHA8234824bcad4bdcd2066f63339b7bd976ba668d3e65d747868d67466e8b48bc6.
Native root statusCOMPLETED, duration211.1s; benchmark_statusFAILED, passedfalse,
0/3 declared rubrics, original infrafalse. These are distinct facts.
The normal packet contains exactly74 persisted messages (indices0–73).
No mode acceptance verdict is inferred from summary fast-mode flags.

## Diagnosis

The exact user asks for three dogs CURRENTLY available for foster and under six,
not simply three populated profile fields. Output schema preserves that requirement:
foster_dogs.description='Three dogs under six years old currently available for foster, each with a profile link.',
minItems=maxItems=3; each dog_name description also says currently available.

Message32's tool result maps Malyk to a FOSTER ME4–5years board list. Message46
then reads his full individual profile, including the unequivocal later line:
'Malyk is in a foster home and not at the shelter. Email foster@franklincountyohio.gov to Adopt MALYK.'
The same profile also has earlier stale-sounding text about being in the shelter.
The conflict exists in original page data; the investigator does not resolve it
by board membership or assume which content is current.

Message59, browser verifier FINISHED23:11:17.990Z, explicitly acknowledges:
'One caveat: Malyk\'s description says he is currently in a foster home and to email to adopt him, although the board still places him in a FOSTER ME list.'
It nevertheless concludes 'All required fields can be populated from grounded evidence, and the goal is satisfied.'
Message60 publishes SUCCESS and includes Malyk. Root message71 treats the child's
grounded structured response as completion; native root later becomesCOMPLETED.
Allthree benchmark judges reject this same unresolved contradiction: C1end-to-end,
C2substance andC3evidence consistency. OriginalTASKFAIL preserved.

## Evidence reached the verifier

Message59 metadata.browser_verifier_input is a verifier_browser call with3 admitted
text blocks (lengths34433/230/39532); one contains the exact contradiction line.
Original worker6164 captures pre-conversion raw context and also contains it;
worker6186 logs Progress checked1.0/has_outputtrue with the same acknowledging reasoning.
The preconversion and admitted blocks differ, so they are not falsely treated as
byte-identical full requests. No raw model response containing task_completed was
identified in this normal packet. Exact765 source helper downranks absent/false
strict verdict to<=0.5, and handler11793 requires score>=1 plus task_completed isTrue.
Therefore true verdict is a source-path inference from native success, NOT a
claimed captured raw boolean. The supplied admitted text and reasoning suffice
to disprove a simple loss-of-contradictory-text explanation.

## Prior cases

Two archive searches followed raw evidence: contradictory evidence completion
verifier task_completed; foster dog profile board Malyk. Read full prior
2026-10-28-browser-completion-confused-extraction-coverage case. That case lacked
a separate completion verdict and supplied score1 alongside task-not-done.
Current765 already includes the strict completion directive/schema/admission
and handler predicate. It says true only when grounded evidence establishes the
requested work completed, not mere field coverage. Consequently this is not
established recurrence of that removed protocol gap. No title/schema narrowing,
missing minItems, missing evidence or generic timeout is shown here.

## Solution

### Open evidence floor

No safe deterministic runtime patch justified at this intake. Matching foster,
adopt, caveat, negative words, dog count or a reasoning phrase would be a
benchmark-specific semantic heuristic and could reject legitimate informational
answers. Adding another generic instruction without a controlled discriminator
would be a speculative prompt change. The observed firstbad decision is verifier
acceptance despite acknowledged conflicting availability; the current evidence
cannot identify a general transport/schema defect to repair.

Next discriminating evidence would be the exact archived verifier model-response
bytes (if already retained) and a generic semantic-verdict mechanism with controlled
counterexamples; no fresh model call, stronger-model swap, goal edit or regrade is
authorized. Parent can separately consider that design only with causal controls
and fresh exact grounding. This report does not stop at missingpacket: it binds
original goal/schema, profile contradiction, admitted verifier evidence and all
three judge results. Full task outcome remainsFAILED. Tokens UNMETERED.


## Human feedback

The parent required exact original actor/schema/verifier/judge evidence before
classification, no assumed R27 recurrence, and no provider/model/browser or
new capture calls. After review, it requested a single bounded lookup for the
raw verdict followed by this OPEN case. The four existing packet files searched
(worker.log, backend.log, run.json and supplemental batch run.json) contain zero
literal task_completed fields. Raw model verdict therefore remains UNKNOWN;
source-path inference cannot stand in for captured response bytes. No further
archive expedition or speculative patch was authorized.

## Reusable lesson

A verifier can retain and acknowledge contradictory evidence yet still make an
unsupported semantic completion judgment. Distinguish that failure from lost
context or an absent schema constraint before choosing a repair, and never
substitute a keyword rule for unresolved task semantics.
