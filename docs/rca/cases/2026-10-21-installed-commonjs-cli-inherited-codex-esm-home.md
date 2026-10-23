---
id: 2026-10-21-installed-commonjs-cli-inherited-codex-esm-home
date: 2026-10-21
title: Installed extensionless CommonJS CLI inherited the Codex session ESM package
surface: back-end
component: user-ui-workspace
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: writeUserUiWorkspaceToDir and writeUserUiWorkspaceToSandbox installed extensionless CommonJS scripts without an explicit module package boundary
symptoms:
  - rose-ui pull failed with require is not defined in ES module scope
  - Agent copied rose-ui to rose-ui.cjs to reach the real CLI
sources:
  - agent dfe4db62-00ff-4053-8f86-4560e51d1aca
  - task d123cf90-0a9b-4534-9ebf-7c99e394a308
  - plan:/tmp/game6-native-records.jsonl seq88
tags:
  - codex
  - workspace
  - commonjs
  - cli
  - package-boundary
repro: back-end/src/tests/blackbox/user-ui-pull.cases.ts installedCliPackageBoundaryCase
status: open
---

## Problem

Original game run6 called installed rose-ui pull. Native transcript seq88
records Node20.20.2 rejecting require('fs') in the extensionless script because
/home/user/package.json declares type:module. The agent's copy to rose-ui.cjs
reached the CLI. Its later seq127 missing playwright-core error is a separate
old-template deployment prerequisite, not repaired by this change.

## Diagnosis

Path: CommonJS rose-ui.cjs asset → workspace extensionless ~/.rose/bin/rose-ui
→ filesystem writer → Node entrypoint module classification → require failure.
The package-scope invariant was absent in the common writer, affecting both
local and sandbox installers. rose-agents and rose-preview are also installed
extensionless CommonJS. Explicit .mjs Rose tooling must retain ESM behavior.

Archive searches for literal `require is not defined|CommonJS|extensionless`
and behavior `package.*type.*module` found no matching owned case. Existing
workspace tests verified bytes and chmod but did not invoke installed scripts
inside the actual ESM session HOME shape.

## Reproduction

Added an independent noDB case registered by user-ui-pull.cases.ts in the
canonical user-ui blackbox. It installs actual rose-ui and rose-agents bytes
under HOME/package.json type:module through each actual writer and invokes
both with Node. Before production edits, the unchanged case failed at rose-ui
with ReferenceError require is not defined in ES module scope, matching seq88.
Command: DATABASE_URL=postgresql://local:local@127.0.0.1:5432/unused
DIRECT_URL=postgresql://local:local@127.0.0.1:5432/unused
/home/boxes/rose/node_modules/.bin/tsx /tmp/run-cli-package-case.ts.
The driver invokes installedCliPackageBoundaryCase directly; it never queries
Postgres or calls the backend. Log: /tmp/cli-package-before.log.

## Solution

Both shared writers now install .rose/bin/package.json with type:commonjs
whenever the workspace contains CLI files, after all other files. This pins
extensionless scripts to their shipped module format while explicit .mjs keeps
ESM behavior. Metadata is excluded from executable chmod. Existing parent HOME
package.json is untouched; no prompt, CLI asset, dependency or template changes.

The identical regression passes after repair, covering local and sandbox
writers, actual CLI parsers, unchanged parent package and explicit .mjs probe.
rose-agents intentionally reports usage with exit2; the test accepts only that
known usage outcome, never module-resolution failures. Five focused repetitions
pass. Existing user-ui-workspace-sandbox unit tests pass3/3. Logs:
/tmp/cli-package-after-1.log through -5.log and
/tmp/cli-workspace-sandbox-tests.log. The full API user-ui domain is not run in
this bounded noDB lane. Original game outcome and template rebuild remain
pending with their owners, so this case stays open.

## Human feedback

Stop the exact original private stack before source changes. Preserve the
frontend and parent ESM package. Fix the common installer boundary, including
rose-agents, without changing prompts or adding source workarounds for missing
old-template browser dependencies. No paid rerun until runtime prerequisites
are ready. Parent supplied session CLOSED and exact process retirement receipts.

## Reusable lesson

Copying a .cjs asset to an extensionless command changes how Node finds its
module format. A session's own package metadata is part of the runtime fixture;
execute installed tools under that fixture rather than checking only bytes.

## Recurrence 2026-10-23: the CommonJS pin silenced the ESM `rose` CLI

Evidence: /descend descend-full69-20261023 worker W4, local run 3, agent
46a95467. In the E2B Claude Code sandbox `rose display <file>` and
`rose help 2>&1` printed nothing and exited 0; the backend received no
/api/agent-tools request, while `rose-ui publish` worked over the same tunnel.
The code agent believed the chart was displayed: a silent false success.

First-bad boundary: this case's fix writes `~/.rose/bin/package.json`
`{"type":"commonjs"}` for every installed CLI, but the agent-tools CLI was the
ES module `rose.mjs` installed extensionless at `~/.rose/bin/rose`. Under an
explicit CommonJS scope Node 22 loads it through ES module syntax detection
and exits 0 without running any top-level code (with detection disabled it is
a loud SyntaxError). The MCP server (`node ~/.rose/bin/rose mcp`) was equally
dead. The existing boundary test covered only rose-ui and rose-agents; the
agent-tools tests wrote `~/.rose/bin/rose` without the package file.

Reproduction: `installedCliPackageBoundaryCase` (user-ui-pull.cases.ts, user-ui
blackbox) now installs the real `rose` bytes through both installers and runs
`rose help`, `rose --help` and an undeliverable `rose display`. Before the fix:
`FAIL local rose help prints usage`. After: PASS 5/5; `rose display` without
configuration exits 1 with `rose: ...` on stderr; MCP initialize/tools/list
answer.

Fix: the CLI is now CommonJS (`assets/rose-tools/rose.cjs`, `require` instead
of `import`), matching the bin package boundary; `rose help` is a help alias.
Runtime-installed bytes only; no E2B template rebuild. Deploy restores
`rose display` delivery for every code session.

Lesson: when a package boundary is added for a directory, execute every file
installed under it through the real installer, not only the CLI that motivated
the change.
