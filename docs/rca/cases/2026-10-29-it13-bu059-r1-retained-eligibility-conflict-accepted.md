---
id: 2026-10-29-it13-bu059-r1-retained-eligibility-conflict-accepted
date: 2026-10-29
title: BU059 r1 verifier accepted retained eligibility and deadline gaps
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Final browser verifier selected Google and Zonta despite retained conflicting graduate eligibility and missing deadline evidence
symptoms:
  - Native COMPLETED while C1 and C2 failed and C3 passed
  - Final verifier returned task_completed true and score one
  - Google eligibility conflict and Zonta deadline acquisition instruction remained in verifier input
tags:
  - r38
  - it13
  - semantic-verdict
  - eligibility
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent fe7e8f00-469a-4f83-8131-0611ef363d6a
repro: none-recorded; hash-bound original request response and output trace only
status: open
---

## Problem

Original assignment clock2026-10-29T00:10:41.187250+00:00 is retained.
Jobr001-j0009, polar-bu-059 run1, source765caac00ce085dd0359b8342161a8717be7446d.
NativeCOMPLETED3026.1s is distinct from benchmarkFAILED1/3 and infrafalse.
C1/C2 failed and C3 passed; no verdict is changed. Duration alone does not
establish an outer-timeout failure.

ArchiveSHA95657501ce2bd5d1dde7ac20e498b01d72727db95bd38edda141136d800ae1fe;
normal manifestde98d4da3019c5fff9b7d36d14b03a5020e0296a4a81af865b339c789316e351;
runSHAfee097c623bce8c40a4509c4c57a8b0d8dfd276124dc44bf426b463bf712425d.
All7normal runtime member hashes were independently verified. Recorded gzip
request/response bodies were decoded locally and checked against their stored
uncompressed SHA256s. No new model or external evidence was collected.

## Diagnosis

Task requests five women-targeted scholarships/fellowships open to female US
citizens in CS graduate programs at USuniversities, with amounts and current or
typical deadlines. Generated output_schema preserves that scope and requires
five scholarship rows and an application_deadline string; no optional omission
or output-schema narrowing is shown.

Message168 reads the Generation Google listing: eligibility high-school senior
or full-time bachelor's program. Other WIGSAT text claims undergraduate or
graduate eligibility. Message190 Zonta sponsor page directs applicants to a club
via Club Locator to obtain its deadline, but supplies no date. These original
contradictions/gaps are not resolved by this investigator.

Actor message203 at23:56:28.935Z explicitly leaves Generation Google out because
listings disagree and calls Zonta a possible backup with club-set deadline.
Its five proposed alternatives have other stated caveats; no claim this actor
answer is a verified PASS is made.

Final browser verifier request6b0ea3082f16 at23:56:35.811364Z,
SHA3ad017c6422dcdd537d4b09e89048c23308249b2c4e71d91fefb27a1f4f1aa71,
contains the actual high-school/bachelor eligibility text and Zonta Club Locator
instruction. Both are in preserved evaluation evidence, not assumed merely
because they exist elsewhere in the raw history. The exact actor203 wording
'I left out...' is not in this request; that absence is recorded separately and
is not necessary to establish retained native contradiction.

Native verifier response23:57:39.171403Z,
SHA80ea92cc985daf4206173c1a25196fc38440842dddb7b9789c8cc271c9bb0467,
returns task_completed=true and score1.0, choosing AAUWtwo/P.E.O./Google/Zonta.
It explicitly notes bachelor's-only conflicting Google eligibility but treats
aggregator support as sufficient. It calls club-dependent Zonta deadline a
grounded non-specific answer. Thus final structured output reintroduces the
Google item and treats a deadline-acquisition instruction as the requested
current/typical deadline. Message217 retains that structured result. C1/C2reject
those deficiencies; C3passes source consistency. No output transport mutation
is observed between verifier selection and final output.

Earlier verifier8a77f5b723fd had task_completed=false/score0.5 and requested more
supported graduate-eligibility evidence; this shows ordinary recovery occurred,
not proof of a correct final semantic verdict. The existing strictbool gate
accepts explicittrue; no missing-verdict compatibility path explains this run.

## Solution

Two archive searches followed evidence: scholarship eligibility conflict verifier;
deadline local club graduate incomplete. Read R31 eligibility case in full with
Solution/Humanfeedback, plus prior child-answer-cap and requirement-version
cases. R31has an AAUWstep excluded by30actionwindow; this run's decisive Google
and Zonta native evidence is present in the final request. Shared subject matter
is not a same-firstbad transport recurrence. R33contradictoryfoster acceptance is
only a semantic-decision relative, not a mechanical proof of common rootcause.

No safe deterministic runtime candidate justified. Eligibility meaning and a
non-date deadline string cannot be policed by scholarship-specific keywords,
reasoning sentiment, unconditional required fields or regrading. A generic
prompt nudge/model swap or history-window expansion would not be causal proof.
The exact firstbad selection is visible, but the safe generalized remedy remains
OPEN. Original taskFAILED is retained; no deadline/cap/criteria changes.

No tests or runtimechanges, no new model/provider/API/browser/DB/image/capture
calls. TokensUNMETERED. Compact original messages, exact raw response and judge
results retained for parentreview; decoded requests locallyavailable.


## Human feedback

The parent accepted retained contradictory eligibility and absent deadline as
an observed semantic-decision floor. It rejected inference of missing-context
causality from the absent actor phrase alone, as well as R31 recurrence from
shared scholarship subject matter. Preserve original C1/C2FAIL, C3PASS,
infraFALSE and nativeCOMPLETED. No keyword filter, forced expected-five rule,
prompt nudge, rubric/model/threshold change or broad semantic platform work.

## Reusable lesson

Trace what the verifier actually received and selected. A filled deadline string
and explicit completion verdict do not establish that the requested eligibility
and date were proved, but that semantic failure alone does not identify a safe
deterministic runtime repair.
