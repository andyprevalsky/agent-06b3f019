---
id: 2026-08-03-deploy-cleanup-denylist-terminated-generation-scoped-prod-queues
date: 2026-08-03
title: A developer's /deploy cleanup terminated 16 live production agent workflows because its prod guard predated generation-scoped queues
surface: back-end
component: cleanup-stale-workspaces
classification: our-bug
problem_class: other
first_bad_boundary: back-end/scripts/cleanup-stale-workspaces.ts — the terminate/keep decision was a destructive-by-default deny-list whose prod guard was exact-equality on `navi-agent-tasks`, so the generation-scoped prod queue `navi-agent-tasks@<surfaceHash>` fell through to "Stale or unknown — terminate"
symptoms:
  - "Deploy cleanup: stale workspace workflow"
  - "EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED"
  - "agent stuck ACTIVE / Processing after wait_for deadline passes"
  - "navi-agent-tasks@ebdc7ba275e9"
  - "scheduled message never sent, worker logs stop and never resume"
tags:
  - temporal
  - task-queue
  - deploy
  - worker-generation
  - wait-for
  - prod-incident
  - deny-list
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
  - commit 510c8c66e
repro: back-end/src/tests/unit/cleanup-stale-workspaces.test.ts
status: fixed
---

## Problem

Production agent `e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc` was asked to schedule an
SMS/iMessage to a contact for 2026-08-03 10:00 America/Los_Angeles. It resolved
the recipient, told the user "your message is scheduled to send Monday, August 3,
2026, 10:00 AM Pacific time", and parked in `wait_for` until
`2026-08-03T17:00:00Z`. The message never sent, and the agent was still
`status: ACTIVE / status_message: Processing` ~22h later.

Runtime evidence:

- `temporal workflow describe -w e14d5abb-...` →
  `EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED` at `2026-08-03T16:03:50Z`, reason
  `"Deploy cleanup: stale workspace workflow"`, identity
  `48382@Andys-MacBook-Pro-2.local`, task queue `navi-agent-tasks@ebdc7ba275e9`.
  The workflow was killed **57 minutes before** its own timer was due to fire.
- ClickHouse `observability.fly_logs` for this agent: 1545 rows, all between
  04:18:14 and 04:22:49 — nothing afterwards, the signature of a workflow that
  slept and was then terminated rather than one that crashed.
- Tallying the termination reason of all 52 terminated workflows on that one prod
  generation queue: **16 × "Deploy cleanup: stale workspace workflow"**, all from
  `Andys-MacBook-Pro-2.local`. The rest were legitimate (`Agent deleted by user`
  from Render hosts, `Restarting with new worker code`, `Agent killed via SMS`).

So this was not a one-off: a laptop running `/deploy` mass-killed live production
agents, and 18 Running prod workflows were still exposed at diagnosis time.

Those 16 kills map to 16 distinct production agents. Their DB lifecycle state a
day later: **3 ACTIVE** (durably stuck, including this one), 5 PAUSED, 8
COST_LIMIT_REACHED. **Not one is in a failed/terminal state** — nothing in the
product records that these agents were killed, which is why the incident was
invisible until a user noticed an unsent message.

## Diagnosis

Only one place in the repo emits that reason string:
`back-end/scripts/cleanup-stale-workspaces.ts`, invoked by `/deploy` Step 11a
(`.claude/commands/deploy.md`). Its loop was a **deny-list**:

```ts
if (queue === PROD_QUEUE) { skipped++; continue; }            // 'navi-agent-tasks'
if (isIsolatedBenchmarkResource(queue)) { skipped++; continue; }
if (queue.startsWith(QUEUE_PREFIX)) { ... }                   // 'navi-agent-tasks-'
// Stale or unknown — terminate
```

Commit `510c8c66e` (2026-07-25, "zero-downtime, self-driving agent cutover via
generation queues") moved production workers onto generation-scoped queues:
`agents/helpers/worker_generation.py:resolve_production_task_queue()` returns
`navi-agent-tasks@<surfaceHash>`. That name matches **neither** guard — the
character after the base name is `@`, not `-` — so every live production agent
workflow fell straight through to the unconditional terminate branch.
`cleanup-stale-workspaces.ts` was last modified 2026-07-14, eleven days before
generation queues existed, and was never updated.

Step 5a ladder to the deepest owned cause:

1. *Why did the agent never send?* Its workflow was terminated mid-`wait_for`.
2. *Why was it terminated?* Cleanup classified `navi-agent-tasks@ebdc7ba275e9`
   as stale.
3. *Why did it classify a prod queue as stale?* The prod guard was exact-equality
   against a hardcoded literal, and "the production queue name" is now derived in
   Python with no contract shared with this TypeScript consumer.
4. *Why was that able to become destructive silently?* Because the default was
   **terminate**. The file's own header stated the intent: *"Unknown queues (no
   matching workspace) are treated as stale and terminated."* A fail-open
   destructive default converts every future naming change into a production
   kill-switch. This is the deepest owned cause, and it is what the fix targets.

Supporting evidence for rung 4: the decision was inlined in an async loop with no
exported function, so no test could assert the safety invariant. The existing
`cleanup-stale-workspaces.test.ts` covered only `resolveActiveWorkspaces`.

`problem_class` is deliberately `other`. The Step 5 bucket table is scoped to
benchmark failures, and "logical inconsistency in harness contracts" requires a
conflicting prompt/schema/evaluator — nothing here disagreed with anything. The
missing bucket this case argues for is **destructive-default classification in a
tool whose blast radius spans environments**: a local developer tool that
enumerates and destroys resources in a namespace shared with production, and
defaults to destroy on non-match. Naming it that way is what makes the sibling
defects (process kills, container stops) obviously in scope.

## Solution

Inverted the deny-list to an **allow-list** keyed on positive attribution.
`resolveActiveWorkspaces` now reads every workspace row with its `state` and
returns `archivedResourceNames` / `archivedDirectoryNames`; an identity claimed by
any *active* workspace is stripped from the archived sets so it can never be a
target. The single terminate/keep decision, exported as
`archivedWorkspaceForQueue(queue, workspaces)`, terminates only when the queue's
identity segment matches an archived identity **exactly**, after stripping only
decorations we explicitly model (`@<generationHash>`,
`-deploy-<utcTimestamp>-<pid>`). Everything else is kept.

The first version of this fix was **not** sufficient, and an adversarial review
caught it: it still treated "whatever follows `navi-agent-tasks-`" as a workspace
name, so it would have terminated `navi-agent-tasks-<active-ws>-deploy-<ts>-<pid>`
(an in-flight deploy lane of an *active* workspace — one was running at review
time) and `navi-agent-tasks-test` (326 running workflows). That is the same
failure shape as the incident, one decoration deeper. Exact-identity matching is
what actually kills the class; prefix-and-subtract does not.

Two further real hazards surfaced while probing the fix against live data:

- An archived workspace carries the **secondary alias `test`**, which collides
  with the shared e2e queue `navi-agent-tasks-test` (the agents' default
  `TEMPORAL_TASK_QUEUE`). Shared infrastructure queues are now an explicit
  `RESERVED_QUEUES` set that is never workspace-attributable.
- `assertNotProduction()` now aborts the entire run if a queue whose base is
  `navi-agent-tasks` ever reaches the terminate path, and `--dry-run` prints
  targets without destroying anything. The incident happened with zero friction
  and zero preview.

The same allow-list rule was applied to the sibling destructive defaults in this
file: `killOrphanedProcesses` and the `victoria-db-*` container loop previously
destroyed anything *not* recognized as active, so an unregistered or brand-new
worktree was indistinguishable from an abandoned one. Both now require a known
archived workspace.

Verified against live production state after the fix, over every task queue with
a Running workflow: prod (`navi-agent-tasks@0b52639dcf8b`, 18 running) kept,
active workspaces' deploy lanes kept, benchmark queues kept,
`navi-agent-tasks-test` kept, `navi-worker-deployment-markers` kept — and the one
remaining target is an archived workspace's leaked deploy lane, which is exactly
the script's job.

10k-agent behavior: strictly better. The change removes an O(all running
workflows) destructive action and does no extra per-workflow work — one prefix
test, a few bounded string strips, and set lookups. Nothing scales with agent
count.

Three adjacent defects were found and fixed in the same pass:

- `scripts/rca_archive.py` never dispatched its `new` subcommand — it fell
  through to `return 2`, so the Step 8 case-file scaffold mandated by `/RCA` had
  always been a silent no-op. Now wired to `new_case()`.
- `back-end/scripts/run-unit-tests.ts` would run backend unit tests — which
  create and delete real `Agent`/`Message` rows — against whatever `DATABASE_URL`
  resolved to, and `back-end/.env` points at the **production** Supabase pooler.
  A bare run therefore wrote to prod and blew Prisma's 10s interactive-transaction
  budget on network latency, manufacturing a convincing fake failure that nearly
  derailed this RCA. The runner now refuses any non-local database host.

### Reproduction, stated honestly

The buggy revision could not run this test as written: the injectable
`terminateStaleWorkflowsWithClient` seam did not exist there. The pre-fix failure
was recorded on a **reconstructed** revision — the seam added, the original
classifier untouched — then the classifier was changed. The seam is pure test
scaffolding: the fake drives the real loop and the real decision function, and
the assertion is on the actual terminated workflow ids.

```
# pre-fix (seam added, original classifier)
❌ never terminates a generation-scoped production queue
   AssertionError: production workflows must never be terminated by cleanup
   actual ['prod-generation'] / expected []

# post-fix, assertions unchanged
✅ 11/11 in cleanup-stale-workspaces.test.ts
```

`back-end/scripts/run-unit-tests.ts` auto-discovers every `*.test.ts` under
`src/tests/unit/`, and `scripts/run-coverage.sh` runs it, which `/deploy` gates
on — so this regression is permanently covered. A unit test (not a blackbox
test) is the correct home because the owning boundary is a standalone deploy
script with no HTTP surface.

### Not proven

The counterfactual "the message would have sent at 17:00Z" is strongly supported
but not proven: the current prod generation is `@0b52639dcf8b` and every Fly
machine reports a cutover *after* the deadline, so `@ebdc7ba275e9` was very
likely still being polled at 17:00Z — but `temporal task-queue describe` on that
queue now shows zero pollers, so poller count at 17:00Z is unrecoverable. The
termination is proven; the send is inferred.

Still open from this agent's trajectory, filed separately from this cause:
the `Agent` row stayed `ACTIVE` for 22h after Temporal reached a terminal state —
there is no reverse reconciliation from Temporal-terminal to DB-terminal. That
gap is why this incident was silent for a day, and it deserves its own RCA.

## Human feedback

None recorded.

## Reusable lesson

A cleanup that decides what to destroy must be an allow-list over resources it
can positively attribute — never a deny-list with "unknown means stale", because
the first naming change downstream silently turns it into a production
kill-switch.
