---
id: 2026-10-28-it13-bu058-r1-optional-schema-omitted-tiers
date: 2026-10-28
title: BU058 r1 delivered sponsor years but omitted tiers through an optional schema field
surface: harness
component: response-schema-generation-and-browser-verification
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native schema response emitted duplicate optional tier_by_year file pointers and the verifier explicitly omitted requested tiers
symptoms:
  - Native COMPLETED with benchmark FAILED one of three rubrics
  - Internal JavaScript result contains fifteen sponsor names with years and tiers
  - Delivered structured output contains names and years only
  - Verifier says optional Omitted tier field was left out
tags:
  - r36
  - it13
  - cvpr
  - semantic-coverage
  - generated-schema
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 45d45a98-d3cd-4239-a4e7-18f71bd3c1ee
  - fleet run 20261028-230246-3988115
repro: none-recorded; exact original wire and output trace only
status: open
---

## Problem

Original assignment clock2026-10-28T23:27:29.469808+00:00 is retained.
Jobr001-j0008, polar-bu-058 run1, root45d45a98-d3cd-4239-a4e7-18f71bd3c1ee,
executed source765caac00ce085dd0359b8342161a8717be7446d without patch.
NativeCOMPLETED621.7s is not taskPASS: benchmarkFAILED1/3, infrafalse.
ArchiveSHA44822cb06acd6b9ee9c424d129da69730810c7d75c1bf30a97f2bd80af30e87e;
normal manifestfd7af51efb6e3dd3d4c4ea72d807cbc07c1583e970b2b6e2d1f3863a05973bb1;
runSHAace72bc7944a556ee517a2093b37e225c41a0625b62fb3d366a1650dc0cdd174.
All7 normal member hashes were verified. Compressed wire payloads were decoded
locally and each uncompressed SHA matched its recorded payload hash.

## Diagnosis

User explicitly requires15 sponsors supporting>=4 of past5 CVPR conferences,
with years AND sponsor tier for each year. Message44 contains15 names plus
per-year tiers, including varying tiers (e.g. Waymo). This is an executed JS
result, not independent proof every fact is correct. C3judge accepts consistency;
C1/C2 reject missing tiers in the delivered output.

The actual schema-generation request dump45cf6f4a9c47 at23:08:16.439743Z is
hashverifiedf796f7e70116fb108031fca7fafd9ab7546cffbc24a535f362032f6e66bf851c.
Its nested field type enum does not include object/list[object], and nested
fields have no properties field. The actual model response at23:08:17.778517Z,
SHA1a93b6406da2c438d677d9f821fd5a15fabe2e014d13f7620cb8cc16a07fd37c,
reasons that a nested year/tier pair shape is wanted, but emits sponsors with
name, years_sponsored and TWO same-name tier_by_year fields. Both are optional
nullable list[file_pointer]; descriptions are 'Omitted; use tier_by_year object
list instead.' and 'Omitted.' This malformed semantic choice is present in
native response bytes, not introduced by rendering or public pointer conversion.
The saved completion schema repeats those fields as returned. No runtime
reconstruction or manual repair of the response was done.

Browser verifier request1302451f9b99 at23:17:21.207679Z,
SHA45fa9b84c3fb25f8a51e93adeb07870a15164f112d3a0ec4ea5cbe3ec3723dcb,
contains the original goal and admitted source text. Its actual response at
23:18:06.084852Z, SHA75968b897a0f625b3a04e931f676b2a9d7ef470da9144689e6263b822367c5f9,
returns task_completed=true, score1.0 and15objects with names/years only. It
explicitly says tier_by_year is optional and Omitted and no sessionfiles exist,
so it leaves tiers out. Message47/53 native completion and58root projection keep
that omission. Final summary response51863eccef5d43be16d8751e951160011316d249bcead7adcab58ad15549d553
also states the requested tiers were left out. No output transport loss is
needed to explain the missing delivered data.

The verifier separately notes2024evidence was truncated and treats retrieval
HTTP200 as enough grounding. That is an additional evidence-quality concern,
not proof of correct2024content or the direct delivered-tier omission.

## Solution

Two archive searches after evidence: tier_by_year Omitted optional file schema;
recursive schema CVPR tiers. Full R30case2026-10-28-it11-bu058-r2-optional-file-schema-omits-year-tiers
was read including Solution, recursive wire floor and Human feedback. This new
original independently confirms a related representation/semantic-coverage
family, not merely matching judge text: restrictive nested wire schema,
model-emitted optional file stand-in, verifier omits it, output lacks required
facts. Differences matter: this run includes years and duplicate same-name
fields, while R30r2 lacked both years and tiers. It is not the fixed R24 public
session_file_pointer admission failure; this browser actually executes.

No runtime candidate in this intake. The deterministic duplicate-name acceptance
is a possible narrow structural validation lane, but rejecting duplicates alone
is not evidence that the model will choose an adequate representation or deliver
tiers. General recursive vocabulary remains subject to the already recorded
provider wire serialization floor; this intake does not reopen that platform
work. Forcing optional fields required or inserting tier_by_year from task words
would alter semantics and could demand nonexistent files. Prompt nudges lack a
controlled causal basis. The next safe lane needs a supported general schema
contract and original-wire controls, not an expected-answer or grading patch.

No new model/provider/DB/browser/API calls, images, tests, source edits or
regrade. Parentowns further repair direction. TokensUNMETERED.


## Human feedback

The parent required exact original wire, actor, verifier and judge evidence,
not recurrence from a similar quote. It accepted this as representation failure
but prohibited treating duplicate-name rejection alone as a fix for missing
requested tiers. Keep run1 distinct from run2, do not reopen the recursive
provider platform or change prompts, models, tasks or grades. Finish bounded
OPEN custody with no speculative test or candidate. Original outcome remains.

## Reusable lesson

When data is present in intermediate evidence but absent from the delivered
answer, inspect the native output contract and the verifier's explicit omission
before blaming transport. A structural defect can be real without establishing
that repairing it would satisfy the user's semantic requirements.
