---
id: 2026-10-28-it9-bu025-original-context-awaiting-normal-export
date: 2026-10-28
title: It9 BU025 verifier returns an incomplete list after per-receipt truncation
surface: harness
component: browser-verifier-context
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Captured verifier admission head/tails the recorded list at the existing per-receipt limit; verifier then knowingly returns 344 of 944 recorded rows, while a safe repair and full outcome remain unproven
symptoms:
  - polar perfect-score failed (1/3 rubrics)
  - its final output explicitly omitted the middle of the list because of truncation
  - it jumps from shows scoring 57 to shows scoring 41
tags:
  - polar-bu-025
  - r14
  - it9
  - context-intake
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent 271ee978-e517-4a30-ab1d-d434ea19e3f8
  - fleet run 20261028-080446-19639
repro: Read-only exact captured TOOL_RESULT projection in .context/rca-r14/compare_admission.py; no task rerun
status: open
---

## Problem

R14 covers only It9 polar-bu-025 run1, job r001-j0010, root
271ee978-e517-4a30-ab1d-d434ea19e3f8, fleet 20261028-080446-19639.
Original early-row packet SHA256 is
e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2;
line 5 of 8911d6dbe05e58.jsonl has SHA256
62c812deccdfc82ed3c0b13eac9a77124faf4ffd83afee91b544612db87a71fc.
The original task is FAILED/exit1/infra=false/released=true. Wrapper passed and
agent COMPLETED are not task success. Original finished_at is
2026-10-28T08:20:59.447669Z; raw task duration_seconds is 310.9.

The unchanged task requests TV titles, Metascores and critic-review counts for
shows scoring below 60 with at least 10 reviews. Catalog polar_tasks.json SHA256
is 0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9.
The generated response schema requires a tv_shows list of objects with title,
metascore and critic_reviews, without a fixed list length. No task or schema
change is proposed.

Initial intake stopped at local artifact availability. The normal export then
arrived in two parts; assembled archive SHA256 is
8f33f0abbad44d9b569d97456050ab80aa863c114104b683ec96275b4ad6aad0.
This matches the owner's subsequently confirmed full archive hash. The embedded runtime-evidence manifest independently matches:
run.json d1ff95d96fd3aceccd492b8734b3a85cfb49a8c4c3c19271d3e361b2e27da497;
worker.log 46542cc7fd9e702754f0672ccc392d7b8f4343ce1a9bd4ed95f3f5b80ea064d2.
Execution provenance base_sha is 339894f88c95837c608b74c7a394ebc6fd338c6f,
workspace_patch_sha256=none. No same-It9 PASS sibling exists: the owner reports
both BU025 repetitions failed. The other failure is outside this primary RCA.

## Diagnosis

Read-only captured replay proves a narrower boundary than the earlier R11b
aggregate-budget starvation. This run has 56,475 admitted tool-result characters,
well below the existing 160,000 total budget. All ten evaluate receipts remain
present. The problem is that each large result is independently head/tailed at
the existing 12,000-character ordinary-tool limit.

The native captured sequence is:

1. Evaluate step16 returns a 58,566-character string containing 944 recorded
   title/metascore/critic_reviews objects. Step14 returns a 30,172-character text
   list of the same reported matches. These are attributable JavaScript returns,
   not independent proof that every value is correct.
2. Worker line13252 records the pre-conversion verifier context, SHA256
   0a3c3eac8d49544702fb692e571aff737dc7ff187c655b4bcf8a52d54c59b25d.
   Line13253 records encoded verifier request 0abdad85aea6, decoded SHA256
   7679e507c94516e26c9b3687fd444d07a4b4b2f408175910b54544ad398c4a9e.
   Every payload decoded from its original gzip/base64 passed its recorded hash.
3. The unchanged canonical build_verifier_context_messages reproduces all
   14 captured TOOL_RESULT lines byte-for-byte. action_history, evaluate16 and
   evaluate14 each occupy exactly12,000 characters and contain the truncation
   marker. Native read_browser_state step2 occupies10,097 characters. All other
   evaluate receipts survive; reordering is not the missing repair here.
4. Captured verifier response at08:16:42Z, decoded SHA256
   36cb1950c1cab95e04d20502a9a03e2c45e25b2550f66360efce0e7e4aa1cce7,
   returns task_completed=true and score=1 but only344 tv_shows. Its reasoning
   explicitly says parts of the944-item list were truncated in its view and that
   it lists only visible entries, jumping from Merlin(57) to How to Be a
   Gentleman(41). Compared by recorded title,600 source-result entries are absent.
5. The original final structured response also contains344 entries. Thus the
   incomplete list already exists in the verifier's output; it is not merely a
   scorecard or final-renderer omission. No model rerun was used to establish this.
6. All three original declared-judge requests and responses were recovered from
   driver lines2691/2747,2753/2808,2814/2918. Each input includes the omission
   reasoning and both boundary titles. C1 and C2 return failure for incomplete
   output; C3 returns success for no contradicting fabricated facts. Original
   1/3 and taskFAIL are preserved, not attributed to a judge transport loss.

The source owns two distinct stages: service.py emits separate, attributable
native/evaluate receipts; helpers/llm.py applies unchanged per-tool and total
caps. Handler completion consumes the verifier's structured result. The later
Polar evaluator uses root/hydrated child messages through its own trajectory
builder. Recorded incompleteness crosses the verifier-output boundary before
that separate judge rejects it.

This is not proof that removing a limit or changing a model would solve the
benchmark. The truncation is an existing bounded-evidence policy, and the
verifier also makes a completion decision despite acknowledging partial output.
No controlled alternate model/task outcome exists. Root cause of that decision
and an acceptable general repair remain OPEN; do not relabel this as model
intelligence failure or reuse R11b's aggregate-starvation diagnosis.

Archive searches used `944 matches truncation middle list` and
`polar-bu-025 verifier native receipt admission`. The prior case
2026-10-28-browser-evaluate-results-buried-in-compact-history is a related lead:
R11b fixed receipts being wholly starved by the total budget. It does not remove
this run's per-receipt head/tail cap. The prior case was not appended or changed.

## Solution

No runtime repair proposed or applied. No prompt, task, response schema, rubric,
cap, timeout, retry, minimum, provider setting or active operator changed.
Do not raise limits, promote JavaScript results to independent DOM truth, or
manufacture the600 omitted entries from the count. Future work must preserve
bounded context and original evidence authority while establishing a general
owning boundary with a registered same-test red/green control and independent
strong review before application. Full unchanged-task outcome proof remains OPEN.

Validation is read-only: archive/runtime member hashes, original encoded payload
hashes, exact canonical TOOL_RESULT equality, recorded list/output comparison,
and three original judge response inspections. The projection script is an
investigation artifact, not a new registered regression or a repaired-task proof.
A preliminary analysis script expected step14 to be JSON and stopped; step14 is
text. That parsing attempt was corrected, not counted as a causal red result.
No provider, browser, model or benchmark call was made. Token usage is UNMETERED.

## Human feedback

The parent restricted R14 to this primary row, prohibited assuming recurrence
from R11b, and required only normal verified local exports on the executed source.
It required original FAIL/infra classification/clocks unchanged, no images,
no speculative cap/schema/prompt repair and no invented task outcome. The owner
corrected the sibling assumption: both current BU025 runs failed, unlike It8.

## Reusable lesson

Separate absent receipts, individually truncated receipts, incomplete structured
output and the later judge's decision. Exact captured admission can prove where
information was bounded without proving that a different context policy would
produce a correct full task outcome.


## Bounded feasibility follow-up on qualified source

A later offline round used qualified source
66eb9ccc4e39237bdd99b08f697180c7097a39bd. The same original raw context and
encoded verifier-request hashes above were reverified. The unchanged canonical
builder still reproduced all14 captured TOOL_RESULT lines byte-for-byte at
56,475 admitted characters. No original result, timestamp or receipt changed.

Measurements include the complete TOOL_RESULT envelope: action_history is
109,791 characters, evaluate step16 is66,774, and evaluate step14 is31,661.
The step16 inner structured result is66,609 characters; its returned value is
58,566 characters and contains944 recorded rows. All14 uncut receipts total
228,701 characters, exceeding the existing160,000 aggregate limit. Ordinary
compact JSON reduces this only to228,498. Even title-only JSON for all944 rows
is16,005 characters, beyond the existing12,000 ordinary per-receipt limit while
omitting the required scores and review counts. These are capacity measurements,
not proof of the source rows' independent factual correctness.

Excluding action_history would leave118,910 characters, but that is not an
approved repair: the history also carries distinct action, request, status,
target and transition evidence. It is not an exact duplicate that can simply
be discarded. Admitting selected larger receipts by borrowing aggregate space
would require a justified general evidence-allocation contract, including which
other evidence may be displaced. Splitting a receipt to evade its hard limit
would not establish that contract.

Comparable primary implementations were personally opened: Codex
context_manager/history.rs515-575 preserves rollout provenance while applying
per-tool truncation; OpenClaw code-mode-json.ts210-269 and325-378 fits bounded
serialized channels and retained references; Hermes context_compressor.py582-618
and1265-1339 accepts smaller pruning candidates and accounts for serialized
content. These support explicit bounded accounting and honest retained-source
provenance, not a task-specific preference for JavaScript over native or action
evidence, nor an untested new retrieval protocol.

No safe general repair within the current admission contract was established.
No runtime candidate or speculative regression was written. The measurement
script is an investigation artifact, not a registered red/green test. Its first
JSON parse omitted the recorded count preamble; the parser was corrected, not
counted as causal RED. A future repair must first ground the general allocation
or bounded retained-evidence retrieval contract, then prove the actual owning
boundary with budget/order/conflict/small-result controls and independent review.
Original344/944 output and genuine taskFAIL remain unchanged; full outcome stays
OPEN. No model/browser/provider/native/DB calls or environment changes occurred.
Tokens UNMETERED.
