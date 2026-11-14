---
id: 2026-10-29-nested-response-schema-finite-native-wire
date: 2026-10-29
title: Deeper output schemas require a finite native wire and recursive canonical admission
surface: cross
component: response-schema-native-public-boundary
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: generated and public nested-field literals reject object properties below the first level while the native converter cannot inline recursive references
symptoms:
  - fields.0.properties.0.type rejects object
  - recursive native schema conversion raises RecursionError
  - legacy field named nodes collides with a proposed native envelope
tags:
  - schema
  - native-wire
  - nested-output
  - r30
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - plan: FLAT-RESPONSE-SCHEMA-E2E-V2 exact patch 567522282a8c16d1db80e41e487f91b0caeec899ef26fc2aa5c0aa17a5077e5b
repro: agents/tests/blackbox/tool_schemas.blackbox.py::test_recursive_response_schema_public_and_native_wire
status: mitigated
---

## Problem

The R30/R34/R36/R37 investigations exposed a representational limit: the native
generator and public nested-field DTOs permit primitives and file pointers but
not another object/list of objects below the first level. This is not proof that
any historical model chose a file pointer because of that limit, nor that any
original task would pass with a richer representation. Original FAIL/infra
values and evidence gaps remain unchanged.

The isolated source-bound control presents an ordinary nested directory to the
actual public DTO and fails at fields.0.properties.0.type. Replacing native DTOs
with recursive definitions alone causes the existing eager no-reference
converter to recurse indefinitely. A generator-only prototype was stopped at
that public/native boundary before a separately authorized complete proof.

## Diagnosis

The canonical dictionary consumers already recurse for verifier models,
constraint checks and internal/public file-pointer conversion. The missing
capability spans generator DTOs, native tool schema projection, typed public
admission and backend create/update validation. It cannot be solved safely by
raising context/token budgets, dropping constraints, keeping unsupported
references, or bypassing validation.

The finite typed node-table proof preserves field identity, parent, sibling
order, type, requirement, nullability, description and bounds. Strict decoding
rejects duplicates, orphans, cycles, invalid bounds and empty containers before
building the canonical nested dictionary. The actual native format builders,
full execute envelope, spawn/no-GP/phone argument validators and nested
verifier were exercised offline. No live model or provider was called.

## Solution

The exact independently GROUNDED V2 patch uses class-specific Pydantic
validation-schema hooks and a strict finite wire decoder. Canonical model
serialization remains nested. Generator projection and public/backend DTOs
accept nested object properties; the backend validators move to a cohesive
module while keeping their original exports. Existing file-pointer guidance,
legacy coercions, title/cache behavior, model routes and all hard budgets remain.

V1 incorrectly treated a supported flat description map whose field was named
nodes as a wire envelope. The independent review rejected it. V2 performs the
existing JSON/list/string-map normalization before strict wire decoding. The
same permanent regression passes original source, fails V1 and passes V2 for
both dictionary and JSON-string forms, while malformed actual envelopes fail.

Before application, the actual registered Python suite passed 66 controls;
14 existing metadata/title/cache/auth controls and backend create/update unit
controls passed. All three touched TypeScript files passed targeted lint. The
full backend typecheck retained exactly 12 baseline browser-global diagnostics;
Ruff was unavailable. These limitations are not clean gate claims. Independent
review reproduced the registered suite and additional native-provider formats.
After exact application, all seven file hashes matched, one actual registered
capability control and the targeted backend checks passed again.

This is a source capability mitigation, not a historical benchmark repair or
real-model acceptance claim. The separate backend schema generator stays
shallow; phone extraction retains its existing top-level description behavior.
Large generated schemas can still hit unchanged model budgets. The live run
and its frozen source were never changed by this isolated branch.

## Human feedback

The parent stopped a generator-only prototype, then explicitly authorized the
bounded complete public/native proof. It required unchanged no-reference
provider conversion, no Any/depth cap, no task-specific answers and no task PASS
claim. The fresh reviewer found the nodes-name legacy-input regression and
required a same-input permanent control before granting V2 grounding. A new
native instruction or DTO byte change requires fresh review.

## Reusable lesson

Separate a finite native wire representation from canonical typed data, and test legacy coercions plus every shared schema embedding before claiming compatibility.

## R44 original occurrence: BU058 run 2

Original It13 job r002-j0023, root13f8a5a5-f4a2-4694-bdac-cdee15dffe21,
executed765caac00ce085dd0359b8342161a8717be7446d. Archive
f2b002473b9811fb3b0ed1154617f52b46d380041880217fa76da543bd6b7eda and
normal manifest e4b316cefbd384f0e40306b8f3abc8cc913f0fbbcc8f82675c5803bc5f4f15d2
were independently checked; all seven member sizes and hashes match.
Native FAILED after2880.3s, benchmarkFAILED and infraFALSE remain unchanged.
This is not a regression of the unexecuted qualified next source.

The actual schema request at00:34:26, SHA
 da1169bcfb6c1583e2bd08b4dc7319dc634ea9cc7ad7732ddaab8245e76f5f7f,
exposes the restricted nested-field enum without object/list[object] or another
properties level. Its actual response SHA
15e5c9247d3055de1698b137d70c0f11e5d0f5ffb02a61cc332b02d7fa7579d1 reasons
that year/tier object pairs are appropriate, then emits required tiers as four
to five session file pointers for each sponsor. The browser receives that shape.
The restriction and emitted shape are observed; this does not isolate the
model's reason for choosing files.

Verifier request SHA
5b18a0089d76771874a0325cf84d5fff9b83777e9a6055975768364c2435eb82 and response
0353259d6438309e21828009f407b34d5d9b900d699e878bbf239b475e8b8d8c show fifteen
sponsor names/years with empty tiers, task_completed=true and score0.5. Tier
values are described in reasoning, but the verifier explicitly says the
required session files do not exist. Subsequent request
944cf3a825b8a95ab439acc7a38205dfdbac4bdb0d28818f11b5ce3ae889a89e and response
0509bccd085342230052e12252a2492abc752cee9d88b3bd47345d23048dba55 repeat the
missing-file boundary. These are model assertions, not independent validation
of all researched sponsor facts. Schema validation correctly rejects empty
required lists. The actor continues attempting downloads/file creation until
max_iterations100 at01:21:43.949Z. A later browser-pause HTTP500 is a separate
cleanup observation; it does not explain the earlier representation contract.

Unlike R36 run1's optional omitted-tier output, this occurrence does not admit
completion without required tier files. It is appended to the existing bounded
schema-capability family after reading the original request/response and prior
case, not inferred from task name. No duplicate runtime fix, model replay,
timeout/step increase, task/rubric edit or original PASS claim is justified.
The existing finite-wire mitigation remains source-qualified only; R44's actual
unchanged-task outcome stays OPEN. Tokens UNMETERED.
