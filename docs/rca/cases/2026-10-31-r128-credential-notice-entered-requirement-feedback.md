---
id: 2026-10-31-r128-credential-notice-entered-requirement-feedback
date: 2026-10-31
title: Browser credential notices entered user requirement feedback
surface: cross
component: agent-message-provenance-and-requirement-intake
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Internal USER credential rows lost their source classification at agentMessageService and signalled receive_user_response as authored feedback
symptoms:
  - Recently received email with no code triggered schema generation
  - Browser step budget reached 100/100 then ordinary pause
  - spawn_browser_agent count zero before late cancellation row
tags:
  - r128
  - credential-provenance
  - schema-feedback
  - browser-budget
sources:
  - commit 691b9059a9ca3b41552be9679d712b50edcf24d5
  - agent 84d02707-04a3-4a90-a8ab-b4960be7d253
repro: Original two credential notices through actual postMessage plus registered browser_credential_rows_keep_requirement_revision; baseline fails and qualified candidate passes
status: open
---

## Problem

It30 BU091r2 ended PAUSED/progress0 and benchmarkFAILED. Original archive
`b71ccd71f2e31ba3de0178926fbda1adac4a4aac1ddd24b2a45f6884d7c4c240`
and all seven normal files verify. No original outcome was promoted.

## Diagnosis

Saved USER rows141/144 are browser-produced email notices with
credential_ref/subAgentId metadata. Exact handler appends those notices to the
browser conversation and persists them through save_browser_credential_ref_message.
The backend's authored-row classifier did not recognize that credential source;
it sent plain receive_user_response signals. Worker22332/22414 records lengths
410/1037; schema requests22342/22430 contain one then both notices. The workflow
therefore regenerated requirements from provider data. The notices do not
change the requested gunner names.

This proven boundary is separate from the final pause. A CDP closure recovered
in6.8seconds and browser work continued to100steps. The final native verifier
started at22:22:47.72; backend browser-budget-stop returnedHTTP200 at22:22:51.306,
then ordinary pause ran. The accepted response body/historical ticket revision
is unavailable; the exact finalizer-refusal reason remains OPEN. Its revision,
identity and deadline guards were not weakened.

The tool-count failure is also a snapshot fact: exact counter replay on the
first249 saved messages reproduces the reported zero; full255 messages count
one browser call after cancellation row250. This does not make the paused task
successful or authorize rewriting its original result.

## Solution

Qualified patch
`83d0e4872a159d2c2d6dd5b44a4a559931c3a52235d6ae2f319e57aa5dd2bc2c`
fixes only credential provenance for future writes. The backend strips an
incoming browserCredentialContext claim, then stamps true only for authenticated
internal USER writes with complete credential_ref and subAgentId. External
lookalikes/malformed references remain ordinary feedback. The shared Python
predicate excludes the trusted marker from durable requirement intake. Text,
credential references, local browser delivery and generation fencing remain.
No content regex, task-specific answer, budget change or historical-row rewrite
is introduced. Existing routing classification moved into the pure helper to
meet the touched-service line limit; its other flags keep their behavior.

Original-notice replay changes two feedback signals to zero while preserving
text/refs. Actual postMessage unit controls are4FAIL before/4PASS after; a
registered real-workflow requirement test fails before and passes after, with
ancestor/human/environment controls and three existing OTP-delivery/format
controls passing. Touched TypeScript lint, Python compile and patch checks pass.
A independently GROUNDED the exact final patch; no whole-suite or repaired-task
claim follows. Root integration and live qualification remain distinct actions.

Opened OpenClaw input-provenance, Codex inter-agent/protocol authority and Hermes
internal-tool-notice code support preserving source separately from USER storage.
Their mechanisms are not credential-provider equivalents. The reviewed packet
records exact files, hashes, contrary cases and independent controls.

## Human feedback

The user prioritizes native failures, progress0 and schema/validator data flow
while requiring all failures to remain tracked. This does not authorize changing
the original task, criteria, limits or user-authored feedback semantics.

## Reusable lesson

Preserve authenticated origin when internal data shares a USER storage role.
Correct both live signalling and durable replay; never infer authorship from
message text or let an external marker suppress genuine user requirements.
