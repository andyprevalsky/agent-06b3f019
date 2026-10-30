---
id: 2026-10-30-r108-native-presentation-mode-shape
date: 2026-10-30
title: Native schema permits a value presentation rejected by canonical validation
surface: agents
component: final-presentation-native-schema
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native presentation schema independently permits null selection and value mode although canonical validation requires a selected field and encoding
symptoms:
  - Native JSON schema accepts mode value with field null
  - Canonical validation rejects value presentation without a field
  - Diagnostic compound output cannot enter the canonical output contract
tags:
  - r108
  - presentation
  - structured-output
  - diagnostic
sources:
  - commit 3a2d10aa7be90491f2042d8857dd319f2e761a60
  - plan:.context/presentation-shape/manifest.json
  - plan:.context/presentation-shape/primary/cerebras-reference.json
repro: registered tool_schemas final_presentation_native_shape with captured diagnostic output
status: fixed
---

## Problem

A separately authorized model-only schema-author experiment produced a native
JSON-schema-valid response with presentation mode value, encoding json, and
field null. Canonical FinalPresentation rejected it because value mode requires
a selected field. This case is a diagnostic-discovered contract bug, not a new
benchmark row or a regrade of an original task.

The role-only experiment made six completions. After the fourth completion's
canonical rejection, the runner recorded a scored validation result instead
of stopping, then made the fifth and sixth calls. That violated the instructed
stop-on-validation-error condition, although the six-call ceiling was not
exceeded. The deviation remains recorded separately; it is not evidence of
successful validation or a reason to retry. The role-only and prior scope
prompt candidates were not qualified or applied.

## Diagnosis

The raw fourth diagnostic result SHA is
ac86fbc00de8ffaf4007c6d12eaa72330bd80c67ce7fe767c204bbd73b5822a0.
Its exact parsed output is preserved as the permanent fixture with SHA
2dda38e1a281a34f7d84ca51f0618d5e7100a9ffa1b0741f119a225e37d3f199.
It asks for two root outputs (records and record_count), with field null in
value presentation. No answer or field was reconstructed for the regression.

FinalPresentation's original Pydantic shape exposed mode as report/value and
field and encoding as independently nullable. Its after-validator enforced
mode-dependent relationships that were absent from the generated native
schema. The actual generated-response-model to OpenAI-response-format to
Cerebras-body path therefore admitted this object before canonical parsing.
The identical owning assertion is RED on the original source and GREEN on the
candidate: the native schema rejects the captured value/null selection.

## Solution

The validation-mode schema now uses separate closed report and value object
alternatives. Report permits null field/encoding; value requires a nonempty
string field and text/json encoding. Canonical runtime validation and output
serialization are unchanged. The registered permanent regression covers the
captured output, ordinary report/null, scalar and JSON value, missing selection
or encoding, incompatible report fields, and canonical serializer behavior.

Patch SHA f315a11edb188d6cb418b1dab1ecea1aa10b43a2a545b552f5b6c3aa92bce669
received independent C GROUNDED review and parent independent RED/GREEN and
preimage/output-hash verification. Postapply actual registered new control,
legacy input, public/native nested schema, invalid graph, mocked generator,
and canonical presentation controls pass. Both changed Python files compile;
archive and whitespace checks are part of the commit handoff.

This fixes only mode-dependent presentation shape. Matching a selected field
to exactly one required nonnullable nonfile output, text/scalar compatibility,
and other semantic constraints remain canonical checks. No generic claim that
all provider-valid output is canonical-valid is made. No model retry, provider
probe, answer substitution, prompt change, or timeout increase was introduced.
Original benchmark outcomes and the schema-author quality question remain OPEN.

## Human feedback

Parent required a structural repair distinct from the unsuccessful prompt
experiments, with the exact captured failure as a permanent test and ordinary
report/value compatibility. Independent review approved only the frozen three
paths. Application is to an isolated future branch; live It26 source is not
changed by this work.

## Primary references and limits

Pydantic's union generation preserves alternative-specific constraints; Hermes
schema-sanitizer tests retain mixed alternatives; OpenClaw demonstrates both
union schemas and relational requirements left to runtime validation. Full
local source hashes are retained in the review packet. These are design and
contrary references, not claims of an identical foreign implementation.

The official Cerebras documentation lists qwen-3.8-27b strict JSON Schema and
non-root anyOf, null, enum and primitive const support. It requires closed
object roots and excludes root unions and conditional/dependent schemas.
Our union is below the root. Documentation also limits depth/properties/text
and does not enforce descriptions; string-length support is model-dependent.
Public documentation supports the shape design but is not live provider
verification of this candidate. No new inference call tested the repair.

## Reusable lesson

Express mode-dependent object shapes in the native schema when the provider
supports them, while retaining canonical checks for relationships the grammar
cannot express. Structural acceptance and task correctness are separate gates.
