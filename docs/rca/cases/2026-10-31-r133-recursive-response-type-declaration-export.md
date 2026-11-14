---
id: 2026-10-31-r133-recursive-response-type-declaration-export
date: 2026-10-31
title: Recursive response-schema type was private in exported declarations
surface: back-end
component: agents-response-schema-types
classification: our-bug
problem_class: other
first_bad_boundary: Public create and update schemas inferred a recursive type that its defining module did not export
symptoms:
  - TS4023 in createAgentSchema
  - TS4023 in updateAgentSchema
  - TS4023 in batchCreateAgentsSchema
tags:
  - r133
  - typescript
  - declaration-emission
sources:
  - commit 691b9059a9ca3b41552be9679d712b50edcf24d5
repro: Compile agents/types.ts with declaration emission; three TS4023 errors before the type export, no errors afterward
status: fixed
---

## Problem

The required backend type check reported three TS4023 errors. The public
createAgentSchema, updateAgentSchema and batchCreateAgentsSchema values referred
to NestedResponseSchemaField from responseSchema.ts, but that recursive type was
private. The two source files had not been changed by the credential-provenance
repair that exposed this integration gate.

## Diagnosis

The failure reproduces using the existing types.ts entrypoint alone with
`tsc --declaration --emitDeclarationOnly --skipLibCheck --target ES2022 --module
commonjs --esModuleInterop --strict`. This isolates declaration naming from the
new credential-message module. A separate scratch full-tree comparison initially
resolved different Node ambient types and produced unrelated missing browser
name errors; that comparison was not used as evidence of the original cause.

## Solution

Export the existing NestedResponseSchemaField type. This is a type-only export;
its fields, recursive constraints, Zod validation and runtime JavaScript behavior
remain unchanged. The same focused declaration command passes after the single
line change. The full backend `tsc --noEmit -p back-end/tsconfig.json` then passes
with the actual installed dependency environment. No task, prompt or benchmark
result was changed, and this compiler repair establishes no task-success claim.

## Human feedback

No additional human feedback was recorded for this compiler issue. The standing
instruction is to complete the benchmark goal and its required verification.

## Reusable lesson

A public inferred schema can expose a private recursive type indirectly. Export
the type used by its public declaration rather than weakening validation or
turning off declaration checking.
