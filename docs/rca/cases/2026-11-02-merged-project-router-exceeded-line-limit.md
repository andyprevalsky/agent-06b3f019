---
id: 2026-11-02-merged-project-router-exceeded-line-limit
date: 2026-11-02
title: Merged project routes exceeded the unchanged strict file limit and retained an unused Codex local
surface: back-end
component: projects-routes-and-codex-spawn
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Combined folder and CLI routes reached339 countedlines against300; Codex spawn retained an unused local after model handling moved to cliSettings
symptoms:
  - File has too many lines (339). Maximum allowed is 300
  - model is assigned a value but never used
tags:
  - lint
  - integration
sources:
  - commit 05449cd2d44b879ec883cfd24aa2a9430da8a811
  - plan:/project/rose-speed-comparison-20261028/nov2-lint-rca/HANDOFF.md
repro: cd back-end && npx eslint src/domains/projects/routes.ts src/providers/e2b.ts
status: fixed
---

## Problem

Frozen integration ESLint failed only on project router339/300lines and unusedmodel in Codex session creation.

## Diagnosis

Exact owning targeted ESLint privateproject FAIL2errors29.627s; samecommand after mechanical extraction/localremoval PASS30.831s. Raw logs and commands retained in handoff. Twoarchive searches for literalmax-lines/unusedmodel and behaviorroute-size/moduleextraction found related Oct29resume-size case; distinctboundary, not recurrence.

## Solution

Candidate only: extract5folder routes unchanged into registration module with same parentauth/scoped helpers at exact mountposition, matching existing maintenance pattern. Remove unusedplainrecordproperty local only. Entireoldrouter can be reconstructedbyteforbyte by inlining movedblock and restoringimports. Modelenvspread/fetch unchanged. Parent apply/archivevalidate/integrated gates remain required; no fixed claim on production.

## Human feedback

Parent required no tracked edits while frozenpipeline active, no lintdisables/threshold changes/authremoval and privatebefore-afterproof. Parent owns application after gates finish.

## Reusable lesson

Extract coherent route groups behind shared auth helpers when integrated modules cross lint limits, and remove unused locals without changing their live environment producers.


Integrated validation on 2026-11-02: backend typecheck and scoped lint passed; mobile owning suite passed all 16 tests; the full run-deploy-pipeline owning regression suite passed after both fixture-input repairs. Full release gates and production verification remain separate requirements. Original failures and focused evidence are retained under `/project/rose-speed-comparison-20261028/`.
