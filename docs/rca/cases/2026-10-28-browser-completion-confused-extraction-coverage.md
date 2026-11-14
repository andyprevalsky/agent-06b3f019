---
id: 2026-10-28-browser-completion-confused-extraction-coverage
date: 2026-10-28
title: Browser terminal admission confuses populated output with completed user work
surface: harness
component: browser-verifier-completion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: check_progress returns extraction score as browser completion authority without an independent task verdict
symptoms:
  - slider_completed false and reasoning says task not completed but score is 1.0
  - browser terminal admission accepts score greater than or equal to 1.0
  - old verifier activity replies lack task_completed
tags:
  - polar
  - browser
  - verifier
  - completion-contract
  - structured-output
sources:
  - commit ca562dd8b9a259800980bbdc2205d873bc657d5e
  - commit f89fb90bdbba728426f34b4e6c1c9a93bfa75c12
  - agent 74d382fc-e192-4e7b-badf-b9d94d5ab8de
  - agent 676a80ea-2cbb-5ce3-9b08-df205dba8b66
  - fleet run 20261028-050809-14876
repro: agents/tests/blackbox/llm.blackbox.py test_browser_completion_rejects_captured_extraction_only_verdict
status: open
---

## Problem

It8 Polar BU018 run1 requested dragging the slider fully right. The browser
performed three actual actions and no drag. Its final native DOM showed value1
of100. The verifier accurately returned `output.slider_completed=false` and
reasoning that the task was not completed, together with `score=1.0`. The
browser treated that score as success, and the root completed. The historical
benchmark FAIL is preserved; this case does not claim a corrected live outcome.

Normal exported packet SHA256:
`bc1a73154e3c1883e122eec071f3382ce55405c18ed0b240cf390375480703bd`.
Original run SHA256:
`04cfe65c940ab07fc341b48d91a1b197c1d1855e7696ccb98417af793a1664b1`.
Verifier request `be7fd61fe1b7` SHA256:
`531873c2fdbd2e727bf4813f38836390596cc2d234dad64b2753db2d9da4a3fe`.
Actual response content SHA256:
`fb44346a04aa5128e36d7371132c40d183265ea687a29cabc19b8519c41f1c1e`.

The exact response said: "The task was not completed." This is evidence of the
recorded response, not a string that runtime code matches to decide success.

## Diagnosis

The generic schema-driven verifier defines score1 as all required fields being
populatable from evidence. A truthful negative boolean is a populated field.
The browser terminal gate interpreted the same score as completion of requested
work. Both components followed their local contracts, but the contracts differed.
The owned first-bad boundary is admitting extraction completeness as task success.

This is not a numeric-score parsing failure or evidence that all false fields
mean failure. A correct negative answer may complete an informational request.
The fix must not infer completion from output values or reasoning strings.

Historical Temporal activity results can replay without executing an updated
helper. Therefore helper-only enforcement is insufficient: the browser terminal
consumer must also require the new explicit verdict. The old implicit minimum
count is a separate policy issue. The three-action count was correct; a synthetic
counting-discrepancy hypothesis was withdrawn after the raw action audit.

## Solution

Commit `f89fb90bdbba728426f34b4e6c1c9a93bfa75c12` adds a mandatory strict boolean
`task_completed` to the two existing real browser verifier routes, independently
of extraction score. The existing output, including accurate negative answers,
is retained. Missing or malformed verdicts remain unknown and cannot complete.
The browser gate requires both passing extraction score and explicit true verdict.
Existing old-shape DEMO escape routes cannot fabricate this new real-browser
verdict; unrelated verifier routes keep their existing behavior. No task/schema
catalog, timeout, step budget, criteria, or model provider is changed.

The same new owning controls fail before and pass after:

- Four verifier families cover the captured extraction-only response, explicit
  informational false success, action-incomplete failure, strict native/fallback
  schemas, partial schema rejection, cancellation and stale cache replies.
- A real browser activity control rejects old/malformed replayed verdicts before
  accepting a later explicit successful verdict. An explicit user-denial control
  remains valid.
- Existing live-feedback/schema controls preserve accepted requirement revisions;
  intended successful test doubles declare the new verdict explicitly. No
  score-to-verdict compatibility adapter was added.

Applied code gates:14 verifier controls,14 browser lifecycle/feedback controls,
and11 default schema/bounds/file-pointer controls passed. Actual captured
context/output replay changed admission from1.0 to0.5/unknown while preserving
all non-system evidence and extracted output. This proves protocol enforcement,
not that a new model call would choose a correct verdict or complete the slider.

Fresh independent reviewer `ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt` returned GROUNDED
for `polar-k2-r10-browser-completion-v3`, exact patch SHA256
`fa3a4eb701f477eecce44b561ba8c2e76a475467751bb69b59bdd58d18eb7a41`.
Opened references include BrowserUse0.13.11 separate success/data and judgement,
Hermes separate verification/partial completion, and Codex separate review verdict.
BrowserUse's default-true success and telemetry-only judge are contrary practice:
Rose already gives the verifier terminal authority, so the repair clarifies that
existing authority rather than copying those defaults.

Canonical `publish_evidence_links.py` ran once on the immutable original bundle.
It verified the fresh FE,38 messages, browser termination and attached recording:
https://www.roselabs.ai/?agent-id=74d382fc-e192-4e7b-badf-b9d94d5ab8de
It recovered and published the actual last root/child call `completion_summary`,
`1793164721186-ea2aea694afe.json`, SHA256
`fa97750d80bf56cf417fe67699acceb9aecb453df6a4db12581afbb0e4c9c42b`.
The signed HTTPS render and publisher receipt were supplied to the reviewer and
parent; independent HTTP checks passed. No credentials or signed access tokens
are committed in this case. There was no new model/browser/benchmark execution.

R9's separately grounded text-evidence return must coexist with completion fields
without becoming completion authority. The off-tree composition against parent
`30fcebb603b2b69a3fc10e15437d64295e782dee` received independent GROUNDED for
patch `af5d47a106c3c2710fa7141e9751a745d7c36375299723e4a3c67b8d66de00a9`.
R11 service bytes remain unchanged. Composition tests explicitly reject evidence
text claiming completion when the actual verifier verdict is false.

The original benchmark issue remains OPEN until the unchanged task has a real
post-fix outcome. No internal, unit or replay result grants benchmark PASS credit.
At10kagents the repair adds no infrastructure or unbounded work; a required model
field can still affect existing bounded retry behavior, and model verdict quality
must be measured independently.

## Human feedback

The user separately corrected the unauthored Polar minimum-step policy: Polar
must not inherit the generic browser5 default when its task does not specify a
minimum. That correction preserves explicitly authored minima and non-Polar
defaults; it is commit `ef90bd6af885091874a5c63fadb39e2f6aea8c5d`, separate from
this task-completion protocol. No historical result was automatically regraded.
The parent required explicit semantic completion rather than field-value or
reasoning heuristics, exact independent review, and existing-evidence publication
instead of another paid benchmark.

## Reusable lesson

Require an explicit task-completion verdict at the terminal consumer; populated
structured output proves extractability, not completion of the user's work.
