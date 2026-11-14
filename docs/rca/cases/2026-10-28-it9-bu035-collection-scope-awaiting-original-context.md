---
id: 2026-10-28-it9-bu035-collection-scope-awaiting-original-context
date: 2026-10-28
title: It9 BU035 page-one scope survives transport but receives differing completeness judgments
surface: harness
component: browser-verifier-context
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Page-one collection is explicit in original verifier and judge inputs; internal completion accepts it, while declared C1/C2 reject run2 and accept the distinct run1 comparison
symptoms:
  - "polar perfect-score failed (1/3 rubrics)"
  - "step 73 reports 801 results across 41 pages"
  - "the agent examined only page 1 and returned 21 events"
tags:
  - polar-bu-035
  - r18
  - it9
  - context-intake
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent 2dcdadfe-f504-4b5b-91c5-c07fd1b37bd0
  - agent 537f29b5-60b6-43e2-a47e-e20491b8afe7
  - fleet run 20261028-080447-19728
  - fleet run 20261028-080446-19660
repro: Read-only exact TOOL_RESULT projection for both original verifier requests; no model or task replay
status: open
---

## Problem

R18 covers It9 polar-bu-035 run2, job r002-j0050, root
2dcdadfe-f504-4b5b-91c5-c07fd1b37bd0, fleet 20261028-080447-19728, and the named
run1 comparison, job r001-j0020, root 537f29b5-60b6-43e2-a47e-e20491b8afe7,
fleet 20261028-080446-19660. No other task family is included.

Original early-row packet SHA256 is
e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2.
In 8911d6dbe05e58.jsonl, run2 line22 has raw-line SHA256
e944337f4469ac3e4be64b7405ae2df0250b8263450884fb1554d12337dfffc8;
run1 line10 has ba4632b3f119ae9ac0a18612c6bcce39200ed0a58a63108f9bfdba23ded1be66.
The original results remain run2 FAILED/exit1/infra=false/released=true and run1
PASSED/exit0/infra=false/released=true. Agent COMPLETED and wrapper passed do
not override task grades. Original finish clocks are 08:20:18.535271Z and
08:20:07.294721Z respectively on 2026-10-28; raw durations are 205.6s and 287.0s.

The actual catalog and imported BU-035 entry agree:

> Use the search bar on Eventbrite to find events scheduled in San Francisco, CA for the upcoming weekend, and list each event's title along with its ticket price range.
> website: https://eventbrite.com

The contract specifies each matching event, but no fixed801 count. Source file
polar_tasks.json SHA256 is0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9;
imported polar/bu_bench_v1.json SHA256 is
c943d2baa2f7bebc0910eaf9168e2077aeb7e1cda219455f3c0402d3a2545667.
The three unchanged rubrics cover end-to-end completion, requested format and
substance, and no fabricated facts contradicting trajectory. All must pass.

Initial intake had no raw bodies. The later normal archive assembles to SHA256
bae1c044ded3b10a14bba682d07434cac142817961343fd8cec40f9dbc88867d, matching the
owner's prefix/suffix; full external hash confirmation was requested. Embedded
runtime manifests verify both originals:

- Run2 run.json1cc119b62cc6c185597dc89255efe871b0db60eda2e8ba154445737610ce7f99;
  worker440fe38765449a3c4d081a84ffccf3c4c74487221f164452fb2a6dad1d8ddbb8.
- Run1 run.json87e36bc185dea8225a609201328bcfd15e5fed3ed2c5cc4f2162534a97a2c1bd;
  workerc87e3009bdaa7db1f39e70d47e976e915cfd2206ae77fbeb54dec3fc11b07697.

Both execution-provenance files bind base_sha to339894f88c95837c608b74c7a394ebc6fd338c6f
with workspace_patch_sha256=none. Original files were not altered.

## Diagnosis

No receipt-loss cause is established for the relevant pagination and price
facts. Both runs explicitly collect page1, and both internal completion
verifiers accept that limited scope. The separate declared judges then treat
that limitation differently across the two distinct original inputs.

Observed chain, without changing task meaning or inventing an801 requirement:

1. Run2 action27 requests Eventbrite destination/search with dates containing
   current_future and this_weekend, San Francisco place85922583 and page1.
   Its recorded response has object_count801 and page_count41, along with20
   first-page events. Action28 obtains prices for promoted cards. These are
   attributed request/results, not independent proof that all801 are eligible
   unique in-person San Francisco events. Run1 action56 likewise requests page1
   and reports total801; action57 supplies promoted-card prices.
2. The captured run2 verifier context includes action27 completely as a7909-char
   receipt and action28 as1690 chars. Run1 includes action56 completely as4310
   chars, action57 as1159, and the first-page card extraction51 as7217.
   Neither run loses these load-bearing receipts to truncation.
3. The unchanged canonical builder reproduces every TOOL_RESULT byte in each
   original verifier request. Totals are70,874 chars for run2 and88,641 for run1,
   below the160,000 aggregate cap. Other large history/native rows are truncated
   by existing rules, but the pagination/price receipts above remain intact.
4. Run2 verifier0245b6e45461, decoded request SHA256
   fb152c26060acd0e76312d334d6e57cc0dd58fd831eff5470c8c158132b2ecf3,
   explicitly acknowledges801 events across41 pages, calls the first-page scope
   reasonable, and returns21 events with score1/task_completed=true. Run1
   verifier97c63a93e2f8, request SHA256
   97517f3519dc1b58d46c8df7744643688d4ffd3b11f989324883fd89b8bd01d4,
   similarly acknowledges page1/41 and returns22 events with score1. Both final
   structured outputs exactly equal their respective verifier output lists.
5. All three original declared-judge requests and responses were decoded and
   hash-verified for both runs. Each contains page1,801/41 and the internal
   verifier's scope rationale. Run2 C1/C2 reject the first-page restriction;
   run1 C1/C2 explicitly accept a disclosed first-page restriction. Both C3 pass.
   This is observed differing completeness treatment, not a controlled replay
   proving that any specific judge is wrong or that an alternate grade is due.
6. The generated schemas differ in field name (sf_weekend_events versus events)
   and run1 has minItems1. Both request title and ticket_price_range. This is
   recorded input variation, not evidence that schema variation caused the
   different grades. No schema or criterion change is proposed.

The transcript projection and judge-input hashes support the observed chain.
They do not prove full collection completeness, exhaustive eligibility, a
model-intelligence defect, or a universally correct scope interpretation.
Internal-verifier acceptance is not authority to promote task success. The
original run2 FAIL and run1 PASS remain unchanged.

Owning source paths are service.py::build_browser_verifier_context, existing
helpers/llm.py tool budgets, handler completion and append_completion_evidence,
run_benchmark.py::_hydrate_semantic_evaluator_tree, and the separate
polar_evaluator.py trajectory/rubric path. The exact replay compares admitted
text only; it does not execute hydration, a browser, or a model.

Archive searches used `Eventbrite pagination each event` and `801 results 41
pages`, followed by literal Eventbrite/BU035 searches. No prior matching
incident was identified. R14/R16 and previous receipt cases remain separate.

## Solution

No repair is proposed or applied. In particular, do not redefine each to mean
first page, enforce a fabricated801 requirement, widen caps, rewrite prompts,
change schemas or criteria, regrade either run, or substitute sibling results.
A safe general repair is not proven by two distinct executions with different
outputs and judgments. Full task outcome and underlying decision cause remain
OPEN.

Validation: both runtime manifests and source provenance; all decoded request/
response payload hashes; unchanged canonical TOOL_RESULT equality for both
runs; intact relevant pagination/price receipts; exact final-list equality;
six original rubric request/response inspections. No model/task replay or
registered red/green repair control is claimed. The local replay script is an
investigation artifact only. No provider/controller/guest/DB/browser/model call
or additional benchmark run was made. Own token usage is UNMETERED.

## Human feedback

The parent restricted R18 to this family and named comparison, prohibited an801
requirement or output-loss inference from a quote alone, and required the
executed source frozen. R14/R16 separate OPEN branches were preserved. No
images, task/criteria/cap changes, speculative fix, or unrecorded token estimate.

## Reusable lesson

Trace collection scope through original admitted evidence, completion output
and every rubric input before diagnosing pagination transport loss. A passing
sibling with a different original transcript is comparison evidence, not a
regrade instruction or controlled proof of a judge defect.
