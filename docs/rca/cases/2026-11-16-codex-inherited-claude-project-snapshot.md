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
  - agent dd14af83-6910-48a0-a74d-722195e767e7
  - task ba904a40-8f45-400f-9236-871b70bf0e14
  - task 3947f134-e129-441b-bc2d-4858d9923e62
  - PR #2411
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c
  - agent 147bb3eb-415a-475d-9f2f-289220bdcd12
  - task 128fc65a-d530-4753-9efd-24bab20fabf1
  - commit 780ec1dc547dcca4cf9aabd09634c9c4a4c4ac7e
repro: back-end/src/tests/blackbox/project-maintenance.blackbox.ts
status: fixed
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
`death-reviewed-owner-suite.log`. These are the original repair receipts. The later independent review,
fresh E2B gate and delivery evidence below establish the completed review,
merge and production verification. Already-created
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

## PR2411 delivery evidence

PR #2411 merged as `562cc8c49008708918d15ee9844ab1c8c333062c`.
The original failures and reproduction assertions above remain unchanged
historical evidence. Frozen source `4a9d224abd5bf5ab1770237f2a8097762938a876`,
digest `882008a4bc15beb817e758c96fd6fcabb8c9fddfcfd52454d9877be30fab17c0`,
passed all 17 selected native deploy gates. The original cycle and report
are preserved under `.context/rca-147bb3eb/validated-4a9/` and
`validated-4a9-report.log`; the report command exited 0.

The first production attempt failed semantic workflow dispatch with HTTP401
at 20:22:58 UTC before creating any workflow run. Its original FAIL and null
run identity remain in `.context/rca-147bb3eb/production-first-attempt/` and
the final production receipt's semantic_history. Render, Vercel, backend probes
and Mac release passed. The credential CLI repair was separately validated
and pushed as operations commit `6e2496487add55f3416737566873573528474fd3`;
its 91-test `/push` is not PR2411's 17-gate full deploy.

The normal semantic-only retry exited 0 at 2026-11-16T20:48:30Z. Run
[43951508861](https://github.com/Rose-Ai-Labs/rose/actions/runs/43951508861)
completed all five jobs successfully. It is **PASS-verified-by-descendant**,
not an exact-source PASS: target product merge is562cc8, effective live frontend
and tested specification source is `1ec28940191764ecf435ffc38b345006269bc95b`,
and workflow execution head is6e2496487add55f3416737566873573528474fd3.
The final `.context/deploy-pipeline/production-lanes.json` records all
applicable lanes satisfied: exact562cc8 Render/Vercel, backend probes, Mac
run43946926015 (v1.1.355), and descendant-verified semantic. Fly, WMH,
workflow migration and AgentCard remain SKIPPED-not-applicable, never PASS.
The native finish command exited0 at20:49:05Z. This resolves this repaired
boundary's delivery; it does not certify unrelated runtime repairs, original
paused-session recovery, marker release or whole-workspace deletion readiness.


## Same-cause occurrence dd14af83 (pre-rollout)

Agent `dd14af83-6910-48a0-a74d-722195e767e7` used session
`2318b9ce-78df-4a7b-b850-9fc92125ddb0`, created
2026-11-16T20:09:39.036Z. Tasks ba904a40-8f45-400f-9236-871b70bf0e14
and 3947f134-e129-441b-bc2d-4858d9923e62 emitted `spawn codex ENOENT`
at 20:10:05.422 and 20:11:42.517 UTC, then exit -2, zero turns, no artifacts
or handoff. The second attempt resumed the same paused sandbox
`i9wwr7th8dq7sfpesve9w`, not a fresh allocation.

Exact lineage: failed template `zb2pdsw3l3gc8msrgv2q`, named
`rose-user-4698e3a34393fc12-20a4d6e8-775b-4f3c-b94b-3e83c811d8ac-0`,
matches the captured codex-2x4 variant whose base is
`8zkbp9y35slaiatz57mb:default`. That base belongs to successful Claude
project-maintenance run `9f8810e8-65e5-47ac-a667-52ac8be33975`,
20:05:00.782–20:05:32.700 UTC, source
`c1a553d6295e5444838600231cf76822fa30c4bf`. The later project's current
snapshot at 20:10:34 is not substituted for this historical lineage.
Both this occurrence and the original147bb3eb incident have exact captured
Claude-derived snapshot lineage and ENOENT/-2 before any model turn.

A disposable exact-image probe of template zb2pdsw3l3gc8msrgv2q at
20:19:44.197–20:19:50.932 UTC resolved `/usr/bin/claude`, confirmed existing
cwd `/home/user`, and reproduced Node `spawn codex ENOENT` / child exit -2
with the captured PATH. Outer probe exit0 means successful capture, not
successful Codex execution. The disposable probe was killed; it was not the
original sandbox. Independent review confirms the same selection boundary
and concludes no additional source repair is justified by this occurrence.

The PR2411 Render deployment became live only at 20:16:55 UTC, after both
failures. Checkout SHA562cc8 inside a sandbox is not backend rollout proof.
This is a pre-rollout recurrence, not evidence the deployed fix regressed.
Both original paused sessions remain preserved and NOT recovered. Default
session resolution can reuse a paused session; safe verification of fresh
allocation requires a genuinely fresh owner/session, not another resume.

`.context/rca-147bb3eb/codex-live-verification.json` records actual fresh
Codex E2B task completion and restricted-command native handoff PASS in the
backend-coverage-blackbox gate on exact4a9, native exit0. Its log is
`.context/deploy-pipeline/attempts/7/final/backend-coverage-blackbox/remote-artifact/files/back-end/coverage/blackbox-run-shard2/codex-code.log`,
SHA256 efa8f3b54e6a575ca11cb1798ed16fb1c2990e1463df54939b78d2f27476441b.
That is real fresh-allocation gate evidence; it is not recovery of either
paused production session. The final production semantic run is separately verified above.

The sanitized occurrence facts above derive from the private attachment
incident-addendum, image-probe-receipt, INCIDENT and independent-review
files listed with exact local paths and hashes in the private evidence manifest retained with this RCA. Raw transcripts and private captures are not copied into this case.
The original sync/templater product question remains separate and unresolved
by this launch diagnosis.
