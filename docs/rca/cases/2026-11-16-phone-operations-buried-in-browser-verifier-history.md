---
id: 2026-11-16-phone-operations-buried-in-browser-verifier-history
date: 2026-11-16
title: Phone operation receipts lost in browser verifier compact history
surface: harness
component: browser-verifier-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_browser_verifier_context limits phone request and result evidence to its 30-entry compact action_history instead of independent operation receipts
symptoms:
  - truncated history contains no visible Send invocation
  - verifier truncated 32768 chars from action_history
  - Read 6:26 PM
  - outgoing_message.send_count is only a count of visible invocations
tags:
  - phone
  - browser
  - verifier
  - evidence-truncation
sources:
  - commit 61126ffe11261e6f67eed343914d81859ba3fcbb
  - agent b82a6edb-e5e9-4b17-834d-0aa8f1171057
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_phone_canonical_receipts_survive_window_and_observation_budget
status: open
---

## Problem

The production cloud-phone task sent its authorized message once, then repeatedly
received 50% browser verifier scores. Original TOOL rows
666af30b-40b5-41dd-9a1d-a5378c508cd6 (02:28:08Z),
901d139f-df47-4d97-92bb-ebab1ddd250f (02:37:01Z), and
91fac9da-2061-4d75-86e6-4703041b666d (02:43:58Z) retain the actual admitted
verifier text. Their compact histories omit 23554, 36341 and 32768 characters.
The latter two histories start at steps73 and93 respectively; the original
Send was step47, outside either 30-action window. Rejection TOOL
aacb754b-70ab-4373-8a26-99ff17b988da explicitly reports missing Send evidence.

The original actor request/result dump and the encrypted 141-action resume
snapshot agree: input.text step45 wrote the exact requested text; input.tap
step47 has operation ID eed10ccf9e5dce40f81d81e056f1dd5601236ede39f975c0265c3e6731e4b700
and status SUCCEEDED; screen.text step48 has operation ID
00e6d2cfb1106ede1c31fd8400b9679fab604ff3eaf93173ab55f84cb774572c and returns
pixel OCR with the outgoing text, iMessage hint and Read 6:26 PM. These are real
phone tool results, not evaluate returns. No phone action was replayed.

## Diagnosis

Critical path: phone provider receipt -> ActionHistory ->
build_browser_verifier_context -> build_verifier_context_messages -> verifier.
The history retains the real operations. The first bad projection selects only
30 actions and emits them as one action_history TOOL_RESULT; only native browser
reads and evaluate returns previously had separate receipts. The generic 12000
character per-tool cap then cuts the middle of the remaining phone history.

The exact 49-action capture replay loses 20 operation IDs (steps27–46) while
using only12269 of160000 total tool-result characters. This is per-tool evidence
loss, not total-context exhaustion. Subsequent 102/122/132-action projections
also exclude the old Send before admission. Extending the October28 evaluate
repair to phone receipts addresses this same class at its owning projection.
The archive searches were `action_history truncated canonical` and
`Delivered Sent Read verifier`; the relevant prior case is
2026-10-28-browser-evaluate-results-buried-in-compact-history. Its lesson applies:
compact history cannot be the sole canonical operation evidence. Its native/
evaluate admission repair does not cover phone operations.

A distinct contract inconsistency remains: generated status is a required
nonempty string described as "Observed delivery status: Delivered or Sent." It
has no enum. The first verifier explicitly accepts Read as stronger confirmation;
the later verifier asks for Delivered/Sent separately. No schema parser rejection
of Read was reproduced and no status schema or prompt was changed. Original
verdicts also cite independent incoming-message protocol/window evidence gaps;
this repair does not prove overall task completion or justify a100% score.

## Solution

Candidate adds independently attributed phone request/result receipts from all
recorded actions, through existing privacy projection and unchanged12000/160000
caps. It keeps the latest native browser observation and latest phone screen,
then merges phone receipts with other per-operation evidence by descending step. Receipt identity, cursor, request arguments, actual result, failures,
unknown outcomes and duplicates remain intact; no send count is synthesized and
no receipt is promoted to independent browser DOM truth.

Captured replay of the actual141-action snapshot cut at49/102/122/132 preserves
exact text45, Send47 and first Read48 at all four boundaries. The102/122/132
requests still hit the unchanged160000 cap. Actual later IM/SMS receipts93/95/101/105 also survive122/132. Older or sufficiently
large histories can still exceed the unchanged caps: this is not a claim that
arbitrary history fits. The original run was not resumed or resent.
Deployment, paired exact-model replay and production outcome remain parent-owned.

Registered controls cover old input plus first observation under75 bounded newer reads,
an explicit75x7000-character capacity negative retaining latest evidence while
omitting old input rather than inventing it,
latest screen protection when apps.list follows alternating input/read traffic,
failed/unknown results, duplicate identity, privacy and independent contradictory
browser evidence. The suite runs in deploy lane agents-blackbox
spawn-browser-agent-v3. Captured local command:
`source agents/venv/bin/activate; PYTHONPATH=agents python /tmp/rca-b82/full-repro.py`.
The unchanged49-action command failed on original source (step45 missing) and
passes candidate; full102/122/132 candidate projections preserve all three
critical operation IDs. No full-task success claim follows from this transport
replay. Parent owns final publication and golden-reference review.

## Human feedback

User required read-only investigation initially, no phone actions, no resend,
no fabricated status, no independent deploy, and parent coordination. Parent
subsequently authorized only service.py, existing browser blackbox tests and
this case. Independent review caught latest-screen starvation under alternating
inputs and a later apps.list; both are covered by the final regression.

## Reusable lesson

Preserve native operation identity and its first observed result outside lossy compact history while keeping context limits and incomplete-evidence claims honest.
