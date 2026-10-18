---
id: 2026-10-13-response-schema-validation-omits-field-descriptions
date: 2026-10-13
title: Agent request validators strip response-field descriptions before persistence
surface: back-end
component: agents-response-schema-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/types.ts ResponseSchemaFieldSchema and NestedResponseSchemaFieldSchema omit description from their typed object allowlists
symptoms:
  - Canonical field descriptions before=4, after real validator=0
  - The create-agent response-schema validator must preserve the exact accepted canonical schema
  - Run13 root verifier receives four empty output-field descriptions
  - response_schema descriptions disappear during POST and PATCH request parsing
tags:
  - response-schema
  - zod
  - field-description
  - metadata-preservation
  - wmh
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - commit a389797bb65c46796a22ad9690bd57af65f53a0e
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - benchmark run f0a05573-f50e-49c2-b3c9-43b3b90dfbf9
repro: back-end/src/tests/blackbox/agents-response-schema-descriptions.cases.ts
status: open
---

## Problem

Run13 attempted the unchanged `raise-5m-rose-labs-brex` task. Its canonical
response schema contains four nonempty field descriptions, including the
at-least-US$5,000,000 funding condition. The captured root verifier request uses
those same four field names with empty descriptions. The verifier returned
1.0 despite zero fundraising receipts; the canonical benchmark failed. The
schema-preservation defect below is proven, but its causal contribution to that
score or fundraising outcome is **not** proven.

The private canonical schema was compared against `tasks.json` at the paid run's
source commit; they are equal. The actual runner, API route, lifecycle service,
persistence adapter, catalog and validators had identical bytes at that run
source and the initial RCA checkpoint, before the approved validator repair. The raw original HTTP create body was not
retained, so the historical source-to-HTTP hop is source-derived rather than a
captured wire assertion. The captured verifier input independently demonstrates
that its four final descriptions are empty.

This is separate from
`2026-10-13-execute-evidence-scope-discarded-user-specification`: USER-message
filtering has a different first bad boundary. Preserving schema descriptions
does not restore omitted USER messages or prove either issue explains all eight
step-limit failures.

## Diagnosis

Critical path:

1. `agents/benchmarks/run_benchmark.py:2843` copies the task's full response schema
   into the create-agent HTTP body.
2. `back-end/src/domains/agents/routes.ts:157` invokes `createAgentSchema.parse`.
3. Both field validators in `domains/agents/types.ts` use Zod objects whose
   default unknown-key policy strips keys absent from the declared shape. Neither
   shape declares `description`, although the frontend public schema type does.
4. `agentLifecycleService.ts:212` passes the already parsed schema into
   `repoMutations.ts:159`, which writes it without restoring annotations.
5. `agentQueryService.ts:258` returns the stored schema. Python verifier schema
   construction uses `field.get("description", "")`, retaining empty strings when
   the input annotation has already disappeared. PATCH uses the same validator
   through `updateAgentSchema`, so both create and update exhibit the defect.

What: Valid caller-provided schema annotations disappear.
Where: The two response-field allowlists at the initial API parse.
Why: A typed producer annotation was omitted from the consumer schema, and the
existing strip policy silently removes it before downstream consumers run.
Proof: The actual current validator changed the exact canonical object from four
nonempty descriptions to zero, failing the unchanged equality assertion.
Problem: Producer/consumer response-schema contract drift that discards accepted
semantic field annotations at validation.

The deepest proven owned cause is the missing typed vocabulary at this boundary.
No model-only replay, exact failed-call replay or unchanged canonical benchmark
has established model intelligence or the degree to which annotation loss caused
premature completion. Do not turn a populated-output check into a claimed
five-million-dollar success condition by changing the evaluator.

Archive searches:

- `response_schema description Zod` found prompt-approval, schema-generation,
  purchase-classifier and schema-timeout relatives; no matching strip defect.
- `schema metadata fields stripped validator preservation` found strict
  provenance vocabulary drift and private-copy-test relatives; no recurrence.
- Literal code/text scan for response-schema description loss found no prior
  matching case. This is a novel defect related to
  `2026-10-05-fleet-cache-policy-provenance-schema-drift` and
  `2026-09-29-purchase-noun-markers-classified-offer-as-buy`.

The completed `prompt-audit-fixes.md` plan was read; it documents schema ownership
and original-user-context concerns but no deliberate removal of caller-provided
field descriptions. No existing validators, task, evaluator or fixture were
modified during this investigation.

Executed local proof, no provider/service/agent calls:

- The existing canonical repro imports the actual task-source validator:
  `node --import tsx .context/whm-migration/rca-20261013/steps/root-schema-validator-repro.ts`.
  Exit 1: `Canonical field descriptions before=4, after real validator=0`,
  followed by the exact-object assertion failure. Its detailed output is private.
- The private owning cases run unchanged with:
  `node --import tsx .context/whm-migration/rca-20261013/schema/owning-validator-repro.ts`.
  Baseline: 3/8 passed, 5 failed, 97.355 ms including module import/test execution.
  Candidate: 8/8 passed, 0 failed, 91.682 ms in the same measured scope.
  Only the private active-tree pointer chooses baseline versus candidate code;
  proposed permanent case bodies are byte-identical between those trees.
- Cases cover exact create/PATCH annotation preservation, nested/multiline/Unicode
  and empty descriptions, absence parity, all three execution modes, wrong-type
  annotation rejection, existing unknown-key stripping, and unchanged required,
  type, object-properties and bound rejection. The eighth private assertion uses
  the exact captured canonical schema.

Private receipts, raw input, baseline/candidate code, logs and reviewable diffs
are under `.context/whm-migration/rca-20261013/schema/` (directories 0700,
files 0600). No private message history, env file or credential is included here.

## Solution

User approved on 2026-10-13; **applied**: add `description: z.string().optional()` to
both field shapes. This preserves caller text exactly without adding a prompt,
rewriting fields, deriving schema from keywords, relaxing bounds or enabling
`.passthrough()`. Wrong-typed descriptions become validation errors rather than
being silently discarded. Top-level and nested descriptions share the correction.

Simplification assessment: deleting validation or making the entire schema
opaque would lose existing required/type/bounds contracts. The two field shapes
have different type and required semantics; replacing their definitions is not
necessary to repair the proven vocabulary mismatch. The candidate introduces no
routing branch, classifier, global state or alternative persistence path.

Golden references opened before choosing the candidate:

- `claude-code-src/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:131-145`
  validates the supplied JSON schema with Ajv and keeps that supplied schema as
  the model-visible input schema.
- `openclaw/packages/ai/src/providers/tool-schema-refs.ts:22-28` explicitly copies
  `title`, `description` and `default` annotations when reshaping a schema.
- `hermes-agent/tools/registry.py:675-685,857-870` validates schema containers and
  forwards the declared schema, retaining parameters and descriptions.
- `codex/codex-rs/tools/src/json_schema/types.rs:36-46` includes optional typed
  description metadata in the serialized/deserialized schema representation.
  These analogs preserve annotations alongside shape validation; the candidate
  converges on that pattern. The three gitignored clones were read from the
  existing `/home/boxes/rose` checkout without cloning or editing them.

Registered permanent regression: a compact
`agents-response-schema-descriptions.cases.ts` module registered by the existing
`agents-configuration.cases.ts`. The normal `agents.blackbox.ts` runner already
imports that configuration module, and `/deploy` backend coverage runs the
backend blackboxes. The unchanged seven cases now execute through the normal backend agents
blackbox. The existing response-schema API case additionally asserts exact
POST/PATCH persistence and GET readback, including nested Unicode descriptions.
The full agents API domain passed in 29.156 seconds using the supported isolated
blackbox runner, local owned database, fake Temporal and outbound replay.
Prettier, ESLint and TypeScript checks passed. No paid model call or deployment
was performed; exact fundraising outcome proof remains open.

The candidate affects **ordinary real runs as well as WHM runs** because this API
contract is shared. That is a separately reviewable scope beyond the user's
instruction to isolate WHM timeout/provider changes. CLAUDE rule 5 and `/RCA`
require approval before applying Zod edits. The parent recorded the explicit approval, applied the exact production diff
and tested its normal API persistence path. Source remains on draft PR #1453.

10,000-agent behavior: validation remains per-request O(schema size), with one
optional string check per supplied field. No provider calls, DB queries, shared
locks, retries, polling, fan-in or cross-agent state are added. Preserved text
increases each request/row/model schema only by its existing caller annotation
bytes. No prompt text, benchmark criteria, runtime identity or ownership changes.

Independent adversarial review completed with PASS; its original receipt is
preserved privately. The user approval, registered suite and full API persistence
gates have now passed. Remaining gate: exact unchanged benchmark pre/post outcome
proof before calling the fundraising issue fixed.
No additional paid trial, merge or deploy was authorized or performed.

## Human feedback

The user requested one subagent per issue and `/RCA`, previously insisted that
non-WHM harness runs remain unaffected by WHM reliability changes, and required
progress toward a realistic round closure rather than equating progress to cash
alone. The current work therefore prepares this shared API correction privately
and discloses its ordinary-run scope instead of applying it under WMH migration
or run authority. The user subsequently said “Approve schema descriptions” and “Demo cache
reporting approved”, rejected unmentioned proposals, required the static full
network in the WHM startup prefix, and directed inspection of Rose completion
recovery for validation failures. The WHM USER-context proposal was not approved;
its source remains unchanged. No paid-run or deployment approval was added.

## Reusable lesson

Preserve declared semantic field annotations at the request-validation boundary while retaining existing shape and bounds checks.
