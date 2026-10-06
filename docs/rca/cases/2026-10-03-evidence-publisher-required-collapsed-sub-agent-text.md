---
id: 2026-10-03-evidence-publisher-required-collapsed-sub-agent-text
date: 2026-10-03
title: The evidence publisher required browser sub-agent reasoning that the shared FE keeps collapsed, so a correctly rendered agent failed FE verification
surface: harness
component: publish-evidence-links
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/publish_evidence_links.py visible_transcript_snippets picked ASSISTANT rows tagged with metadata.subAgentId, which filterMessagesForSubAgent drops from the root transcript
symptoms:
  - "FE browser verification failed: page.waitForFunction: Timeout 30000ms exceeded."
  - "verify_benchmark_share_link.cjs"
tags:
  - evidence-links
  - approval
  - share-link
  - sub-agent
sources:
  - PR #1401
  - PR #1341
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

`python3 scripts/publish_evidence_links.py --run-json <smoke run> --agent-id e53d4dda-8848-49db-b122-958066bb2b02` uploaded the bundle and passed the API and recording checks. It then failed with `FE browser verification failed: page.waitForFunction: Timeout 30000ms exceeded.` As a result, the passing `agent-payment-new-user-journey` run could not be cited as approval evidence.

## Diagnosis

A headless load of the same share URL rendered the root transcript: the user prompt, the Browser Agent "Done · 44 steps" chip, and the result. All 8 assistant snippets the publisher chose were missing from `document.body.innerText`. Each of those 8 came from an ASSISTANT row carrying `metadata.subAgentId` (the browser-use stream). `filterMessagesForSubAgent` in `front-end/src/features/terminal-component-group/components/useMessageFiltering.ts` drops those rows from the root view and renders them only inside the sub-agent panel. The verifier waits for at least one assistant snippet, so any agent whose first assistant rows are sub-agent stream rows could never verify.

Local repro: a new case in `publish_evidence_links_browser_validation.test.sh` passes one user row, one `subAgentId` assistant row, and one root assistant row. On the old helper it fails because the nested row is included.

## Solution

`visible_transcript_snippets` now skips rows with `metadata.subAgentId`, matching the FE root filter. The cemented test passes. Rerunning the publisher on the same agent now prints `verified in fresh browser (85 msgs)`. There is no product or runtime impact.

## Human feedback

None recorded.

## Reusable lesson

A verifier that asserts what a page renders must derive its expectations from the page's own visibility filter, not from the raw rows.
