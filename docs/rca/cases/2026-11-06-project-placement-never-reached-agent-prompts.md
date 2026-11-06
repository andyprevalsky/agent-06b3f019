---
id: 2026-11-06-project-placement-never-reached-agent-prompts
date: 2026-11-06
title: A project agent never saw its project or synced GitHub repo, so the root hunted for the repo URL it already had
surface: cross
component: agent-system-prompt-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/fetch_config.py fetch_agent_config dropped the agent's project placement (the backend detail returned only project_id), so no router, main-loop or planner prompt named the project, its repo or default branch
symptoms:
  - "a specific repository I don't have context for"
  - "Since I don't know the exact repo URL or location, the agent may need to clarify or search for it first."
  - "Identify the canonical repository the user Andy Prevalsky means by 'our rose repo.'"
  - code agent spawned with a redundant github_repo_link in a project
  - "If omitted, the GitHub repo defaults to a repo automatically created for this agent tree."
tags:
  - projects
  - code-agents
  - system-prompt
  - planner
  - chat-router
  - github
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82 (root in project "Rose", Rose-Ai-Labs/rose, 2026-11-06 04:13Z)
  - commit 79b959aca2 (main at diagnosis)
repro: agents/tests/blackbox/prompt_invariants.blackbox.py "project_context_lands_once_in_the_dynamic_user_context_block"
status: fixed
---

## Problem

Andy (verification item V2): "the root agent doesn't seem to understand the
context that it has a gh repo synced to it (where each code agent it spawns is
within this repo)." Root 1a3d495c sat in project "Rose" (repo
`https://github.com/Rose-Ai-Labs/rose`, default branch `main`) and was asked
"Whats our rose repo loooking like?". The chat router replied that it was "a
specific repository I don't have context for"; the plan_loop and planner
(prod ClickHouse dumps 04:13:08Z and 04:13:12Z) planned an explore task to
identify the repo, the explore agent grepped Gmail/iMessage/web, a browser
agent was sent to GitHub, and only after Andy's correction was a code agent
spawned, with a redundant `github_repo_link`.

## Diagnosis

`GET /api/agents/:id` returned `project_id` only
(`back-end/src/domains/agents/agentQueryService.ts`), and
`agents/helpers/fetch_config.py` dropped even that; nothing under `agents/`
read the project. The main loop's block 1 (`# User Context`,
`get_user_context`) and the planner (`set_plan` handler →
`build_planner_system_prompt`) therefore carried no project, and the chat
router sent only its static prompt and the messages
(`back-end/src/providers/chat/routerLlm.ts`). The static tool text was also
false for project agents: `github_repo_link` said an omitted repo "defaults to a
repo automatically created for this agent tree", and the stock spawn_agent code
line said results sync to "a GitHub repo initialized to this agent network",
while the backend project restore owns the checkout and ignores
`github_repo_link` (`back-end/src/domains/claude-code/service.ts`
createSession). Possible because project placement was added for the sidebar
and code-session restore only; the agent-prompt contract was never extended to
it (Step 5a stop: the placement data is correct and indexed, only its consumer
was missing).

Local replay of the exact prod dumps through `RoseClient` (Claude lease
unavailable without a local backend, so the waterfall served the calls):
planner before (`openai/gpt-6.1-sol`, pool rose-1-ultra) planned
`spawn_explore_agent` "Identify the canonical repository the user ... means by
'our rose repo'" plus browser follow-ups. With the project section and fixed
tool text (same dump otherwise), the planner's first task was
`spawn_code_agent` "Inspect the existing checkout of the user's Rose project,
GitHub repository Rose-Ai-Labs/rose, default branch main", no
`github_repo_link`, and its other tasks were told not to search for the repo.
The plan_loop on its waterfall model (`qwen/qwen3.8-27b`, pool rose-1-flash)
still spawned an explore repo search in all three variants; its history keeps
the unfixed router's "I don't know the exact repo URL ... search for it first"
message. Prod served that call with `claude-opus-5-5`, which was not replayed.

## Solution

- Backend: `findAgentWithRelations` selects the project `{name, repoUrl,
  defaultBranch}` (one PK join on the indexed FK) and the agent detail returns
  `project: {name, repo_url, default_branch} | null`; sub-agents inherit
  placement, so they get it too.
- Worker: `fetch_agent_config` passes `project`; the workflow derives
  `project_context_section` via `render_project_context` on every start, keeps
  it apart from the per-user `user_context_section`, and carries it across
  continue-as-new (a failed config fetch keeps it; Home drops it).
  `user_context_with_project` leads block 1 with `## Project` for the PLAN /
  EXECUTE main loop and the planner; block 0, the tools and later blocks are
  byte-identical, and a Home agent's prompts are unchanged.
- Static text: `github_repo_link` and the stock code line now say the current
  project's repo is used, otherwise a repo created for this agent tree.
- Chat router: one PK read per chat turn (`loadRouterProjectContext`) appends the
  project after the router prompt's cache boundary (`markCacheable` dynamic
  suffix, still one system message).

10k agents: one extra PK join per agent detail read and one PK read per chat
turn; no new channel, subscription, shared row or per-tree fan-in; prompt size
grows by about 60 tokens only for project agents.

## Human feedback

None recorded.

## Reusable lesson

When a placement or ownership fact changes what an agent's tools will do (such as which repo a code agent starts in), render it in that agent's dynamic prompt context and keep static tool descriptions true for every placement.
