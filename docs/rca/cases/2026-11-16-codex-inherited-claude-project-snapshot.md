---
id: 2026-11-16-codex-inherited-claude-project-snapshot
date: 2026-11-16
title: Codex inherited a Claude-only project snapshot and could not spawn its CLI
surface: back-end
component: e2b-code-session-acquisition
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: acquireCodeSandbox selected the project's Claude-only templateSnapshot for a new Codex sandbox before resolving native CLI additions
symptoms:
  - "spawn codex ENOENT"
  - "Exited with code -2"
  - "The code agent wrote no handoff file at /home/user/.rose/handoff.json."
tags:
  - codex
  - e2b
  - project-snapshot
  - provider-routing
sources:
  - agent 147bb3eb-415a-475d-9f2f-289220bdcd12
  - task 128fc65a-d530-4753-9efd-24bab20fabf1
  - commit 780ec1dc547dcca4cf9aabd09634c9c4a4c4ac7e
repro: back-end/src/tests/blackbox/project-maintenance.blackbox.ts
status: open
---

## Problem

At 2026-11-16 17:25:47 UTC the Codex task immediately emitted
`spawn codex ENOENT`, then `Exited with code -2`. It completed zero turns and
produced no handoff. This was a process-launch failure before any model call,
not an authentication, quota, handoff parsing or reasoning failure. The local
production capture is `.context/rca-147bb3eb/agent.json`; the parent already
captured latency, logs, cache and the root's report (null).

## Diagnosis

```text
spawn_claude_code_agent (provider=codex, project=Rose)
  -> createCodexCodeSession
  -> acquireCodeSandbox(project.templateSnapshot)
       WRONG: selects Claude project snapshot for Codex
  -> resolveNativeCliTemplate(codex, base=project snapshot)
  -> user CLI recipes layered onto that same Claude image
  -> overlayCodexCodeWsServer (JavaScript only)
  -> spawn("codex", ..., cwd=workspace)
  -> ENOENT / -2 / zero turns / missing handoff
```

`projects/maintenanceE2b.ts:e2bBaseTemplate` explicitly builds project snapshots
from the Claude image. `projects/types.ts` also describes the snapshot as a
source for new Claude sessions. `e2bCodeSessionSandbox.ts:acquireCodeSandbox`
used the snapshot for both providers. The native CLI template builder installs
user-requested additional tools, not a replacement coding-provider executable;
its provider label does not change the base image's contents.

E2B `Sandbox.getInfo` identified the failed sandbox
`idz0o0o1k1d0zsjdc63u6` as template `4ilkwk9lttelncrxjcfc`, named
`rose-user-4698e3a34393fc12-df9834ff-516b-435d-ae9d-a74ef265d9c3-0`.
The production user-template record's `codex-2x4` variant mapped that exact name
to base snapshot `4qxk7kcannb8jtvgu43f:default`. Project maintenance run
`d01eddf7-f9e0-4c7f-95a6-58e1286e10e8`, started at 17:15:00 UTC, published
that snapshot. A new temporary sandbox of the **same immutable failed image**
contained `/usr/bin/claude`, no `codex`, and a real Node child-process launch
reproduced `{"message":"spawn codex ENOENT","code":"ENOENT","path":"codex"}`
and `{"exit":-2}`. The diagnostic sandbox was killed after the read-only probe;
the original paused session was not changed.

Why it happened: (1) an image missing Codex was selected; (2) the snapshot
selection ignored provider identity; (3) acquisition tests covered Claude's
snapshot/fallback path but never exercised Codex against a Claude-only image.
The first wrong boundary is image selection, not downstream spawn or handoff.

Archive searches: `spawn codex ENOENT`, `coding session template provider binary`,
and `project snapshot codex Claude binary`; literal searches included
`spawn codex`, `ENOENT` and Claude/snapshot phrases. This is a novel cause.
The 2026-10-01 default-overlay case is a relative: it also separates image
contents from the overlaid JavaScript, but its missing overlay/fallback cause
does not apply. The 2026-11-04 Claude template-env-drift case is a relative:
provider/version-aware image selection applies, while changing environment
variables does not repair this project-snapshot routing defect. The 2026-07-27
Codex npm-shim ENOENT case concerns a removed vendored binary on a Mac; this
image has no Codex executable at all.

## Solution

The prepared change restricts project snapshot selection to `provider=claude`.
Codex follows the existing provider template/native-tool path, then the existing
workspace restore path loads its repository and env files. No binary install,
provider fallback, prompt, schema, trajectory or front-end change is needed.
This is constant per-allocation selection work, with no new shared state,
polling or per-agent scan at 10,000 concurrent agents.

The regression in `project-maintenance-provider.cases.ts`, registered by the
existing `project-maintenance.blackbox.ts` entrypoint, runs real local process
launches with an image fixture captured from the failed image's executable
availability. It asserts Codex starts, restores its Git remote and env file,
and still selects its provider image when the project has a snapshot. The
negative control asserts Claude still starts on the snapshot and restores it.
Fresh review identified ambient sandbox-size configuration in the test. The
fixture now explicitly pins and restores grid/default settings and requests
a 2x4 project size; five final runs inherit hostile 8x8-only settings to verify
that isolation.

Identical red/green command, run from `back-end/`:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca147 \
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca147 \
node --import tsx --test --test-name-pattern='Codex starts on its provider image' \
  src/tests/blackbox/project-maintenance.blackbox.ts
```

Before: exit 1, `codex startup failed: spawn codex ENOENT, exit -2`.
After: exit 0, one test passed. Five unchanged final-layout runs each exited 0.
The full owning suite passed 24/24 (exit 0); formatting, ESLint and backend
TypeScript passed. The case registration structural check passed. The selector
maps the changed provider to this suite and
`--lanes-for back-end/src/tests/blackbox/project-maintenance.blackbox.ts`
exits 0 with `backend-blackbox project-maintenance`. Its split `.cases.ts`
helper is imported and invoked by this entrypoint; `--lanes-for` reports only
runner roots, not imported helpers.

Evidence logs: `.context/rca-147bb3eb/death-repro-before.log`,
`death-repro-after.log`, `death-reviewed-stability-1.log` through `-5.log`, and
`death-reviewed-owner-suite.log`. Fresh independent review and parent-owned deployment
are pending; this case remains open until those finish. Already-created
paused sandboxes retain their original image and are not migrated by this fix.
Golden reference: not applicable (ordinary image-selection code; no
approval-gated hunk).

## Human feedback

The user assigned death-only repair, prohibited delegation, front-end edits,
commit and deploy, and required parent ownership clearance before editing.
The parent cleared ownership after checking active bug threads and owns fresh
review and deployment. Freedom and its protected configuration are preserved.

## Reusable lesson

Select an image by the executable provider it actually contains before layering user tools or runtime server code onto it.
