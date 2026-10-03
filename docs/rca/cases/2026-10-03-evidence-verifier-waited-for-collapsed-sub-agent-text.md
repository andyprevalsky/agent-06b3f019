---
id: 2026-10-03-evidence-verifier-waited-for-collapsed-sub-agent-text
date: 2026-10-03
title: Durable evidence verification waited for a browser sub-agent's stream text, which the root FE transcript keeps inside the collapsed sub-agent card
surface: infra
component: durable-evidence-links
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: publish_evidence_links.visible_transcript_snippets picked assistant snippets from rows carrying metadata.subAgentId, which front-end filterMessagesForSubAgent removes from the root transcript
symptoms:
  - "FE browser verification failed: page.waitForFunction: Timeout 30000ms exceeded"
  - "publish_evidence_links.py fails for a root agent whose assistant text is a browser sub-agent stream"
tags:
  - evidence-links
  - benchmark-share
  - deploy-gate
sources:
  - PR #1341
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh feeds a root transcript whose assistant text is a browser sub-agent stream; the pre-fix picker returns the sub-agent line and fails the assertion, and the fixed picker returns only root rows
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, lane 6a passed 4/4. Publishing
durable evidence for the `agent-payment-test-shop` root agent
`96de1863-fd9d-40cd-9978-348643222007` then failed twice with
`FE browser verification failed: page.waitForFunction: Timeout 30000ms exceeded`.

## Diagnosis

### Evidence

- The fresh-browser page loaded the "Read-only benchmark recording" banner and
  the user prompt. It showed a "Browser Agent · Done · 44 steps" card and the
  screenshots.
- The shared-agent payload has 87 messages. All 8 assistant snippets came from
  ASSISTANT rows with metadata `{streamId, subAgentId}`, which is the browser
  sub-agent's step stream. The root's own ASSISTANT rows had empty text.
- `filterMessagesForSubAgent` in
  `front-end/src/features/terminal-component-group/components/useMessageFiltering.ts`
  drops rows with a `subAgentId` from the root transcript. They render only
  inside the sub-agent's card, so the text is not in `document.body.innerText`.
  The verifier's "Thought" expansion does not open that card.

### Root cause

`visible_transcript_snippets` treated every non-hidden USER or ASSISTANT row as
root page text. The FE root view excludes sub-agent rows. Any root agent whose
only assistant text came from a sub-agent stream could never pass verification.

## Solution

`visible_transcript_snippets` now skips rows whose metadata carries a
`subAgentId`, matching the FE root filter. When no root assistant text remains,
the verifier requires only the user snippet, as it already did for agents with
no assistant text. The regression test covers mixed root and sub-agent rows,
sub-agent-only rows, and metadata stored as a JSON string. Rerunning the
publisher for `96de1863-fd9d-40cd-9978-348643222007` reports
`verified in fresh browser (87 msgs)`.

## Human feedback

None recorded.

## Reusable lesson

A verifier that checks what a page renders must use the page's own visibility
rules. Copy the FE filter's exclusion criteria rather than inferring
visibility from message role alone.
