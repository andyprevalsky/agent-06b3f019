---
id: 2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id
date: 2026-08-19
title: Explore agents fire three unordered FE posts at one toolCallId, so a raw exception blob replaces the tool's formatted chip
surface: agents
component: spawn-agent-explore
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py:1679 — post_tool_error_message writes a third row under the failing tool's toolCallId, overwriting the formatted ERROR chip the tool manager already posted at that same identity
symptoms:
  - "WebFetchProvidersFailed: web_fetch cannot fetch"
  - explore step shows toolName spawn_agent with title "web_fetch failed"
  - raw exception string rendered as an explore step instead of the formatted "Web fetch failed for <url>" chip
  - web_fetch chip missing entirely from the explore step list
  - persisted TOOL rows for one toolCallId arrive out of order (ERROR before IN_PROGRESS)
tags:
  - explore-agent
  - spawn-agent
  - tool-chip
  - frontend-dedup
  - web-fetch
  - race
sources:
  - agent a6b8593a-bd41-4a18-8eca-667cbf0020ba
repro: front-end/src/tests/blackbox/explore-chip-clobber.blackbox.ts + agents/tests/blackbox/run_agent.blackbox.py::test_failed_tool_posts_no_duplicate_chip_but_still_reaches_context + agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_fe_posts_are_ordered_within_one_tool_call
status: fixed
---

## Problem

Prod agent `a6b8593a-bd41-4a18-8eca-667cbf0020ba` (goal "Get me into Stanford",
source MAC_APP) spawned an explore child, task
`e8e68b97-359f-4bc7-8fe4-aa57c23c6fbf`. The user saw a raw exception blob as one
of the explore agent's intermediary steps:

```
WebFetchProvidersFailed: web_fetch cannot fetch 'documents/generic/User snapshot
V1 bootstrap/user-snapshot-v1-bootstrap': scheme '(none)' is not fetchable — ...
```

The failure itself was benign and correctly guarded: `assert_fetchable_url`
(`agents/domains/web_fetch/service.py:93`) rejected the string before any paid
provider call, the explore agent recovered on the next iteration, and at
19:14:30.606 it returned a full research summary. So the error is a *step*, not
the outcome — but it renders as though the sub-agent itself failed.

Persisted TOOL rows for that task (prod API, `timestamp | toolName | toolStatus |
toolCallId | title`):

```
19:13:50.959 | web_fetch   | ERROR       | 10a6cbd0-… | "❌ Web fetch failed for documents/… for Find background info…"
19:13:50.982 | web_fetch   | IN_PROGRESS | 10a6cbd0-… | "Fetching documents/…"
19:13:51.236 | spawn_agent | ERROR       | 10a6cbd0-… | "web_fetch failed"   ← text = the raw exception
19:14:30.606 | spawn_agent | FINISHED    | toolu_01L… | <goal>               ← text = the research summary
```

Three rows share one `toolCallId`, and IN_PROGRESS is persisted 23ms *after* the
ERROR that logically follows it.

## Diagnosis

`WebFetchManager` already posts a complete ERROR chip and then re-raises
(`agents/domains/web_fetch/handler.py:319-332`): title
`"❌ Web fetch failed for <url> for <objective>"`, body `format_error_message(...)`
with the params, elapsed time and cost. `agents/loop/run_agent.py:1679` then
posts a *second* error row for the same `toolCallId` carrying bare `str(error)`.
On the explore path that row is funnelled through
`agents/domains/spawn_agent/service.py:563` `explore_post_message`, which
re-projects the metadata onto seven hardcoded keys in
`agents/domains/spawn_agent/repo.py:49-57` — dropping the caller's
`toolName: "web_fetch"` and stamping `toolName: "spawn_agent"`.

The frontend resolves chip identity by `toolCallId`, last arrival wins
(`front-end/src/features/terminal-component-group/hooks/deduplicateToolMessages.ts`
`dedupByToolCallId`). The mislabelled row arrives last, so it **deletes both
web_fetch rows**. Verified against the captured transcript: the rendered explore
step list contains zero `web_fetch` steps and one `spawn_agent`/ERROR step whose
body is the raw exception.

Step 5a ladder:

1. The user saw a raw exception attributed to the sub-agent — because the only
   surviving row for `10a6cbd0` is labelled `spawn_agent`.
2. It is labelled `spawn_agent` — because `save_explore_message` rebuilds
   metadata from a fixed key set and hardcodes `toolName` (`repo.py:51`), a lossy
   re-projection of what `run_agent` sent.
3. That row exists at all — because `run_agent.py:1679` posts a generic tool
   error under the tool's own `toolCallId`, at an identity a better record
   already occupies. *Evidence: `handler.py:319` posted the formatted chip 277ms
   earlier under the same id.*
4. The write is destructive rather than merely redundant — because
   `agents/domains/spawn_agent/service.py:395-410` `tagged_execute_activity`
   turns every explore FE post into `asyncio.create_task(...)` and returns
   `None`, so `await handle_tool_event(...)` awaits *scheduling*, not delivery.
   N concurrent unordered writes land on one last-arrival-wins identity.
   *Evidence: prod persisted ERROR at .959 before IN_PROGRESS at .982 — a real
   23ms inversion of program order.*

Rung 4 is the deepest owned cause: **unordered fire-and-forget writes into a
single last-arrival-wins chip identity**. Rung 2 is a second, independent defect
layered on top.

Two fixes were tested and individually *disproved* by replaying the captured
transcript through `deduplicateToolMessages`:

* Relabel only (rung 2): the surviving step becomes `web_fetch` but still carries
  title `"web_fetch failed"` and the raw exception body — the user-visible output
  is unchanged.
* Delete the duplicate only (rung 3): the surviving row becomes the
  **IN_PROGRESS** one, leaving a permanently spinning "Fetching documents/…"
  step. `cleanOrphanedInProgress` exempts `agentType === 'explore'`, so nothing
  reaps it.

Neither is sufficient alone; ordering must be fixed with single-writer ownership.

Scope check (verified, narrower than first assumed): `run_agent.py:1679` is
gated on `is_inside_temporal_activity`, and the only production caller passing it
is the explore path (`spawn_agent/service.py:630`). Non-explore agents do not hit
this. All four explore tools (`web_fetch`, `grep`, `web_search`, `people_search`)
post their own formatted terminal ERROR chip and then re-raise, so `run_agent`'s
row was redundant for every one of them and deleting it blinds nothing. Sibling
on the success path: manager IN_PROGRESS + FINISHED are also fire-and-forget, so
a lost race leaves an unreapable spinning explore step — which is why the
ordering fix is required, not optional.

## Solution

Three changes, all delete/unify rather than guard:

1. **`agents/loop/run_agent.py`** — removed the duplicate FE error post. Every
   tool already posts a formatted terminal ERROR chip and re-raises
   (`domains/web_fetch/handler.py:319`, `domains/grep/service.py:317`,
   `tools/web_search/handler.py:180`, `tools/people_search/handler.py:177`), so
   this row was never extra visibility — only a clobber. The model's error
   feedback is the local `context.append`, which is untouched (explore runs with
   `poll_messages=None`, so that append is and always was the real channel).
2. **`agents/domains/spawn_agent/service.py`** — `_dispatch_fe_post` chains
   backgrounded FE posts per `toolCallId`. Different chips stay fully
   concurrent (the reason backgrounding exists); one chip's own posts can no
   longer be observed inverted. Both writers — `tagged_execute_activity` and
   `explore_post_message` — go through it, and `_drain_pending_fe_posts` clears
   chain tails so completed tasks are not retained for the activity's life.
3. **`agents/domains/spawn_agent/repo.py`** — `save_explore_message` carries the
   caller's `tool_name` through instead of stamping every message
   `spawn_agent`, defaulting only for genuine lifecycle messages. `toolStatus`
   is deliberately still recomputed as ERROR/FINISHED: if explore rows could
   carry IN_PROGRESS, a lost terminal write would strand a spinner forever,
   because `cleanOrphanedInProgress` exempts `agentType === 'explore'`.

Defence in depth in the frontend, so no single writer can destroy a chip:
**`deduplicateToolMessages.ts`** now identifies a chip by `toolCallId` *and*
`toolName`, and never lets a non-terminal row replace a terminal one. This is
what makes the unmodified prod transcript render correctly, and it also contains
the sibling below.

**Known sibling, deliberately not changed:** `workflows/agent_workflow.py:2620`
posts the same shape of duplicate error row on the MAIN agent path (also
`:2396`, `:2416`). It is code-proven, not transcript-proven — no main-path prod
capture was pulled — and its `error_metadata` carries `subAgentIds`/`busId`/
`spawnGroupId` that the sub-agent tree depends on (the "for_each tree vanish" /
"Spawning… relic" class). Deleting it blind risked a worse regression than the
one being fixed, so the FE guard contains it and the delete is left for a change
that can capture a main-path transcript first.

Rejected: adding a terminal ERROR chip to the `ToolManager` base. All four
explore tools already own one, so a base chip would double-post — and because a
base `except` runs after the handler's, the generic chip would land last and
recreate this exact bug across 13 handlers.

Verification (identical commands both sides):

    cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py run_agent
      pre-fix:  FAIL failed_tool_posts_no_duplicate_chip — run_agent posted a duplicate
                ERROR chip for a failed tool ... toolCallId 10a6cbd0-...
      post-fix: PASS
    cd agents && python scripts/run_blackbox_tests.py spawn_agent
      pre-fix:  FAIL explore_fe_posts_ordered_per_chip — delivered ['chip-1:ERROR',
                'chip-1:IN_PROGRESS'] (the same inversion prod persisted)
      pre-fix:  FAIL explore_tool_error_keeps_tool_name — relabelled as 'spawn_agent'
      post-fix: PASS
    cd front-end && npx vitest run src/tests/blackbox/explore-chip-clobber.blackbox.ts
      pre-fix:  FAIL expected [] to have a length of 1 (web_fetch chip deleted)
      post-fix: PASS

    full suites: agents 91/91 domains, front-end 117 files / 2251 tests.

The FE fixture is the UNMODIFIED prod transcript — the test cannot pass by
agreeing with hand-edited data.

10k-agent behavior: a failed explore tool call now costs 2 DB rows + 2
broadcasts instead of 3 — a reduction on the hottest failure path. The post
chain is closure-scoped per activity (no cross-agent shared state, no per-user
fan-in) and serializes only within one chip, so nothing serializes across
agents or leaves.

## Human feedback

The user approved the fix conditional on cross-verification passing ("cross
verify and if it passes then yes it is approved"), and asked for the change in
one line before approving — keep the summary of a fix to its essence.

Adversarial cross-verification changed the fix twice and both corrections
mattered:

1. The first proposed fix (relabel `toolName` only) was disproved by replaying
   the captured transcript: the user still saw the identical raw blob, just
   labelled `web_fetch`. Deleting the duplicate write alone was also disproved —
   it left an IN_PROGRESS spinner. Neither is sufficient without the ordering
   fix.
2. A claim that `grep`/`web_search`/`people_search` post no ERROR chip (which
   would have made the delete unsafe and forced a `ToolManager` base chip) was
   wrong; all four explore tools own one. The base-class approach was dropped as
   a result — it would have recreated this bug across 13 handlers.

## Reusable lesson

When two code paths post to the same `toolCallId`, the later write silently
deletes the earlier one — give each chip exactly one writer and a guaranteed
order, never two writers racing on arrival time.
