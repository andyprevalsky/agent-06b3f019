<!-- Extracted from CLAUDE.md by /generate-claude-md. Source of truth for this topic. -->

# LLM Call Map

Every LLM call in the agent pipeline, ordered by execution flow. Pools, route order and budgets: `docs/internal/rose-completions.md` (registry `agents/providers/rose/pools.py`).

## Agent Pipeline (agents/, runs inside Temporal)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| A1 | **Main Loop (PLAN)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES | no | `build_system_prompt` (2k) + user_context (200-15k) + 4 PLAN tool schemas (500t) + conversation + blueprints | 3-20k |
| A2 | **Planner LLM** `helpers/llm.py:call_planner_llm_activity` | agent.model | YES | no | `build_planner_system_prompt` (3k) + user_context + conversation; prompt-cached, planner memory appended at the end | 5-15k |
| A3 | **Verifier (PLAN)** `helpers/llm.py:check_progress` | agent.model | YES | no | `build_verifier_prompt` (500t) + full conversation (USER+TOOL only, no SYSTEM/ASSISTANT) | 3-40k |
| A4 | **Main Loop (EXECUTE)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES | no | `build_system_prompt` (2k) + user_context (200-15k) + 6 EXECUTE tool schemas (800t) + full conversation + DAG results | 5-80k |
| A5 | **Verifier (EXECUTE)** `helpers/llm.py:check_progress` | agent.model | YES | no | Same as A3 but with execute-phase conversation | 5-80k |

## Sub-Agent LLM Calls (spawned from EXECUTE phase)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| S1 | **Explore Agent** `tools/spawn_agent.py` → `run_agent` | rose-1-flash | **NO** | no | `EXPLORE_AGENT_SYSTEM_PROMPT` (300t) + **network_metadata (2k contacts, 5-15k t)** + local_data_summary + 4 tools (web_search, web_fetch, grep, attempt_completion) | 2-25k |
| S2 | **Browser Agent** `domains/spawn_browser_agent_v3/handler.py` → `BrowserStreamingRoseClient` | agent.model | YES | no | `build_browser_use_system_prompt` (`providers/rose/browser_use.py`, 400t) + step history + screenshots (multimodal, heavy) | 5-30k |
| S3 | **Sub-Agent** spawns full workflow (A1-A5 repeat) | parent.model | YES | no | Inherits parent user_context (gatable via context_gates) + own conversation | recursive |

## Tool-Level LLM Calls (inside activities)

| # | Call Site | Model | claudeAuth | Forces Ultra | Context Composition | Est. Tokens |
|---|-----------|-------|------------|-------------|---------------------|-------------|
| T1 | **message_person** `domains/message_person/repo.py` → `call_llm` | agent.model | YES | no | system prompt with conversation history + person thread + user message | 1-5k |

## claudeAuth Flow
- User's Claude OAuth token fetched at workflow start (`fetch_claude_max_token_activity`)
- Passed to Rose completions endpoint as `claude_token` param
- Rose routes directly to Anthropic API, skipping racing ($0 cost to Rose)
- Detected in response: `actual_model` ending with `-claude` suffix (e.g. `claude-sonnet-4-6-claude`)
- Refreshed before EXECUTE phase in case it expired during PLAN

## Context Gates per LLM Call

Each LLM call site, the context chunks it receives, and which `context_gates` key controls each chunk.

**Gate keys:** `user_profile`, `authenticated_sessions`, `integrations`, `recent_communications`, `network`, `custom_system_prompt`, `shared_files`

| LLM Call | Context Chunk | Gate Key | Est. Tokens | Notes |
|----------|--------------|----------|-------------|-------|
| **A1/A4 Main Loop** | user profile (name, phone, address) | `user_profile` | 50-100 | Via `get_user_context` → `build_system_prompt` |
| | authenticated browser sessions | `authenticated_sessions` | 20-50 | |
| | connected integrations (Gmail) | `integrations` | 20-30 | |
| | 200 recent messages (24h) | `recent_communications` | 2-10k | **Heaviest chunk** |
| | 2000 contacts network | `network` | 5-15k | **Heaviest chunk** |
| | custom system prompt | `custom_system_prompt` | 0-500 | User personality injection |
| | file attachment resolution | `shared_files` | variable | Base64 images, text files |
| | system prompt (identity, phase, tools, rules) | *always on* | 2-3k | `build_system_prompt` |
| | conversation history | *always on* | 1-50k | Grows per iteration |
| | blueprints | *always on* | 0-2k | Iteration 1 only |
| **A2 Planner** | user_context (pre-gated) | *inherits parent gates* | 0-15k | Same gates as A1 |
| | planner system prompt | *always on* | 3k | `build_planner_system_prompt` |
| | conversation history | *always on* | 1-10k | |
| **A3/A5 Verifier** | verifier system prompt | *always on* | 500 | `build_verifier_prompt` |
| | full conversation (USER+TOOL) | *always on* | 3-80k | No gates, no truncation |
| **S1 Explore** | 500-contact network metadata | `network` | 5-15k | Via `fetch_full_network_metadata` |
| | local message thread summary | `recent_communications` | 0-2k | Via `fetch_local_data_summary` |
| | explore system prompt | *always on* | 300 | `EXPLORE_AGENT_SYSTEM_PROMPT` |
| | 4 tool schemas | *always on* | 400 | web_search, web_fetch, grep, attempt_completion |
| **S2 Browser** | browser system prompt | *always on* | 400 | `build_browser_use_system_prompt` |
| | step history + screenshots | *always on* | 5-30k | No user context, no gates |
| **S3 Sub-Agent** | *all chunks from A1* | *inherits parent gates* | recursive | Gates set by parent's `spawn_agent` call |
| **T1 message_person** | cross-contact voice sample | `recent_communications` | 1-5k | `fetch_recent_messages_activity` |
| | 1-on-1 thread with person | *always on* | 0-3k | Always needed for context |
| | Exa person enrichment | *always on* | 0-1k | Always needed for personalization |

## Remaining Waste (not gatable)
1. **A3/A5 Verifier** - Gets full conversation with no truncation. On long runs (20+ iterations) this balloons to 40-80k. Not yet gated.
