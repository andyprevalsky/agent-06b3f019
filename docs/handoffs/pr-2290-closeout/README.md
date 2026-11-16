# PR #2290 closeout

[PR #2290](https://github.com/Rose-Ai-Labs/rose/pull/2290) merged as
`cc7a39b2846aa385320386bbb1374e74c989e6a4` from reviewed source
`96d12280d3438f764b0c098ab4f9547eb763b3fd`.

The reported root `118fff32-2388-4636-ae74-fec935326548` failed because the
mandatory handoff protocol required extra shell commands during a task that
permitted only `yc me --json`. The command succeeded after 58.227 seconds;
three bookkeeping commands then violated the restriction. Eight correct
verifier rejections followed. A pause arrived about eleven minutes after
creation; the following day's PAUSED status was preserved inactivity. This
was a harness failure, with no user-input wait or price-limit exhaustion.
The original root remains untouched.

Native Codex now persists the final structured handoff through its transport.
The provider's strict output schema and the existing worker reader validate
the result. The task, model settings, schema, native goal and root verifier
remain intact. Other transports and unsupported schemas keep their original
protocol; this repair does not claim to resolve their restricted-action cases.
The [RCA case](../../rca/cases/2026-11-16-mandatory-handoff-bookkeeping-conflicts-with-single-command-task.md)
contains the causal trace, archive searches, negative controls and related
occurrence `30030a75-a650-404e-89ce-3c41f8f5f5d8`.

## Reported-goal verification

Fresh production root `df99c21a-058b-4f70-955c-adade7d530bd` ran the original
goal with unchanged requested settings. A verified remote checkpoint records
one cloud code child and exactly one shell CommandExecution:
`/bin/bash -c 'yc me --json'`. It exited 0 in 3.352491091 seconds and returned
account name Andy Prevalsky, username `andyprevalsky`. Existing CLI token
refresh occurred inside that command; there was no login, install or extra
shell bookkeeping. Native goal completion and a schema-valid persisted
handoff preceded the first root completion attempt, which scored 100%.

The final answer arrived 159.757 seconds after creation; persisted terminal
status arrived after 168.698 seconds. These are different measured boundaries.
The actual child was GPT-6.1 Sol/xhigh/standard, Codex CLI 0.169.0. Exact
per-sandbox template ID and WebSocket file hash were not probed. Runtime
provenance is supported by the live backend's release ancestry, matching
handoff runtime bytes, and the actual native goal/host persistence evidence.
The fresh check proves the reported symptom is gone; it does not replace the
full production lane checks.

The task is CLOSED. Its persistent code session remains PAUSED with a verified
sequence-1 remote checkpoint and its application repository retained by the
normal production service. This is retained application data, with no active
child task and no dependency on this checkout. It is not labelled a released
benchmark sandbox or free storage. All owned benchmark fleets and canaries
were separately released. See [targeted verification](targeted-verification.json).

## Validation and review

All 17 selected native Linux gates passed on the frozen reviewed source,
including all 285 backend checks and seven cloud smoke tasks with cleanup.
The Linux-inapplicable Mac tests remain omitted, never PASS.

Tests skipped (quarantined): 8 — 0 failed (non-blocking), 8 passed

Flaky (passed on rerun): 1 — 1 attributed, 0 awaiting /RCA attribution (blocks merge)

The final identical local regression command was:

```sh
node --test --test-name-pattern='native handoff honors task constraints' e2b-templates/codex-code/app-server.test.mjs
```

Before: exit 1, native persistence instruction absent, 0.187059649 seconds.
After: exit 0, the task restriction is preserved and native persistence is
selected, 0.159985798 seconds. The final test bytes were identical. Real-reader
controls cover success, blocked, failed, invalid, missing and stale results;
additional lifecycle controls cover commentary and interrupted continuations.
Historical failed attempts remain preserved, including the stale 283-check
inventory rejected before execution. The supported plan repair supplied the
required 285 cases without weakening the worker admission guard or rerunning
the unchanged cloud fleet.

Golden-reference review RCA118-HANDOFF-4 was GROUNDED. Its three scoped files
and fifteen hunks remained byte-identical through the final integration.
CodeRabbit reported the organization spending cap on the exact final HEAD;
the native review ledger records the qualified usage-cap skip. PR #2290
merged unreviewed by CodeRabbit. This external provider failure remains open.

## Production and preservation

Full deployment closeout is pending. Render's live descendant contains the
release and both handoff runtime files match; all sixteen endpoint probes
passed. The original Fly cutover job reached SUCCEEDED and its retirement
certificates qualified. The native verifier subsequently failed to parse the
monitor's multiline JSON. That separately owned failure is accepted by
[PR #2407](https://github.com/Rose-Ai-Labs/rose/pull/2407); Fly verification,
workflow migration and semantic checks retain their native FAIL/BLOCKED
statuses until the unchanged production command passes with the merged tool.
No replacement cutover, queue mutation, rollback or original-root resume was
used to obtain the targeted-goal result.

Private evidence is retained in five authenticated, independently restored
encrypted archives. A final overlay must cover production, the fresh goal,
clock closure and final records. Existing project-managed archive credentials
and key `trace-archive-prod-2026-07-03` are delivered independently to fresh
authorized devboxes; no new key or environment change was made. The
[managed recovery proof](managed-recovery-proof.json) contains no values.
Raw trajectories, checkpoints, logs, environment files and signed publication
URLs are never committed here. Freedom and protected instructions are intact.

An unexplained observation gap between 09:34:40 and 17:27:21 UTC is recorded as
unrecorded time, without claiming active work or attributing its cause. The
original deployment clock remains unchanged. Deletion readiness and SHIPPED
remain pending the final archive, reviewed records follow-up and native READY
result. No branch or devbox deletion is authorized or performed.

### Qualified production closure

The untouched workflow-migration entrypoint subsequently passed all45 checks
with the exact original release environment, including fixture cleanup. See
[its verification](workflow-migration-verification.json). The semantic
entrypoint ran and correctly refused at the failed Fly prerequisite, exit2;
no semantic workflow was dispatched and no PASS is claimed. The controlling
deploy-failure policy permits a separately attributed, successfully delivered
post-merge repair to continue independently. The native failure report records
Fly and its semantic dependency as delegated/waived, preserving the original
FAIL/BLOCKED and refusal evidence. This release does not wait for that repair
and does not claim all production lanes passed. See the cumulative
[failure report](failure-report.json) and existing repair thread linked there.

The records-only follow-up is [PR #2413](https://github.com/Rose-Ai-Labs/rose/pull/2413).
Native independent classification accepted zero actual approval-scoped hunks
in the documentation filename guard hit. Existing CodeRabbit filters exclude
the records; the native no-reviewable-paths disposition spent no review.
Final private preservation and native deletion readiness remain pending.
