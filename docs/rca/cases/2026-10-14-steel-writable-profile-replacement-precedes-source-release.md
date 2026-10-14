---
id: 2026-10-14-steel-writable-profile-replacement-precedes-source-release
date: 2026-10-14
title: Steel rotation retried a writable profile before releasing the source session that makes its snapshot ready
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/sessionResume.ts recreateSession — create with the source session's writable profile before releasing that source
symptoms:
  - "FAIL live Kernel provider parity: /rotate-proxy 500"
  - "Failed to create Steel replacement after 5 attempts"
  - "409 Profile 'adcd7ba7-aa61-4fbd-b9a0-182820d23439' is still uploading and cannot be attached to a session yet."
  - "writable profile was retried while its source session remained live"
tags:
  - steel
  - browser-provider
  - rotate-proxy
  - profile-readiness
  - session-custody
  - lease
  - deploy-gate
sources:
  - commit 3c9a5b558d7d40eac1e9b72ab0c50e62d9c277df
  - fleet run backend-coverage-failed-20261014-193129-420021
  - agent 25acf5cf-8f9b-4e3b-ba4b-30fb935231b7
repro: back-end/src/tests/blackbox/steel-fingerprint.profile-handoff.behavior.ts
status: fixed
---

## Problem

The backend deployment coverage gate failed the unchanged `browser-provider`
live parity test on the Steel-to-Steel `/rotate-proxy` leg. Its log at
`.context/test-runs/backend-coverage-failed-20261014-193129-420021/browser-provider.log:62`
records five failed creates ending in HTTP 409 because the exact bound profile
was still uploading. Increasing retries could not complete an upload whose
source session was deliberately kept alive.

The same run's `server.log:39138` shows the preceding Kernel-to-Steel switch
successfully published session `e74dc15a-4ccc-4b0d-9800-0fd02a9d3a68` at
19:22:53.382 UTC. Steel-to-Steel rotation began at 19:23:04.944
(`server.log:48856`). Four outer requests each exhausted five create attempts;
the source was closed only during fixture cleanup at 19:24:29.849
(`server.log:53692`). Later live auth persistence passed in the same run
(`browser-provider.log:113`), so one provider error was not treated as an outage.

## Diagnosis

Critical path: `/rotate-proxy` → browser provider dispatch → Steel
`recreateSession` → exact recorded profile binding → Steel create → CDP
validation → publication → old-source release. The first incorrect ordering was
the profile attachment before release, upstream of both CDP and publication.

[Steel's profile protocol](https://docs.steel.dev/overview/profiles-api/overview#how-profiles-work)
starts a persistent profile in UPLOADING and saves the source browser directory
after session release, then makes that snapshot READY. The old provider-neutral
replacement rule retained the source until the candidate was committed. That
rule is valid for independent candidates but contradicted this writable-profile
dependency: success was required before the action that permits success.
`recreateSession` is shared by resume and rotate, so both operations could fail.

The deepest owned gap was an absent state-preserving handoff contract for a
candidate whose durable input depends on releasing its source. A bare reorder
would lose recovery custody on failed create, allow overlapping replacements,
or resurrect a concurrent close. The repair therefore keeps the exact source,
profile and saved URL in existing PAUSED custody, acquires exclusive expiring
ownership, and compares the read snapshot before checkpoint and publication.
Changing Steel's upload lifecycle itself leaves our ownership boundary.

Archive searches used `Profile is still uploading rotate-proxy steel` and
`Steel profile release rotation replacement`. The October 1 CDP-error-loss and
October 2 provider-startup-failure cases were relatives, not recurrences: this
source browser booted and remained live; no failure reason was discarded.

Golden reference: searches for Steel/profile-upload lifecycle in
`claude-code-src/`, `openclaw/`, `hermes-agent/`, and `codex/` found no equivalent
provider adapter. The exact protocol comes from Steel's documentation.
For ownership fencing, the opened analog at
`hermes-agent/tools/browser_tool_session.py:789` admits a browser operation
under a lease and checks the epoch again before returning its result; Rose
converges on checking ownership both before provider actions and before
publication. Rose reuses its existing durable lease implementation rather than
copying Hermes's desktop-specific policy.

## Solution

`sessionProfileHandoff.ts` acquires a ToolSideEffect lease keyed to the exact
task/source session, checkpoints its matching status, closedAt and profile
custody to PAUSED, and releases only that source before candidate creation.
`sessionResume.ts` retains the lease across bounded attempts, asserts it before
each create and publication and after failed-candidate cleanup, and publishes
only while the source remains PAUSED with the same binding. Lost ownership
aborts retries; failed or unpublished candidates retain the existing exact
cleanup behavior. The provider wrapper skips its former second source release.

The lease helper now accepts an operation key/type while preserving all
Temporal cutover defaults, heartbeat, expiry, short transaction, and
owner-scoped release behavior. A crash leaves PAUSED recovery custody and a
claim reclaimable through existing expiry. Explicitly resuming a CLOSED row
read at the start remains supported; a CLOSED transition after the snapshot is
rejected. Read-only profiles, fresh-profile requests, and provider switches
retain independent-candidate ordering.

Simplification considered: deleting profile reuse or treating every candidate
as independent would lose persisted authentication; releasing every source
first would unnecessarily interrupt independent replacements. The minimal
unification is the same handoff at the shared Steel resume/rotate boundary,
reusing durable custody and ownership infrastructure. No new status, schema,
prompt, retry count, or timeout was added. At 10k agents, unrelated source keys
do not serialize, transactions cover only acquisition, and there is no
account-wide profile list or polling scan. Each handoff retains one existing
ToolSideEffect row; normal retention remains with that subsystem.

Permanent causal reproduction, with an identical command and test artifact in
the original-source copy and the fixed checkout:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria npx tsx src/tests/blackbox/steel-fingerprint.blackbox.ts
```

The original-source copy replaces only `sessionResume.ts` with the committed
pre-fix version. The unchanged fixture makes Steel reject attachment while the
source is live, deliberately fails creation after release, and requires later
recovery with the identical profile. Baseline: exit 1, five HTTP 409 failures,
then `writable profile was retried while its source session remained live`.
Fixed: exit 0, 14/14 cases. Logs are
`.context/rca-steel-profile-handoff/baseline-steel-fingerprint.log` and
`.context/rca-steel-profile-handoff/fixed-steel-fingerprint.log`.

The same predicate-aware regression also checks missing custody, concurrent
close before checkpoint and publication, unpublished-candidate cleanup,
intentional CLOSED resume, overlapping claimants, revoked-owner retry abortion,
and stale release preserving a successor's STARTED claim. The owning
`steel-fingerprint.blackbox.ts` registers it, and backend full coverage discovers
that suite through the canonical blackbox runner. Original Temporal lease
controls plus custom-key heartbeat/release passed 3/3. TypeScript and changed-file
lint passed. The unchanged live `browser-provider` domain passed 26/26 on the
initial handoff implementation; final backend coverage must use the completed
ownership guards before deployment.

Adversarial review caught the missing exclusive/status fence in the first
handoff draft and the lost-owner retry allocation in the second. Both were
reproduced or encoded in permanent controls and repaired; final read-only review
reported no remaining blocking finding. This case records a locally proven fix;
merge, complete deployment gates, and production rollout remain owned by the
parent deployment workflow.

## Human feedback

No Steel-specific human feedback recorded. This failure was found while carrying
out the user's deployment. The standing user instruction to preserve Freedom
remained in force; this repair did not alter its protected components.

## Reusable lesson

Checkpoint exact durable custody and fence ownership before releasing a source whose release is required to make the replacement's input ready.
