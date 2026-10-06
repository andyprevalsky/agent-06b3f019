---
id: 2026-09-27-browser-module-import-block-split-by-helper
date: 2026-09-27
title: A helper split the browser module imports and a removed tool left an unused import
surface: agents
component: providers/rose/browser_use.py
classification: our-bug
problem_class: other
first_bad_boundary: browser_use.py module layout placed imports after recover_from_challenge_enabled and retained an import whose only consumer was removed
symptoms:
  - "E402 Module level import not at top of file"
  - "F401 user_facing_text_description imported but unused"
tags:
  - static-validation
  - imports
sources:
  - commit e930a9b162ac3cbc4b172a4d41c93648a1d5e66a
  - commit e72654e02a
  - commit 2f8b65bb22a1e549ec82da2afb448f88f120b4b2
repro: agents/pyproject.toml (Ruff E402/F401 for agents/providers/rose/browser_use.py)
status: fixed
---

## Problem

The frozen candidate's upstream static gate stopped with four E402 errors and one F401 in `agents/providers/rose/browser_use.py`. Its `set -e` shell never reached the subsequent frontend commands. This is a static source-layout failure, not a task outcome or provider problem.

## Diagnosis

The actual log is `.context/acceptance/proof20-upstream-static-recovery/upstream-static.log`. An independent execution of the unchanged seven-file Ruff selection reproduces exactly the same five errors. Git blame binds the intervening function definition to `e72654e02a`; `2f8b65bb2` removed the only `user_facing_text_description` call while retaining its import. The existing linter correctly rejects this source. No evidence establishes why an earlier upstream workflow did not remove these errors, so there is no speculative CI verdict.

Two archive searches used `E402 Module level import not at top of file browser_use F401` and `unused import helper before module imports static lint upstream merge`. There was no exact E402/F401 recurrence. The closest import/checker relative, `2026-07-27-type-only-import-flagged-as-runtime-circular-import`, concerned a false positive on erased TypeScript imports; it does not explain these real Python diagnostics.

The minimal owning reproduction is the existing Ruff checker with the canonical filename/configuration:

```sh
/Users/andyprevalsky/.local/bin/ruff check --stdin-filename agents/providers/rose/browser_use.py -
```

The same command consumes the original source and the private candidate. The original exits1 with four E402 and one F401; the candidate exits0. `import-only-red-green.json` pins both byte streams and the patch. The full selected Ruff run establishes that none of the other six selected files produced diagnostics.

## Solution

The applied patch consolidates the needed imports before the helper and deletes the unused import. All non-import AST nodes and all string literals are identical. It adds no branch, flag, prompt change, recovery decision, linter suppression, test assertion change, or limit change. The existing Ruff gate is the permanent owning regression check for this static rule; another behavioral test would duplicate the linter without exercising a new runtime contract.

The actual two-file working-tree candidate then passed the seven-file Ruff gate,
target frontend ESLint and physical fixture compiler, both unchanged thinking
visibility tests, and both `rose_browser_use` / `spawn_browser_agent_v3` agent
blackbox domains. The source hashes stayed unchanged throughout validation;
`.context/acceptance/proof20-static-fixed/gates.json` records every command,
exit 0, and log hash. The browser domain run completed in 43.0s; the frontend
file passed 2/2 in 3.52s. This closes the bounded static defect, not the separate
cloud proof or all frontend type errors.

The independent Step 7 review is
`.context/acceptance/proof20-upstream-static-recovery/independent-static-batch-review.json`.
It verified the import-only change, unchanged string literals, and no remaining
use of the removed binding. At 10,000 agents this changes no request count,
concurrency, allocation, prompt, or runtime policy.

The supplemental frontend app-project investigation found 204 diagnostics;
two belonged to the separately repaired thinking-visibility fixture and 202
remain outside this bounded infrastructure repair. No full-app typecheck pass
is claimed. The empty references-wrapper command's exit 0 was not used as
proof that application types pass.

## Human feedback

The user scoped this work to infrastructure and rejected changing task, prompt, model, evaluator, or timeout behavior to improve scores. The import correction preserves those boundaries.

## Reusable lesson

Keep module imports together and remove imports when their final consumer is deleted.
