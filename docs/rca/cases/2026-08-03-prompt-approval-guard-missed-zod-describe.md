---
id: 2026-08-03-prompt-approval-guard-missed-zod-describe
date: 2026-08-03
title: Prompt approval guard missed LLM-visible Zod descriptions
surface: harness
component: prompt-approval-guard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/check-prompt-human-approval.sh is_prompt_content omitted chained Zod describe calls
symptoms:
  - Prompt human-approval guard reported no prompt edits after adding an LLM-visible Zod describe call
  - FAIL expected fail Zod schema description requires approval
tags:
  - deploy
  - prompt-approval
  - zod
  - guard
  - tool-schema
sources:
  - memory: deploy run 20260804-021042-9074 prompt-approval stage
repro: scripts/tests/check-prompt-human-approval.test.sh
status: fixed
---

## Problem

The approved SMS supervisor change added a multiline Zod `.describe(...)` call
whose value is serialized into the response schema sent to the LLM. Running
`bash scripts/check-prompt-human-approval.sh` without the mandatory approval
flag incorrectly exited zero with `Prompt human-approval guard: no prompt edits
or coverage deletions detected.` A future unapproved Zod tool description could
therefore pass the deploy guard.

## Diagnosis

The guard first collects changed files, then combines filename classification
with an `awk` diff scanner. A generic file named `schema.ts` does not match the
prompt filename patterns. The diff scanner recognized object or Pydantic-style
`description:` assignments, but not chained Zod `.describe(...)` calls. Because
the approved description string began on the next line, neither changed line
matched another prompt-content rule.

The first bad boundary was the prompt-file classifier plus
`is_prompt_content`: together they encoded some model-visible description
syntaxes but omitted the Zod syntax already used to generate LLM JSON schemas.
The deeper boundary was the line-oriented heuristic itself: matching only a
new `.describe(` line would still miss a content-only edit inside an existing
multiline call. The deepest cause was a logical inconsistency in the approval
contract—prompt detection depended partly on changed-line spelling rather than
the model-schema construction context.

The first temporary-repository regression added a multiline Zod description and
expected the unapproved guard to fail. Before the initial fix, the suite stopped
at `FAIL: expected fail: Zod schema description requires approval` while the
guard claimed no prompt edits. Adversarial review then identified the
content-only edit gap; its added regression failed with `FAIL: expected fail:
editing existing multiline Zod description requires approval`.

## Solution

The changed-file classifier now recognizes JavaScript/TypeScript files that
import Zod and contain `.describe(...)` in either the working tree or base
revision. Classifying the containing file catches additions, deletions, and
content-only multiline edits. It avoids treating unrelated APIs such as
Temporal workflow-handle `.describe()` calls as prompt text.

The regressions prove both Zod addition and content-edit cases require approval,
the mandatory flag permits them, and an unrelated `.describe()` call passes.
After the fix, the full prompt-guard suite passes all cases.

The check is a local diff scan during deploy, not an application hot path. It
adds no runtime queries, state, or agent work and has no 10,000-agent scaling
effect.

## Human feedback

None recorded.

## Reusable lesson

Prompt approval guards must detect every schema API that serializes text for a
model, not only files or fields named `prompt` and `description`.
