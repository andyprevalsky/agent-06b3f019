---
id: 2026-11-04-claude-e2b-template-env-drift
date: 2026-11-04
title: Per-environment Claude E2B template id launched a CLI below the model minimum
surface: back-end
component: claude-e2b-template-selection
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: currentTemplate('claude') returned the devbox env E2B_CLAUDE_CODE_TEMPLATE_ID (kng6z68u1md05bfdhq47, CLI 2.1.138) instead of a template built from the Dockerfile pin
symptoms:
  - Claude Code 2.1.138 does not support this model
  - version 2.1.280 or newer is required
  - Claude Code output does not contain CLAUDE_E2B_DONE
tags:
  - claude-code
  - e2b
  - template-version
  - env-drift
sources:
  - PR #1687
  - commit 8d801333bb061ed760ab8ddf86e24e45665192f2
  - commit 18cae55befbd8fcad7d03cfdbd9902334be676b0
repro: back-end/src/tests/structural/sandbox-size-templates.test.ts
status: fixed
---

## Problem

Deploy Step 6c, the real Claude Code E2B smoke, failed after merge 8d801333b:
"API Error: 400 Claude Code 2.1.138 does not support this model; version
2.1.280 or newer is required". The same failure reproduced on a fresh devbox,
run 1793797634-1356854-782. A probe booted each template and ran
`claude --version`: kng6z68u1md05bfdhq47 reports 2.1.138 and 1 GB of memory.
gby3w62h9jqa22lpl2su (claude-code-v21305-c2-m4) and claude-code-c2-m4 report
2.1.305.

## Diagnosis

Commit 18cae55be pinned the Dockerfile to CLI 2.1.305 and built
claude-code-v21305-c2-m4. Runtime selection remained the per-environment
E2B_CLAUDE_CODE_TEMPLATE_ID. Render was switched by hand to gby3 (and
E2B_SANDBOX_TEMPLATES=grid), but the boxes.dev managed devbox env still names the
May image kng6. Every fresh devbox therefore launched CLI 2.1.138 for the
default size. Case 2026-10-29-claude-e2b-local-template-stale corrected only one
ignored local .env, so the next devbox regressed. Codex already binds its
template to the Dockerfile pin in code (codexTemplate.ts); Claude did not.

## Solution

src/providers/claudeCodeTemplate.ts names the versioned default
claude-code-v21305-c2-m4 with its CLI version. Session, sized-default, inspect,
maintenance and user-tool paths use it instead of the env id. The structural test
requires the Dockerfile pin, version and alias to agree. It also selects the
default with a stale kng6 env id and rejects provider reads of that env var. It
failed on the old code with actual 'kng6z68u1md05bfdhq47' and passes after the
fix. The unchanged real smoke then passed 57/57 with the devbox env still naming
kng6, run 1793797805-1386112-19025. Prod's selected image is unchanged.

## Human feedback

The assigned repair required fixing the template selection and completing
deployment. No gate waiver or env write was used.

## Reusable lesson

Bind an image to the code that requires its pinned tool version. A
per-environment image id drifts from the Dockerfile on fresh machines; editing
one local .env fixes only that machine.

## November 5: CLI integration fixture follows supported configuration

The CLI integration unit fixture still expected its legacy Claude environment
variable to choose `fixture-claude-template`. After the versioned-default
repair above, that variable intentionally no longer selects the default.
The exact unit run failed with the versioned template in place of its expected
fixture. Supplying explicit Claude and Codex `2x4` entries through
`E2B_SANDBOX_TEMPLATES` makes the unchanged assertions pass. All 52 assertions
and 15 rejection checks remain; runtime selection, timeouts and the
zero-allocation guard are unchanged. Independent review accepted the isolated
red/green proof in `.context/cli-nov05-review/template-review.json`.
