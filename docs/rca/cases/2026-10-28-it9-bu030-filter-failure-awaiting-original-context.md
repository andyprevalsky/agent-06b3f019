---
id: 2026-10-28-it9-bu030-filter-failure-awaiting-original-context
date: 2026-10-28
title: It9 BU030 first-five eligibility remains unproven after manual filtering
surface: harness
component: browser-verifier-context
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Recorded completion rationale excludes an earlier listing using building sales-start evidence, without establishing that unit added date; original full verifier request is unavailable
symptoms:
  - "polar perfect-score failed (1/3 rubrics)"
  - "attempted seven-day URL filters returned the same 3,827 listings as the unfiltered search"
  - "The requested seven-day filter was not applied and confirmed"
tags:
  - polar-bu-030
  - r16
  - it9
  - context-intake
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent d2144227-9181-4faa-a4cd-581e4e8b962d
  - fleet run 20261028-075834-14197
repro: Read-only canonical admission matches recorded verifier input texts; no full encoded-request or task replay
status: open
---

## Problem

R16 covers It9 polar-bu-030 run1, job r001-j0015, root
d2144227-9181-4faa-a4cd-581e4e8b962d, fleet20261028-075834-14197; its named
same-source PASS comparison is run2, job r002-j0045, root
278b834f-6742-4a59-89d5-5c32f2f12260, fleet20261028-075834-14272.
The original run1 remains taskFAILED/exit1/infra=false/released=true. Agent
COMPLETED and wrapper passed do not change the task grade. Its original finish
is2026-10-28T08:21:14.348204Z and raw duration357.8s. The sibling remains PASS,
raw duration1654.7s; that is comparison, not counterfactual proof.

The task is unchanged:

> Filter listings for sale in Brooklyn that were added in the last 7 days and list the first 5 with price details.
> website: https://streeteasy.com/

Catalog polar_tasks.json SHA256 is
0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9;
imported BU-030 entry has the same prompt. Early-row packet SHA256 is
e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2, and run1
line9 of5683dd703c5358.jsonl has raw-line SHA256
77f67c6e59878d337831255c342972f00178dca30382fc23d62d63c69829e226.

The normal raw archive SHA256 is
ca1b8e1ef24911e07222bb1c0e1657780bcbf01d48035b3b96a91ade5e39fbd2,
matching the owner's reported prefix/suffix. Embedded runtime manifests match:

- Run1 run.json7685ac744cc4014242670d7f7d012ad28b77056cde6bc03877f1e9beb535a35e;
  workerfca3593a9153ac972830f4a6c0190e2cf78fc0378fdb38baae931007ae5001d4.
- Run2 run.json2d6c020f953d4774cbdc807ea613278a737e04ef09e7a21721f935c076ae8f6c;
  workerb214dc427e718afba96efd3e4795c48f6c1a62288124a805030e17c1f85c8e9a.

Both execution-provenance files bind base_sha339894f88c95837c608b74c7a394ebc6fd338c6f
and workspace_patch_sha256=none. Original files were not modified.

## Diagnosis

The run completed with an unproven first-five eligibility claim. This is not
the earlier R13 timeout, and no new transport defect has been established.
Recorded completion rationale accepts a building's sales-start date as a reason
to exclude an earlier unit, while the declared judge rejects the resulting
first-five proof. Whether that unit actually qualified remains unknown.

Observed original evidence:

1. Attempts at listed:7, listed<7 and days_on_market<7 return the same unfiltered
   count3827. The agent then uses sort_by=listed_desc. Sorting by newest alone
   does not establish a seven-day filtered result set; manual eligibility proof
   must support the selected listings and exclusions.
2. Run1 step32 records the first10 result cards, including featured179 North
   10th Street #2D before the chosen results. Step34 returns its building's
   Sales start7/14/2026, explicitly described as when sales first began for homes
   in a newly built or redeveloped building. It does not record the unit's
   added-to-StreetEasy date. The same step identifies757 Flatbush #502 as11 days
   on market and480 Kent #21E by another building sales-start field.
3. Step35 records five chosen units' Listed by10/27/2026 history rows and price
   details. The returned dates for those chosen units do not by themselves prove
   they were the first five eligible units. In particular, the earlier featured
   unit's eligibility is not resolved by a building-level start date.
4. The recorded verifier rationale nonetheless says179 North10th does not
   qualify because sales started7/14/2026 and accepts the selected first five.
   All load-bearing evaluate32/34/35/36 receipts remain intact in the recorded
   verifier text:3376/5861/6067/3315 characters. This is not a case of these
   specific fields being silently dropped by the admission budget.
5. Original C1/C2 judge responses reject the unconfirmed filtering/first-five
   claim; C2 specifically notes that a featured building sales-start date does
   not establish when its unit was added. C3 accepts the reported factual values
   while describing the exclusions as inconclusive. Preserve1/3 and taskFAIL.
6. The same-source PASS run uses a different result order and explicitly records
   Listed by dates for preceding/interspersed exclusions and each chosen unit.
   Its judges accept manual filtering even though added:7 did not work. Thus a
   missing working URL filter alone is not proof of task failure; the actual
   eligibility/order evidence matters. The sibling does not establish what the
   failed run's uncertain unit date was or prove a proposed fix.

There is a material observability limit: full verifier request dumps were
skipped as payload_too_large. Run1 dump73cb843f448b is1,124,203 bytes; run2
39881cc10cf5 is1,062,201 against1,000,000. Original pre-conversion contexts and
browser_verifier_input.texts do exist. The source helper
_browser_verifier_text_evidence records admitted user text only, excluding system
instructions and images. The unchanged canonical builder matches every recorded
TOOL_RESULT text for each run:85,832 chars for run1,160,000 for run2. This proves
text-admission parity only, not equality of an unavailable full encoded request.

Run1 retains all20 evaluate receipts without truncation; some large native/history
rows are bounded. Run2 preserves recent eligibility receipts77/78 intact despite
older evidence being limited. No alternative context/model execution was tried.
All six original declared-judge requests/responses were recovered and decoded
with their recorded SHA256 values; they are separate from the missing browser
verifier request dumps.

The owning path remains browser observations/evaluation returns, bounded
build_browser_verifier_context, recorded admitted text, completion and then
polar_evaluator.py's separate hydrated trajectory. Source mechanisms cannot
supply absent unit eligibility or turn the completion rationale into evidence.
Root cause of the unsupported exclusion and a safe general repair remain OPEN.

Archive searches used `Brooklyn seven-day newest filter`, `polar-bu-030 receipt`
and literal StreetEasy/BU030 searches. The local It8 R13 case was a StartToClose
failure with an unverified final request. Here the agent completed and reached
the declared judge. Do not append this as the same first-bad boundary or claim
that R13's receipt ordering would fix it.

## Solution

No repair proposed or applied. No task, prompt, schema, criterion, cap, timeout,
retry, minimum, provider, active operator or execution behavior changed.
Do not replace unit-added dates with building-start dates, invent missing
eligibility from the sibling, or force a particular URL filter syntax without
proven site semantics. Neither a task relaxation nor an increased budget is
justified by these artifacts.

Validation is read-only: archive/runtime manifest hashes, source provenance,
recorded date/order/value inspection, exact admitted-text TOOL_RESULT equality,
and all three rubric inputs/outputs per run. The replay script is a local
investigation artifact, not a registered repair regression or full task proof.
No model, browser, provider, DB, controller or new benchmark call was made.
Own token usage is UNMETERED. Further repair requires a causally controlled
registered red/green and exact independent strong review before application;
unchanged real-task outcome remains OPEN.

## Human feedback

The parent restricted R16 to this family and its named sibling, prohibited
assuming the old R13 cause, and required original grades/infra/clocks preserved.
It requested only existing normal exports, no images, no speculative task/
prompt/schema/criteria/cap changes, and no unrecorded token estimates. R14 and
R18 stayed on their own branches/cases.

## Reusable lesson

Prove eligibility for skipped earlier candidates as well as chosen ones when
claiming the first qualifying results. A building lifecycle date is not a unit
listing date, and preserving complete text does not make an unsupported
completion inference true.
