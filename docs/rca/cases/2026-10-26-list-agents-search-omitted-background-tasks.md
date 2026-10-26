---
id: 2026-10-26-list-agents-search-omitted-background-tasks
date: 2026-10-26
title: list_agents path_prefix/query search returned "No agents match" for an existing browser task the node view lists
surface: back-end
component: agent-tree-view
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentTreeService.ts searchMatches searched Agent rows only (repoAgentTree.searchTreeByGoal), never the background tasks that getAgentTreeView's node view lists via backgroundTaskNodes
symptoms:
  - "No agents in this tree match under /root/retrieve_member_number."
  - "Completion rejected: no evidence tool has succeeded yet. Call web_search, people_search, web_fetch, or grep successfully before completing."
  - "Declared evaluator assistance-declined-runtime failed: Observed tool failure: attempt_completion_with_result 813c3e77 status=ERROR"
  - "Reached max iterations (5)" after an explore spent its turns on list_agents navigation
  - list_agents(path_prefix=<browser/explore/code task path>) or list_agents(query=<task goal words>) lists no match although list_agents(node=<owner>) shows the task
tags:
  - list-agents
  - agent-tree
  - background-tasks
  - explore
  - browser-auth-assistance-declined
sources:
  - agent b8a40ee9-bf0d-482c-b39e-c85dde479c9d (root), explore 90bcc9f4-e0a1-4c43-af5e-233efa88d052 (/root/check_existing_evidence)
  - fleet run 20261026-044408-21827 shard-01 r001-j0026 on ae2f7366c (/var/tmp/f8x/context/fleet/runs/20261026-044408-21827/browser-auth-assistance-declined/run.json, root messages 64-81)
repro: back-end/src/tests/blackbox/agents-agent-address.cases.ts "GET /:id/tree — paths, path nodes and background tasks (running and finished) of listed agents" and "GET /:id/tree — search filters tasks before the per-owner cap and finds tasks of unloaded owners"
status: fixed
---

## Problem

browser-auth-assistance-declined (r001-j0026, 1 of 2 copies) failed its
`assistance-declined-runtime` evaluator with `Observed tool failure:
attempt_completion_with_result 813c3e77-… status=ERROR`. The root spawned the
explore `/root/check_existing_evidence` to read the completed browser task
`/root/retrieve_member_number`. The explore's first call,
`list_agents(path_prefix="/root/retrieve_member_number")`, answered
`No agents in this tree match under /root/retrieve_member_number.` (message 68).
`list_agents(node="/root", query="member number")` matched only /root (71). Only
`list_agents(node="/root")` showed the task, `[task of your parent] browser
completed` (74). By then the explore had used its turns. On its last turn it
called `attempt_completion_with_result` while admitting it had "not actually read
the trajectory messages" (75). The evidence guard rejected that truthfully
(ERROR card, 76). grep then ran, and the explore hit max iterations (5) and FAILED.

## Diagnosis

The evidence guard (`agents/domains/spawn_agent/service.py`
`_NON_EVIDENCE_EXPLORE_TOOLS`, bb6cf254f) is consistent with the contract. The
`list_agents` prompt (`agents/tools/prompts/list_agents.py`) calls it a table of
contents and says to read an agent's work with grep agent_network. The explore
itself confirmed it had read no evidence. Counting the listing as evidence would
have accepted an unsupported answer. The guard is not the first bad step.

The first bad output is message 68. `getAgentTreeView` has two modes. The node
view lists agent rows plus each listed owner's `Agent.backgroundTasks` entries
(`backgroundTaskNodes`). The search mode (`q` / `path_prefix`) called only
`repo.searchTreeByGoal`, a Prisma query over Agent rows. Browser, explore and
code tasks live in the owner's backgroundTasks JSON, not as Agent rows, so search
could never return them. The tool advertises `path_prefix` as "list one subtree",
but search covered a smaller set than browsing the same subtree. The existing
blackbox assertion even recorded that buggy set: `path_prefix=/root/outreach`
returned 4 agents and omitted `/root/outreach/scan` and `/root/outreach/old`.

Problem class: a listing tool's filtered mode covers a different item set than
its unfiltered mode. This is the same family as the 2026-10-23 node=<task>
error, but a different code path.

## Solution

`searchMatches` now also matches background tasks.
`repoAgentTree.searchTreeTaskOwners` runs a busId-scoped, LIMITed query for
agents in the tree that own a `backgroundTasks` entry whose path is the prefix
or below it and whose goal contains every token. It uses the same scope and
limit as the agent-goal query, so query-only search finds tasks of owners that
the search would not otherwise load. `backgroundTaskNodes` applies the
search predicate to each owner's tasks BEFORE its 10-per-owner and 100-per-
response caps. Results are merged shallowest-first, agents first, and
truncated to `limit`. Each `TreeMatch` carries `type`, and the agents-side
renderer prints a task match as `[task of …] browser completed`.

First version (6b8962046) defect, found by the golden-reference review:
it filtered the already-capped `backgroundTaskNodes` output. An owner array
lists running tasks first, then finished tasks oldest-first, so with more than
10 tasks the newest finished one was cut before the filter ran.
`path_prefix` then reported "No agents in this tree match" again. That
version also searched only owners already loaded. The follow-up applies the
filter before the cap and finds owners through the tree query. Its regression
puts 12 tasks on one owner, and adds a task whose owner sits in another branch.

Golden reference: codex `codex/codex-rs/core/src/agent/control.rs:380-437`.
`list_agents` builds one registry list (`live_agents()`, :396) and applies
`path_prefix` as a filter over that same list (:432-437), so a prefix can never
hide an agent the unfiltered listing shows. This fix converges on that.

At 10k agents: at most one extra resolve (indexed path lookup) and one
primary-key read per search. The task scan only touches rows already loaded
(at most limit plus ancestors) and stays capped by backgroundTaskNodes (10 per
owner, 100 total). There is no new fan-in and no tree-wide scan.

Also fixed a pre-existing stale stub in
`agents/tests/blackbox/background_agents.blackbox.py`
(`parent_finish_stops_pending_agents`). ede5361f7 made `_mark_complete` re-read
`fetch_agent_config`, and the mock returned None for it.

## Human feedback

The parent's golden-reference reviewer rejected the first version: the filter ran after the cap, and query-only search had to match task text within the same busId-scoped query (filter first, then limit, as codex control.rs:380-437 and openclaw session-list-filters.ts do).

## Reusable lesson

A listing tool's filtered or search mode must cover the same item set its unfiltered view lists; filter that set, never query a narrower table.
