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
  - benchmark run 75a7f70a-71c5-4929-87d9-6e772ae450d7
  - agent b53db629-4b68-4d7a-b763-1777d3b15f45
  - commit 379cd490cf75ec87fa4cfbbc179f0222c429ee8d
tags:
  - phone
  - benchmark
  - completion-summary
  - structured-output
  - false-negative
repro: agents/benchmarks/phone_connectivity_test.py:test_captured_canonical_finished_card_reads_typed_visible_heading
status: fixed
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
The delegated worker did not spawn a further reviewer. Local adversarial
negative cases and parent diff review are the review performed here.

## Unchanged canonical outcome verification — 2026-10-18

The prior OPEN handoff statements above describe the evidence available then;
the unchanged native outcome gate is now closed. Parent ran the normal command
`bash scripts/run-bench --local browser-cloud-iphone-settings --run-id phone-connectivity-20261018t2042-r2 --no-dashboard`
at checkpoint `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`. Its native controller
exited 0. Native run
`agents/benchmarks/runs/20261018_204540_75a7f70a-71c5-4929-87d9-6e772ae450d7_browser-cloud-iphone-settings.json`
records **PASSED**, COMPLETED, score 1, 177.3 seconds, 51 messages, and no failure.
The FINISHED canonical completion card reports typed `visible_heading` =
`Paired Computers`; the strict persisted launch/OCR/heading and no-attention
checks passed. This is actual Rose/cloud-phone evidence, not a replay verdict.

Original trigger: `2026-10-18T20:06:57.416731+00:00`; third-attempt trigger:
`2026-10-18T20:41:34.224899+00:00`. Hub:
`75a7f70a-71c5-4929-87d9-6e772ae450d7`; root:
`b53db629-4b68-4d7a-b763-1777d3b15f45`. The original ERROR and second FAIL
remain failures; the third PASS does not rewrite either. The original
controller's finalizer lost its native completed run/ledger row. A source-tagged
ERROR row was appended to `history/task_attempts.jsonl`, preserving every prior
byte. Its 457-second duration is explicitly the rounded original report display,
not an invented exact tenth; timestamp comes from the original local Hub run.
No token counts were inferred. Backfill provenance:
`.context/phone-harness/goal4-close-history-backfill.json`.

`tasks.py` does not exist in this benchmark package; the authoritative
`agents/benchmarks/tasks.json` is byte-identical from `33bf65449502dd377dec57f576f8590bdb091d71`
through `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`, SHA256
`711a7f0f0e05db71042792751fbb7e1ad3c347285a943d0789a7cf93059363b8`.
All six recorded runtime hashes in
`.context/phone-harness/live-connectivity-retry2-slice.json` match both the pass
checkpoint and closure-time checkout. Verification receipt:
`.context/phone-harness/goal4-close-frozen-proof.json`. These are bug fixes under
unchanged task criteria, not a claim that all runtime files match the buggy revision.

Parent's retry log records cleanup `started=2 completed=2 state=clean`.
Both task and local-stack receipts are clean, and local-benchmark-owner state is
`cleanup_verified`. No resource stop acknowledgment substitutes for this proof.
The real canonical publisher completed; fresh-browser FE verification saw all
51 messages and retained browser termination/recording checks. The rendered dump
was published to HTTPS and its recorded readback returned 200. Exact verified
share/HTTPS links and canonical HTML are retained in
`/opt/cursor/artifacts/rca_evidence/b53db629-4b68-4d7a-b763-1777d3b15f45/manifest.json`;
publication log: `.context/phone-harness/live-pass-publication.log`.
Independent closure readback also returned HTTP 200 for the 39,048-byte HTML;
`.context/phone-harness/goal4-close-outcome-proof.json` records its hash, native
PASS/FAIL hashes and three preserved attempt rows without copying signed URLs.
The second attempt's separately published FAIL remains unchanged.

This closure ran no additional paid benchmark, live phone operation, deploy,
commit or process intervention. Goal 5 frontend work is independent of this
Goal 4 proof; it is not included in this result.

The unchanged captured-card regression and 42 offline assertions remain the
causal proof. The third native task accepts the real typed Paired Computers
report against actual persisted OCR under the same exact-match criterion.
Neither a Settings-only assumption nor a prose fallback was introduced.

## Human feedback

User required the actual reported heading grounded in persisted successful
Settings launch plus real OCR plus no attention, forbade task/prompt/timeout /
verifier-criterion changes, and required a captured canonical-card regression.
Do not blame the agent for the reader failure or invent a Settings heading.
Freedom and AGENTS remain untouched.

## Reusable lesson

Read canonical typed completion outputs directly instead of classifying the wording of summary prose.
