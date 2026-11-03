---
id: 2026-10-27-autofill-rejected-credential-precedence-unproved
date: 2026-10-27
title: Saved-credential rejection precedence remains unproved after a real-model wrong action
surface: agents
component: phone-auth-guidance
classification: unresolved
problem_class: other
first_bad_boundary: the served model chose phone credentials.fill_saved after native rejection; prompt priority versus intended cross-source policy remains unproved
symptoms:
  - "native_autofill_real_model_controls"
  - "rejected scenario chose credentials.fill_saved"
  - "rose-browser-use 116 passed, 1 failed"
tags:
  - phone
  - native-autofill
  - credential-rejection
  - prompt-precedence
  - model-control
sources:
  - commit 88864ecde0a1d45bbf32cb1ab6c42ed10f9dde94
  - agent 01a17947-78f9-7ee2-b6b1-b01b12172923 deploy 20261027-010544-539506 batch7
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_native_autofill_real_model_synthetic_controls
status: open
---

## Problem

On frozen commit88864ecde0a1d45bbf32cb1ab6c42ed10f9dde94, the native
five-scenario control made real model decisions on synthetic OCR with the actual
pure backend DTO. Four scenarios passed; rejected selected tool `phone`, operation
`credentials.fill_saved`, instead of protected iphone/password help. No device
operation executed. The agents command exited1 after610.5s; the owning domain
reported116passed/1failed in70.05s.

## Diagnosis

All five Foundry attempts returned400 and recovered through Qwen/qwen3.8-27b.
The raw400body was not retained, so that recovered route error has no causal
classification. The completed Qwen output recognized the earlier rejected native
password but prioritized trying a separate backend store. This supports a prompt
precedence hypothesis, not a proved prompt defect or model-intelligence diagnosis.
The retained output replay reaches all five original assertions and reproduces
only rejected (exit1,0.908s), without network calls. No candidate live A/B was run.

The general class considered is ambiguous priority between terminal auth outcomes
and alternate saved-credential sources. The next-deeper class tried was removing
all repeated authentication rules across prompt layers. That is not coherent:
the October24 case measured worse results after deleting a helpful restatement.
That related case concerns server_available/Foundry; today's rejected/Qwen failure
has not been shown to share its first bad cause.

## Solution

No repair is claimed. An exact two-hunk proposal makes rejection/user-presence
stop every source before fallback and explicitly rebaselines the frozen guide-byte
assertion; the five behavioral expectations remain unchanged. Independent review
of patch69c83af327d208bad61dcc6c5f4c410df581c6652d154b2140c9f541a36ae4bf
returned NOT_GROUNDED: this is an explicit cross-source policy decision, not a
reference-grounded clarification. It is not applied or authorized.

A source-locked offline-default paired experiment driver is prepared. Approval is
required before its paid execution or prompt application. Prespecified evidence:
20baseline/20candidate alternating decisions on frozen inputs/settings, a baseline
reproduction of the same bad tool,20/20candidate protected-help outcomes, then the
unchanged five native scenarios (up to3decisions each). Failure, missing/different
actual model or no baseline reproduction stays OPEN; never replace samples.
Private artifacts: .context/deploy-fresh-20261027/rca-autofill-batch7/ and
.context/deploy-fresh-20261027/autofill-golden-review/.

## Human feedback

None recorded for this incident. The snapshot-scoped approval and unchanged
behavior requirements above come from repository/coordinator instructions, not
new user feedback.

## Reusable lesson

Resolve source-independent credential policy explicitly before changing a frozen prompt, and distinguish retained-output replay from causal prompt proof.
