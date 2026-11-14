---
id: 2026-10-28-it11-bu058-r2-optional-file-schema-omits-year-tiers
date: 2026-10-28
title: It11 BU058 r2 returns sponsor names while an optional file field omits years and tiers
surface: harness
component: response-schema-generation-and-browser-verification
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: original generated schema models requested per-year facts as optional sponsorships file pointers; final verifier omits them and approves names only
symptoms:
  - Declared evaluator bu-bench-v1-judge failed with 2/3 rubrics
  - The optional sponsorships file pointers are omitted because no files were downloaded
  - Delivered output lists sponsor names only without per-year sponsorship history or tier levels
  - Nested schema type enum excludes object and list[object]
tags:
  - polar
  - it11
  - r30
  - generated-schema
  - semantic-coverage
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent 0270fe13-0ee2-4c1d-8544-af73b10f2b64
  - fleet run 20261028-214843-2725258
  - plan: normal archive aaa45ed83c1118d00b85704b217a102084f53a78878942bc6105782ad5a87e94
  - plan: normal manifest 6d6b1df2698dde90c38e17ad1a27b90a159a40a60d5214670c50f9ef65f50222
repro: none-recorded
status: open
---

## Problem

Original BU058 r2 asks for15 sponsors supporting at least four of the past five
CVPR conferences, including years and tier for each year. The root is COMPLETED,
while the benchmark is FAILED with infra_failure=false: C1 and C3 pass, C2 fails.
This is not the generic failed-root/schema-admission outcome seen in R24 r1.
The native browser supplies a detailed narrative with year/tier facts, but its
structured output contains only15 names. The original final summary also notes
that the requested years and tiers are missing. Nothing was regraded.

All seven normal manifest members and separately labelled supplemental files
were hash-verified. Archive bytes7426363; original run.json SHA256
7b08cc7bdc89dc49e1ed79860c80e4d734addff6513c7a3c7473eccfc8f7116f;
worker.log8957b85705c6c3359f4767e1739941e603bda18cb6bfb6a53a303ee4ca7ec4c5.
Original source66eb/no patch/real recorded; no new browser/model/provider call.
Original task duration643.8s; canonical job finished22:10:11.245764Z. It did not
hit the50-minute browser deadline. The normal lifecycle is verified.

## Diagnosis

The retained gzip/base64 request and response records were decoded locally and
their uncompressed SHA256s verified. They expose the actual semantic boundary:

1. Schema-generation request6c3b3578afa3 at21:55:06.362743Z has payloadSHA
   fbcae5a4cc4d1da9571bd37612108edd01df89946ad1504ce5c7b29c83e08780.
   Its `_GeneratedResponseSchemaNestedField.type` enum excludes `object` and
   `list[object]`, and the nested definition has no `properties` member.
   The original response reasons about a desired per-sponsor list of year/tier
   records, explicitly notices this limit, and considers flattened alternatives.
   Its first output is empty; the existing generator continues its own retry.
2. Second request8ceda4369894 SHA
   0b75cf22c7f2194b45b11668cdf58d820f6345df98f0062e3704d24be27bdc41;
   native response at21:55:08.946509Z SHA
   398d036cece6dd1a8d98f0cb16cc701ee7a9437f58230ec498b8df12bdc824a1.
   The response reasoning again describes nested year/tier entries, but its
   actual encoded fields are sponsors:list[object] with name:str required=true
   and sponsorships:list[file_pointer] required=false. The latter has no
   description or year/tier fields. This is the model-emitted representation,
   not a later renderer dropping fields.
3. Original browser completion at22:05:28.774Z repeats that same output schema.
   The narrative reports sponsors and per-year tiers, while explicitly treating
   only names as required. Earlier navigation/DOM timeouts did not prevent
   collecting the narrative facts and are not established as the C2 cause.
4. Actual final verifier requestad26f0889a91 at22:04:19.676241Z SHA
   b7581c5239d691ba72e0e04c84c30ccae21b6724038f85da7e5bcdf2b5e3a5ec;
   response22:05:17.894902Z SHA
   aca1ac508fc2876615597e51055e8892c89ddba14c9398edf21c3b6fbed3c4f5.
   It returns task_completed=true, score1.0, and15 objects containing only name.
   Its reasoning says: “The optional sponsorships file pointers are omitted
   because no files were downloaded.” The actual response schema thus permits
   omission of requested facts; success under it is not success under the goal.
5. The returned completion at22:05:30.926Z and root final summary preserve the
   names-only output. The independent declared task judge correctly rejects C2.

Source helpers/llm.py447–520 defines the asymmetric top-level/nested vocabulary;
792–872 validates the native generated fields and returns them, rather than
inventing absent semantic requirements. The prompt asks for concrete types,
explicit properties and file pointers for open-ended collections. The exact
request contains this code-owned contract. It is not the R24 public/internal
session_file_pointer transport mismatch: these fields are admitted and passed
through. The original generator's optional-file choice is independently wrong
for the requested delivered facts, but the nested type restriction is not by
itself proof that permitting nesting fixes the full benchmark. Legal flat
sponsor/year/tier rows and inline strings already existed. No model-intelligence
classification or deterministic repair is established without controlled proof.

Archive searches were `nested schema file_pointer required optional years tiers`
and `structured output omits fields generator nested object`. Read Solution and
Human feedback for Oct24 union-typed-parameter serialization and Sep4 disabled
verifier field completeness. These are related contract/evidence lessons, not
this original first-bad boundary. R24 r1 remains a separate admission repair.

## Solution

No runtime candidate or speculative test in this bounded intake. A coherent
next repair lane is general structured-schema expressiveness and semantic
coverage: preserve a model-authored nested year/tier shape if that is the chosen
shape, and prove propagation through generation, public/internal normalization,
verifier and final output without a task-specific field injection. But simply
broadening a literal or forcing missing requirements from task keywords would
not prove this outcome and would alter an authority boundary without causal
coverage. Likewise making every optional field required can demand nonexistent
files and is not justified here. Flattening or file output remains a legitimate
model choice when it actually delivers all requested facts.

A next owning offline control must start from these original schema requests and
outputs, distinguish valid flat/inline/file alternatives, preserve optionality
when genuinely optional, and avoid inferring facts or artifacts. Exact unchanged
benchmark outcome remains OPEN. No prompts, schemas, task criteria, step/time
caps, provider settings or original grades changed. No new model call, screenshot,
API/DB/provider request or image output. Investigator token usage UNMETERED.

## Bounded recursive-capability follow-up

The authorized follow-up checked latest main exactly once. Isolated merge
4568a26854b73fe8a6438cf2835fbab06bc13121 combines66eb and
d3a6498e7c37fca892ac9bca0f3486f3cdb855bc; the only delta is236 factory-history
rows. No runtime/dependency/schema changes, DB refresh or parent update.

A local desired-contract control exercising actual `_GeneratedResponseSchema`
and `_generate_response_schema_with_rose` with a mocked native response rejects
nested `list[object]` at fields.0.properties.1.type. This proves current
representability, not that the original model would choose a corrected shape or
that the task would pass. An initial test-runner constructor error was corrected
before recording these intended baseline failures; it is not causal evidence.

More decisively, a typed recursive Pydantic model passed to the actual generator
wire entrypoint `providers.rose.schema.build_openai_response_format` raises
RecursionError through prepare_schema_for_openai and _inline_refs. The direct
native prepare function and older helpers.llm.prepare_schema_for_openai exhibit
the same eager-reference-expansion behavior. No provider request was made.
Thus a recursive DTO alone would break serialization before the native call.
Preserving recursive refs changes the existing no-ref provider compatibility
contract; finite unrolling introduces a different depth bound. Neither shortcut
was proposed. Generator projection also currently copies only one nested level.

The bounded round stops without a runtime candidate or GREEN claim. Existing
flat/inline alternatives mean semantic model causality and full outcome remain
unproved. A future generalized capability must establish an explicit supported
provider representation and complete generator/dispatch/pointer/verifier
coverage. Existing R24 repair remains independent and unchanged.

## Human feedback

Parent required a fresh original trace rather than assuming R24 recurrence,
kept live source66eb frozen, prohibited task/criteria/cap/model changes, and
requested a bounded evidence-first result for review. The initial generic
failed-root lead was corrected: this root completed and the task judge failed C2.

## Reusable lesson

Trace the actual generated schema through delivered output before treating a
schema-valid completion as coverage of every user-requested fact.
