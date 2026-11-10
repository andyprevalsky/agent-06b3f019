---
id: 2026-10-28-native-ui-tests-retained-superseded-layout-contracts
date: 2026-10-28
title: Native UI tests retained the removed display panel and pre-paperclip model position
surface: harness
component: frontend-native-layout-contracts
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: two Playwright layout tests retained superseded surface expectations after upstream intentionally changed the rendered UI and its registered blackbox contracts
symptoms:
  - "getByRole('button', { name: 'Agent Display', exact: true })"
  - "Timeout: 15000ms"
  - "model picker is flush bottom left"
  - "32px and31.316375px left difference"
  - "5 failed"
tags:
  - frontend
  - playwright
  - stale-test-contract
  - inline-display
  - composer-layout
sources:
  - commit 2cccd3fb62bd0f6e1d8653aa7699e8c6a09aa1bf
  - commit 134fc78ccdda88a08bf411a12f272b67f00990be
  - commit 8f4715813f58d393085de33fb2cd4576b2f9b854
  - plan:.context/deploy-fresh-20261027/group4-final-2cccd3fb62bd/rca-agent-display/native-proof.json
  - plan:.context/deploy-fresh-20261027/group4-final-2cccd3fb62bd/rca-model-picker/FINAL.json
repro: front-end/tests-e2e/agent-display-panel.spec.ts and front-end/tests-e2e/sidebar-agent-tree.spec.ts
status: open
---

## Problem

The native Group4 UI run on frozen2cccd3fb62bd reported28PASS/5FAIL. One
failure waited for the removed Agent Display button. Three failures measured
the model selector against the composer's left edge after an attachment
button had intentionally been placed before it. The remaining project-flow
failure is a separate right-button/context-menu investigation, not covered
by these two fixture corrections.

The display case failed at agent-display-panel.spec.ts95 before reaching
its game assertions: the exact Agent Display button did not exist at the
unchanged15000ms expectation deadline. Its retained trace simultaneously
showed the actual inline game frame, with canvas data-ready=true and126
frames. This is not evidence that WebGL was stalled.

The model cases at320,390 and1280px failed the old model-left-edge assertion.
Observed offsets were32px and31.316375px. The measured element was after
the attachment button; a gap from the shell's left edge was now intended.

## Diagnosis

Both first-bad boundaries are stale native-test expectations, not production
rendering defects. The upstream changes updated production and registered
blackbox contracts but left their separate native Playwright expectations
unchanged:

-134fc78ccdda88a08bf411a12f272b67f00990be replaced the Agent Display icon/drawer
  with an inline collapsed/expanded display. AgentDisplayMessage.tsx2-12
  explicitly says there is no icon/panel and toggling preserves the same
  live frame. agent-display-inline.blackbox.tsx59-109 checks absence of the
  old surfaces, the real inline iframe, and its identity across toggles.
-8f4715813f58d393085de33fb2cd4576b2f9b854 moved the attachment paperclip before
  the model selector in every InputContainer variant. The production comment
  and render order agree, and rose-desktop-flag.blackbox.tsx273-282 checks
  adjacency in desktop and stock variants. The old native test still treated
  the model as the first control.

The display production file, its blackbox and the stale native test were
independently confirmed byte-identical between upstream84bd8a69 and2ccc.
No hypothesis about load, model intelligence or timeout was needed to explain
these failures. The relevant product features existed and contradicted the
obsolete expectations.

Archive searches used the literal Agent Display/attach-model/paperclip terms
and behavioral stale-UI-expectation/removed-surface terms. The related
2026-10-02-browser-live-test-used-pre-rotation-proxy-tier and
2026-09-29-gate-fixture-stale-integration-unique-selector cases were read,
including Solution and Human feedback. They are contract-drift relatives,
not this incident's recurrence. The live-display handler-lock case concerns
a different request/retirement boundary.

## Solution

The proposed changes affect only the two native test files.

Display: assert the removed button and drawer are absent, locate the real
inline display by its message ID, check its exact usercontent URL and
unchanged sandbox, and exercise the actual expand/collapse control. The
same iframe must survive toggles and keep advancing frames. The complete
fixture/API/viewport setup, real canvas readiness, click-to-focus,
ArrowRight motion greater than x+0.2, frame-count greater than3, Browser
inactive state and final ArrowLeft/Space recording interactions remain.

Model picker: measure the first control, the actual attachment button,
against the same shell inset. Require its immediate sibling to be the model
selector and its icon to be the paperclip. Check actual model-to-attachment
spacing against the authored CSS column gap. Retain all three less-than1px
geometry predicates, all320/390/1280 widths, model-to-row and shell-bottom
alignment, and the model click/dialog/Escape behavior. All other sidebar-file
bytes remain unchanged.

No product runtime, task prompt, provider, model, timeout, worker request or
financial behavior changes. These tests observe the current product contract;
they do not establish a new cold-render performance SLA. At10000 production
agents there is no added runtime state or work from these test-only changes.

## Verification

The author ran each pair through the same native owning entrypoint and
working directory, with only the proposed test bytes changed. The independent
reviewer read the commands, logs and receipts without executing tests.

Display command, from its private native-tree/front-end directory:

`bash /home/boxes/rose/.context/deploy-fresh-20261027/group4-final-2cccd3fb62bd/rca-agent-display/native-tree/front-end/scripts/run-semantic-tests.sh agent-display-panel`

Original: exit1, missing-icon assertion at15000ms,19.398s command wall time.
Candidate: exit0,1PASS in16.0s native output,17.889s command wall time. Both
requested4 workers; the unchanged native launcher selected effective2 and
the single owning case used one worker. The fixture and original game-input
assertion block are byte-identical.

-Original file SHA256:d8f0d5bd4961b00d7fd614b3d6593aa2c247b4b792cd7f3365763b56f061d551
-Candidate file SHA256:2bd7802bcf4c9adbecd7da8a13c9c89fa0cfe87ec6e9017114cedb3e4201f809
-Patch SHA256:c17e95eb5d95e50a27fe920726c3cf428dc4eb87b4e2e0ce63e8fff4df4cffd2
-Original log SHA256:710b4ce79cf99d221da98c0ef14abf0e63e37b0bce1570d2d5197ef082433051
-Candidate log SHA256:8d70b3b9d598286deea94c2c836efb15e078d989e864922feb3e1829e2e11f24

Model command, from its private native-tree/front-end directory:

`bash /home/boxes/rose/.context/deploy-fresh-20261027/group4-final-2cccd3fb62bd/rca-model-picker/native-tree/front-end/scripts/run-semantic-tests.sh sidebar-agent-tree`

Original: exit1,9PASS/3FAIL in56.7s native output,58.417s command wall time.
Candidate: exit0,12PASS in60.5s native output,62.175s command wall time.
The three former failures now check the intended first-control geometry;
the other nine cases pass unchanged. Native requests and deadlines match.

-Original file SHA256:f22d0dbc6ce72dc15eae78aa7012d08843b2b2a33c9138fb3ae05d5d8de8074b
-Candidate file SHA256:d10761074ab3883b370b304939593693bd1582fdd6b1677aba01ded92d14a431
-Patch SHA256:b3c5d6d04044f2a1a273c7868db63e12a4dc9c0b7f2a2aac74f915173e7a4ee6

Independent exact-snapshot reviews were GROUNDED. Display review receipt
SHA256:ac64bc6efdbc74437d9f916ae80fd89dbbb5a8d0284ed7ce2e21f69d89e57945.
Model review receipt SHA256:d32fc8ffa1222a1859a70d7c6105dd41529e019b0efc21ea3592c64c9cfff967.
Reference mechanisms opened include OpenClaw's exact iframe identity and
rendered geometry checks, Codex's sandboxed visualization contract, and the
installed Playwright actual-locator matchers. No fabricated negative run is
claimed: the original missing-icon and geometry failures are the causal red
controls; preserved exact URL, real game input and geometry checks continue
to reject missing/noninteractive content and misplaced controls.

## Acceptance and cleanup limits

This is a private staged case. The two proposed corrections have focused
native proof, but canonical application and combined full33 UI acceptance
remain coordinator-owned and pending. The original28PASS/5FAIL remains the
original result; focused passes do not relabel it or fix the independent
project-menu failure. No production, deployment or Mac acceptance is claimed.

Display receipts report no remaining observed session members; separately
observed candidate Chrome and ffmpeg PIDs were also absent. The original
sampler did not exhaustively census detached Chrome descendants. Model
receipts report no remaining processes with the captured birth identities;
detached descendants were not exhaustively censused. Do not inflate these
checks into an all-machine cleanup claim. Root owns the shared native stack,
all final joins, source application, archive and INDEX regeneration.

## Human feedback

None recorded.

## Reusable lesson

Update each native UI test's observation target when an intentional product layout change supersedes it, while preserving the original behavior checks and numerical bounds.
