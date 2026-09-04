---
id: 2026-09-04-disabled-verifier-counted-any-file-as-schema-complete
date: 2026-09-04
title: Disabled verifier counted any extracted file as a schema-complete result
surface: agents
component: spawn-claude-code-agent-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py:_run_verifier
symptoms:
  - disabled code-agent verifier scores 1.0 when one of two required files exists
  - structured response is null while verifier score reports success
  - incomplete output schema passes when ROSE_DISABLE_CODE_AGENT_VERIFIER is set
tags:
  - claude-code
  - verifier
  - output-schema
  - incomplete-artifacts
  - harness-contract
sources:
  - PR #1246
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py:test_run_verifier_disabled_rejects_schema_incomplete_artifacts
status: fixed
---

## Problem

With `ROSE_DISABLE_CODE_AGENT_VERIFIER=1`, a successful code process received a
1.0 score whenever at least one file was extracted. A schema requiring two
separate file pointers could therefore return success with one artifact even
though structured-response construction correctly returned `None`.

The permanent regression supplied two required `file_pointer` fields, one
extracted file, and exit code zero. Before the fix, the runner logged
`has_artifacts=True`, `has_structured_from_files=False`, and `score=1.0`; the new
test failed on the expected 0.5 score.

## Diagnosis

Archive searches for `disabled verifier schema incomplete artifact`, `one file
two required file pointers score success`, and `structured response null score
one` found related verifier-contract cases but no exact recurrence.

The normal structured-output helper already knew that one file could not fill
two pointer fields. The disabled branch discarded that schema information and
reduced artifact validity to `bool(extracted_output_files)`. The first bad
boundary was therefore the skip-path score predicate, and the general problem
was a logical inconsistency between two paths implementing the same output
contract.

## Solution

The disabled branch now derives its artifact predicate from declared file
fields and delegates completeness to the same structured-response constructor
used for the returned result. Schemas without file fields are artifact-complete
without inventing an output-file requirement; any file-bearing schema must
produce a non-null structured response, including list and multi-file shapes.

The new case is explicitly registered in the spawn-Claude-code-agent blackbox
runner. The same runner passes the incomplete two-file schema, empty schema,
mixed Collatz schema, failed-process artifact, and normal verifier cases.

## Human feedback

The user insisted the isolation work be finished, cemented, and deployed after
the prior review cycle found this blocker.

## Reusable lesson

Keep skip and fallback paths subject to the same schema-completeness predicate as the primary verifier path; never approximate a typed schema with file counts.
