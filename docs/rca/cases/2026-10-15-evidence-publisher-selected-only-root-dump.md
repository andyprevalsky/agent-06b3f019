---
id: 2026-10-15-evidence-publisher-selected-only-root-dump
date: 2026-10-15
title: Evidence publisher ignored later captured descendant calls
surface: harness
component: evidence-publication
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: main selected latest_dump_for_agent(root) without the captured task tree
symptoms:
  - last LLM dump is older than a captured child execute_loop
  - publisher selected only the root dump directory
tags:
  - evidence
  - llm-dump
  - descendant-tree
sources:
  - PR #1453
  - commit fa0314af031672bcc79f644ad865dfdea6d08fd2
  - benchmark run wmh-run18-e9afcffd-1792021429
repro: scripts/tests/publish_evidence_links_composite.test.sh
status: fixed
---

## Problem

After Run18 ended, the publisher rendered the root's recorded call at timestamp
1792022900143 even though an owned descendant had an execute_loop dump at
1792025450197. A separate scan of all 30 captured actor directories caught the
incorrect evidence selection before the semantic approval was presented.

## Diagnosis

The selector only searched `.llm-dumps/<root>`. The canonical run already held
the descendant IDs and parent edges in `tasks[].logs.tree`, but `main` never
passed that ownership information to selection. This was missing scope at the
interface, not a failed dictionary-versus-array parser. The same assertion on
the actual captured tree failed before the repair (2.734s) and selected the exact
latest descendant after it (2.694s).

## Solution

Pass the captured bundle to selection and traverse parent edges from the
requested agent. Select the latest recorded file only among that owned subtree.
Keep explicit `--dump` overrides and root-only operation without a run bundle.
The registered composite regression covers children, grandchildren, unrelated
newer files, and ordinary root-only selection. Browser termination, recording
attachment, FE verification and rendering checks remain unchanged.

The actual descendant dump was explicitly published and the existing Run18 FE
bundle reverified in a fresh browser (135 messages). The original root-only
publication is preserved privately. This fixes selection among captured calls;
it cannot invent dumps for calls configured not to record context and does not
change Run18's fundraising FAIL verdict.

## Human feedback

The user authorized infrastructure repairs automatically and reserved explicit
approval for WHM context or runtime context-acquisition changes. This repair
changes diagnostic selection only; the separate wire-schema proposal remains
unapplied pending that semantic decision.

## Reusable lesson

Carry captured ownership scope into evidence selection before choosing the last
recorded call.
