---
id: 2026-10-18-phone-heading-reader-ignored-canonical-typed-output
date: 2026-10-18
title: Phone heading reader ignored the canonical typed completion output
surface: harness
component: phone-connectivity-report-reader
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: phone_connectivity.reported_heading parsed a line-anchored summary instead of the latest FINISHED completion card visible_heading output
symptoms:
  - Final reported heading does not match persisted OCR proof
  - reported_heading returns empty for a FINISHED card with visible_heading Paired Computers
sources:
  - commit 64f7eedbc9ae18c5958837de9e70267101c9edf8
  - plan:agents/benchmarks/runs/20261018_203421_6a6d0399-1e5a-45eb-bab0-f3c463e27faa_browser-cloud-iphone-settings.json
  - plan:.context/phone-harness/phone-heading-reader-before.log
  - plan:.context/phone-harness/phone-heading-reader-after.log
  - plan:.context/phone-harness/phone-heading-reader-offline.log
  - plan:.context/phone-harness/phone-heading-reader-registered.log
tags:
  - phone
  - benchmark
  - completion-summary
  - structured-output
  - false-negative
repro: agents/benchmarks/phone_connectivity_test.py:test_captured_canonical_finished_card_reads_typed_visible_heading
status: open
---

## Problem

Canonical retry run 6a6d0399-1e5a-45eb-bab0-f3c463e27faa, root
4251eeca-4024-46ea-9196-e81a1b2eaad3, failed with
Final reported heading does not match persisted OCR proof. Parent runtime
evidence reports COMPLETED, successful phone operations, zero attention and
both phone/canonical-stack cleanup clean (2/2), with resources released.
The native JSON's logs.messages was read only to extract the actual FINISHED
completion card. It contains a typed output key visible_heading with string
value Paired Computers and summary prose ending Visible heading: Paired Computers.
The model reported the heading correctly; this is not agent underperformance.

## Diagnosis

Path: root FINISHED completion_summary -> existing canonical card selector ->
reported_heading -> evaluate_persisted exact heading comparison. The reader
ignored outputs and required Visible heading at start-of-string or after a
newline in summary prose. The real sentence used that phrase mid-paragraph,
so the reader supplied an empty string to otherwise strict persisted proof.

Archive searches: reported heading completionSummary typed output; phone OCR
final report reader. The October 18 phone-results-omitted-from-browser-verifier-
history case was read and is a relative, not this cause: its missing action
history was upstream of verification; this run has a real successful final
report that the benchmark reader misparsed. Existing synthetic positives used
a summary beginning with Visible heading and empty outputs, masking the defect.
The local canonical completion-card selector already preserves typed outputs;
no new parser or text classifier is needed. No reference-harness behavior is
claimed as proof of this repository-specific output-key contract.

## Solution

Use the existing latest real FINISHED card selection and read only its outputs
list entry keyed visible_heading. Require exactly one string value and strip
surrounding whitespace; missing, nonstring, empty/whitespace or ambiguous fields
produce no heading. Never infer a report from root prose, goal, summary prose,
phone results or an older FINISHED card. Remove the summary regex and its now
unused import. Correct the two older synthetic positive fixtures to carry the
canonical typed output without changing their headings or foreign-match /
unfinished-card assertions. The new fixed fixture embeds the sanitized actual
card shape and never conditionally reads workspace artifacts.

Deletion/unification: remove the parallel prose interpretation and consume the
existing canonical output contract. No prompt, task, timeout, criterion,
Settings app ID check, persisted scope, ordered successful launch/OCR proof,
attention rule or exact heading comparison changed. tasks.json Git blob hash
matches checkpoint 64f7 exactly: d9d0cf29bb4a2430065a5668986a655c8f93c21f.

From agents with source venv/bin/activate, identical causal command:
`python -m pytest -q benchmarks/phone_connectivity_test.py -k captured_canonical_finished_card`
Before: assertion expected Paired Computers, got empty (exit 1). After: 1 passed,
27 deselected in 0.48s. The new test was unchanged between red and green. It also
rejects unfinished/error/rejected cards, attempt_completion, generic prose,
missing/invalid typed fields and fallback to an older valid FINISHED card.

`python -m pytest -q benchmarks/phone_connectivity_test.py benchmarks/benchmark_tasks_policy_test.py`
passes all 42 cases in 1.74s. Existing persisted proof checks still reject
foreign scope, invalid launch, failed/out-of-order OCR and a mismatched final
heading. Existing benchmark.blackbox.py discovers all phone module test_
functions. The new case was additionally executed through its existing
_with_pytest_fixtures plus BlackboxResult.record wrapper; the registered log
records PASS. Ruff passes both assigned Python files; diff whitespace checked.

10k-agent behavior: this changes only local parsing of the latest completion
card's bounded outputs list. No provider/API calls, background tasks, shared
mutable state, channels, DB queries or cross-agent scans were added.

Status stays OPEN: the deterministic reader boundary is repaired, but the
parent must rerun the EXACT unchanged canonical task and publish durable
outcome evidence. Offline proof is not a live PASS. No live calls, restart,
process signals, commits, deploys or subagents were used. Parent owns reindex.
The user's no-spawn restriction excludes independent agent review; local
adversarial negative cases and diff review are the review performed here.

## Human feedback

User required the actual reported heading grounded in persisted successful
Settings launch plus real OCR plus no attention, forbade task/prompt/timeout /
verifier-criterion changes, and required a captured canonical-card regression.
Do not blame the agent for the reader failure or invent a Settings heading.
Freedom and AGENTS remain untouched.

## Reusable lesson

Read canonical typed completion outputs directly instead of classifying the wording of summary prose.
