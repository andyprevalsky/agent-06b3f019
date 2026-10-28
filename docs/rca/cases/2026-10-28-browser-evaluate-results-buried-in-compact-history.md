---
id: 2026-10-28-browser-evaluate-results-buried-in-compact-history
date: 2026-10-28
title: Browser completion verifier loses executed evaluation results inside compact history
surface: harness
component: browser-verifier-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_browser_verifier_context flattens evaluated results into one action_history TOOL_RESULT subject to the 12000-character cap
symptoms:
  - Polar BU025 run1 repeatedly rejected completion for missing middle result rows
  - First verifier action_history omitted 32431 characters
  - Later verifier timeouts ended in the existing 3000-second activity timeout
tags:
  - polar
  - browser
  - evidence-truncation
sources:
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - agent 84025605-2f58-4d73-b628-c0cc9ce18059
  - fleet run 20261028-021139-15593
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_browser_evaluate_receipts_survive_compact_history_truncation
status: open
---

## Problem

It7 Polar BU025 run1 genuinely failed after3010.6s; this is not a reclassification.
Browser98a1ecc3-78ca-50a7-89a1-fae2ff0b0f95 performed real work. Successful
evaluate steps37–41 returned five chunks containing944 title/score/review-count
triples. The first completion verifier received only a head/tail slice of the
combined history and explicitly rejected the missing middle evidence. Four later
420s progress-check cancellations and an outer3000s StartToClose timeout followed.
Their underlying provider/deadline cause remains unknown; the evidence does not
prove this transport repair alone would have prevented the terminal timeout.

Normal verified shard01 export packet SHA256:
40138fb24ac7dc77d737760d3a95d45098086ed8dbb409633cc205fec102ff6d.
Actor dump cf95bb3380d1 SHA256:
a2fb2c00324c0ffbb798a1525ddde94d31ac6c7df3597f2701fd742b68adeb79.
First verifier df9e98f25ce5 SHA256:
8b5b662cce2ed06912e0c3658b25d8a153b62c31157b76ce7cfa11bafc6693a1.
All extracted locally from captured worker logs; no new provider calls.
Same-task sibling340acd48-4023-4b02-9d4e-99c2bedfebbf passed in312s with three
shows. That does not establish the failed run's944-row completeness or correctness.

## Diagnosis

The first verifier prompt contains `verifier truncated 32431 chars from
action_history`. A middle title present in the actual step39 result is absent
from that prompt. `build_browser_verifier_context` bundles up to30 actions into
one ordinary tool result. Existing admission correctly caps that individual body
at12000 characters. Native read_browser_state observations already have separate
step-owned receipts; evaluate returns had no equivalent path.

The request code and its returned data must remain together. Executed JavaScript
can fabricate or misinterpret data, so its output is attributable tool evidence,
not independent DOM confirmation. No missing row is reconstructed from an agent
summary. No per-step observed URL is invented: ActionHistory does not record one
for these entries, and final page identity is a separate existing observation.

## Solution

Emit recent evaluate params and success/error/value as separate step-owned tool
receipts after native DOM observations. Retain the same30-entry history window,
12000-character individual cap and160000-character total cap. The admitted title
explicitly says these are recorded JavaScript returns, not independent DOM
confirmation. Failed outputs remain failed; duplicate/conflicting entries stay
separate; absent values are not fabricated. Existing privacy projection applies
before assembly and again through the normal browser verifier caller.

No task, schema, actor policy, evaluator criterion, timeout, TLS policy, retry,
or score changed. Native page evidence retains admission priority. Large
individual outputs and older data can still be omitted under existing limits.

## Reproduction and validation

Two permanent controls run in the existing registered browser blackbox suite:
`test_browser_evaluate_receipts_survive_compact_history_truncation` and
`test_browser_evaluate_receipts_keep_failure_conflict_privacy_and_caps`.
The baseline loses middle sentinels; the candidate preserves request/result
pairs. Controls also cover real ActionHistory secret masking, failed outputs,
conflicting duplicate steps, missing values, native contradictory text, and
unchanged truncation. No model result or task grade is mocked as a pass.

A separate local capture replay starts with the original admitted text untouched
(117959 tool-result characters), then admits the candidate's actual new receipt
payloads with the real budget helper. It reaches160000 exactly, preserves all
five complete request/result chunks and their944 titles, and retains the warning.
This is a bounded admission counterfactual, not a model rerun. An earlier harness
attempt incorrectly parsed truncated JSON and is withdrawn; corrected replay
keeps original text opaque. A conservative rewrapped-text probe is supporting
only and does not replace the exact original-text admission check.

Applied-source owning suite:14 context, private-state, native observation,
checkpoint and payment receipt controls pass. Source/test bytes exactly match
the independently reviewed snapshot; full task outcome remains unproven.

## Grounding and review

Local references: service.py existing native-observation receipt path;
helpers/llm.py structured-result/title serialization and unchanged budgets;
ActionHistory model-visible projection; handler browser verifier privacy path.
Opened Codex14ff9c3a43ebf9bf543cf5f7c45cff2bfea2e512
`codex-rs/tools/src/tool_output.rs:13–18,155–180` distinguishes lossy logs from
model-facing call-bound JSON outputs and preserves returned value/success. It
supports identity-preserving transport, not truth of evaluated data or Rose's
numeric bounds. File SHA2561541422b97b31345461a70721ac7944e22c7fd5cfd427127d8d295e3161e18f5.

Independent reviewer ph74rex3pescaywbxyjn3njr158h3pp9 grounded final two-path
patch10a7400e92bdb11fecd17563a709a213f7b79a201eadb2d3a19bb08dcecfafe5
before application. First snapshot was rejected because its warning lived in
TOOL.text while structured_response replaced that text in the admitted payload.
Final snapshot puts the warning in supported metadata.title and tests the actual
admitted body. The rejected snapshot was never applied.

## Human feedback

Parent requested source-only RCA, unchanged genuine FAIL, no live rerun or TLS/
timeout relaxation. No production, provider, resource or Freedom mutation.
Next evidence needed: scheduled unchanged BU025 run with complete verifier input,
real final task grade and lifecycle/recording receipts. Provider timeout cause and
full944-row correctness remain open; no acceptance credit from this repair.

## Reusable lesson

Keep executed request/result evidence as bounded per-operation receipts. A compact
log is a summary, and preserving tool evidence does not establish that its
claims are true. Test the actual admitted model payload, not just its input.
