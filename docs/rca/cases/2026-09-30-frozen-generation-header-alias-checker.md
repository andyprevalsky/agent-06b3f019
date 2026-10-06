---
id: 2026-09-30-frozen-generation-header-alias-checker
date: 2026-09-30
title: Generation-header structural proof rejected a correctly frozen recording retry dictionary
surface: agents
component: generation-headers-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _test_message_posts_send_the_header searched only the POST source text instead of its local headers assignment
symptoms:
  - "POST to /messages does not send workflow_generation_headers()"
  - "generation-headers failed while recording retry headers remained frozen"
tags:
  - ast
  - generation-header
  - false-positive
  - recording
  - retry
sources:
  - PR #1299
  - commit f10d13fdb42507028fcab0a1550f06ea474bd37b
repro: agents/tests/blackbox/generation_headers.blackbox.py
status: fixed
---

## Problem

Full agents coverage rejected the recording writer's `/messages` POST because
its call received `headers=headers`. The real writer creates that dictionary
with `workflow_generation_headers()` before the bounded pre-request retry loop,
so every attempt preserves the same generation. Its runtime browser blackbox
passed; the owning structural domain failed on the same actual source.

## Diagnosis

The checker searched the rendered POST expression for the literal helper call.
It could recognize inline dictionaries but could not follow a local dictionary
assignment. This conflated syntactic placement with the required generation
attribution. The unchanged registered domain reproduced the failure before the
checker fix and passed afterward through
`cd agents; source venv/bin/activate; python scripts/run_blackbox_tests.py generation-headers`.

Archive searches were `generation header checker` and `blackbox false headers
assignment`. They ran after the initial failing-domain inspection. This is a
relative of `2026-07-27-type-only-import-flagged-as-runtime-circular-import`:
both checkers modeled syntax rather than the runtime contract. The actual
missing-header defect in `2026-08-21-descendant-tool-writes-default-to-generation-one`
is a different boundary and must remain rejected.

## Solution

The owning checker resolves the nearest preceding local assignment in an
unconditional enclosing block. It still requires the generation helper and
rejects the covered uncertain mutations, alias escapes, rebinding, shadowed parameters,
conditional overwrites, loop mutation, with/exception bindings, walrus writes,
and sibling finally/handler mutations. Twenty-three permanent counterexamples cover
valid inline/frozen aliases and invalid cases. Existing symbol, sealed-generation
409, blanket-handler and gather assertions remain registered.

Independent adversarial review first found four reachable binding/finally
bypasses; the final implementation rejects them. The reviewer independently ran
the positive/adversarial checks, the static cases, and the actual recording POST.
Initializer review additionally rejected nested helper calls, overwritten
generation keys, unknown spreads and dynamic keys; five new fixtures failed
before that fix and the same assertions passed afterward.
Diagnostic agents coverage passed 103/103 domains, 162 fast-cache cases and 90
unit cases with the unchanged 80% threshold. That diagnostic used the existing
900-second aggregate domain override; the benchmark domain actually completed
in 278.58 seconds. Final full coverage with the original 300-second aggregate
bound initially passed all 103 domains and its tails/80% threshold in 324.04
seconds, with the benchmark domain taking 253.53 seconds. After the watchdog
fixture and permanent selection were finalized, a source-hashed current-tree
coverage run passed the same 103 domains and tails/80% threshold in 356.48
seconds; its benchmark domain took 278.83 seconds under the original bound.
That current-tree run is the final admission receipt. No production header, recovery,
prompt, model, evaluator or deadline changed. At 10,000 agents this adds zero
runtime work: the analysis runs only in the recurring deploy test process.

## Human feedback

The user required autonomous completion of the original fleet proof, with no
partial results substituted for the ten consecutive slices. This checker repair
is a deploy prerequisite and grants no fleet acceptance credit.

## Reusable lesson

Resolve a frozen local header assignment conservatively while rejecting the covered mutation paths instead of requiring the helper to appear inside the POST expression.
